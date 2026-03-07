// ---------------------------
// Helper functions
// ---------------------------

function extractTarget(request) {
  const url = new URL(request.url)
  const raw = url.pathname.slice(1)
  if (!raw.startsWith("http://") && !raw.startsWith("https://")) return null
  const target = new URL(raw)
  target.search = url.search
  return target
}

function createProxyRequest(request, targetUrl) {
  const headers = new Headers(request.headers)
  headers.set("host", targetUrl.host)
  headers.set("origin", targetUrl.origin)
  headers.delete("cf-connecting-ip")
  headers.delete("cf-ipcountry")
  headers.delete("cf-ray")
  return new Request(targetUrl.toString(), {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual"
  })
}

function rewriteHeaders(headers) {
  const newHeaders = new Headers(headers)
  newHeaders.delete("content-security-policy")
  newHeaders.delete("content-security-policy-report-only")
  newHeaders.delete("x-frame-options")
  newHeaders.delete("strict-transport-security")
  return newHeaders
}

function proxifyUrl(workerOrigin, baseUrl, value) {
  try {
    const absolute = new URL(value, baseUrl).href
    return `${workerOrigin}/${absolute}`
  } catch {
    return value
  }
}

// ---------------------------
// HTMLRewriter for absolute URLs
// ---------------------------

class AttributeRewriter {
  constructor(workerOrigin, baseUrl) {
    this.workerOrigin = workerOrigin
    this.baseUrl = baseUrl
  }

  element(el) {
    const attrs = [
      "href", "src", "action", "srcset",
      "data-src", "data-original", "data-lazy",
      "data-srcset", "poster"
    ]

    for (const attr of attrs) {
      const val = el.getAttribute(attr)
      if (!val) continue

      if (attr === "srcset" || attr === "data-srcset") {
        const parts = val.split(",").map(part => {
          const [url, size] = part.trim().split(" ")
          try {
            const absolute = new URL(url, this.baseUrl).href
            return `${this.workerOrigin}/${absolute} ${size || ""}`.trim()
          } catch {
            return part
          }
        })
        el.setAttribute(attr, parts.join(", "))
        continue
      }

      el.setAttribute(attr, proxifyUrl(this.workerOrigin, this.baseUrl, val))
    }
  }
}

// ---------------------------
// JS injection for dynamic requests
// ---------------------------

const injectedJS = `(function(){
const workerOrigin = location.origin;
const _fetch = window.fetch;
window.fetch = function(url, ...args){
  if(typeof url==="string" && !url.startsWith(workerOrigin)){ url=\`\${workerOrigin}/\${new URL(url, location.href).href}\`; }
  else if(url instanceof Request && !url.url.startsWith(workerOrigin)){ url = new Request(\`\${workerOrigin}/\${url.url}\`, url);}
  return _fetch(url, ...args);
};
const _open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method, url, ...rest){
  if(typeof url==="string" && !url.startsWith(workerOrigin)){ url = \`\${workerOrigin}/\${new URL(url, location.href).href}\`; }
  return _open.call(this, method, url, ...rest);
};
})();`

// ---------------------------
// Worker entry point
// ---------------------------

export default {
  async fetch(request) {
    try {
      const workerUrl = new URL(request.url)
      const targetUrl = extractTarget(request)
      if (!targetUrl) return new Response("Usage: /https://example.com", { status: 400 })

      const proxyRequest = createProxyRequest(request, targetUrl)
      const response = await fetch(proxyRequest)
      const headers = rewriteHeaders(response.headers)

      // rewrite redirects
      const location = headers.get("location")
      if (location) headers.set("location", `${workerUrl.origin}/${new URL(location, targetUrl).href}`)

      const contentType = headers.get("content-type") || ""

      // Non-HTML assets (images, CSS, JS, fonts, video)
      if (!contentType.includes("text/html")) {
        return new Response(response.body, { status: response.status, headers })
      }

      // HTML rewriting + JS injection
      const rewriter = new HTMLRewriter()
        .on("a", new AttributeRewriter(workerUrl.origin, targetUrl))
        .on("img", new AttributeRewriter(workerUrl.origin, targetUrl))
        .on("script", new AttributeRewriter(workerUrl.origin, targetUrl))
        .on("link", new AttributeRewriter(workerUrl.origin, targetUrl))
        .on("form", new AttributeRewriter(workerUrl.origin, targetUrl))
        .on("iframe", new AttributeRewriter(workerUrl.origin, targetUrl))
        .on("source", new AttributeRewriter(workerUrl.origin, targetUrl))
        .on("head", {
          element(el) {
            el.append(`<script>${injectedJS}</script>`, { html: true })
          }
        })

      return rewriter.transform(new Response(response.body, { status: response.status, headers }))
    } catch (err) {
      return new Response("Proxy error: " + err.message, { status: 500 })
    }
  }
}
