function extractTarget(request) {
  const url = new URL(request.url)
  const raw = url.pathname.slice(1)

  if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
    return null
  }

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

class AttributeRewriter {
  constructor(workerOrigin, baseUrl) {
    this.workerOrigin = workerOrigin
    this.baseUrl = baseUrl
  }

  element(el) {
    const attrs = ["href", "src", "action"]

    for (const attr of attrs) {
      const val = el.getAttribute(attr)
      if (!val) continue

      const newUrl = proxifyUrl(this.workerOrigin, this.baseUrl, val)

      el.setAttribute(attr, newUrl)
    }
  }
}

export default {
  async fetch(request) {
    try {
      const workerUrl = new URL(request.url)

      const targetUrl = extractTarget(request)

      if (!targetUrl) {
        return new Response(
          "Usage:\n\nhttps://worker/https://example.com",
          { status: 400 }
        )
      }

      const proxyRequest = createProxyRequest(request, targetUrl)

      const response = await fetch(proxyRequest)

      const headers = rewriteHeaders(response.headers)

      // rewrite redirects
      const location = headers.get("location")
      if (location) {
        headers.set(
          "location",
          `${workerUrl.origin}/${new URL(location, targetUrl).href}`
        )
      }

      const contentType = headers.get("content-type") || ""

      // non HTML assets (images/css/js/fonts)
      if (!contentType.includes("text/html")) {
        return new Response(response.body, {
          status: response.status,
          headers
        })
      }

      const rewriter = new HTMLRewriter()
        .on("a", new AttributeRewriter(workerUrl.origin, targetUrl))
        .on("img", new AttributeRewriter(workerUrl.origin, targetUrl))
        .on("script", new AttributeRewriter(workerUrl.origin, targetUrl))
        .on("link", new AttributeRewriter(workerUrl.origin, targetUrl))
        .on("form", new AttributeRewriter(workerUrl.origin, targetUrl))
        .on("iframe", new AttributeRewriter(workerUrl.origin, targetUrl))
        .on("source", new AttributeRewriter(workerUrl.origin, targetUrl))

      return rewriter.transform(
        new Response(response.body, {
          status: response.status,
          headers
        })
      )
    } catch (err) {
      return new Response("Proxy error: " + err.message, { status: 500 })
    }
  }
}
