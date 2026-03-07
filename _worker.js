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

class AttributeRewriter {
  constructor(workerOrigin) {
    this.workerOrigin = workerOrigin
  }

  element(element) {
    const attrs = ["href", "src", "action"]

    for (const attr of attrs) {
      const val = element.getAttribute(attr)

      if (!val) continue

      if (val.startsWith("http://") || val.startsWith("https://")) {
        element.setAttribute(attr, `${this.workerOrigin}/${val}`)
      } else if (val.startsWith("/")) {
        element.setAttribute(attr, `${this.workerOrigin}${val}`)
      }
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

      const contentType = headers.get("content-type") || ""

      // Binary assets (images, fonts, video, etc)
      if (!contentType.includes("text/html")) {
        return new Response(response.body, {
          status: response.status,
          headers
        })
      }

      // HTML rewriting
      const rewriter = new HTMLRewriter()
        .on("a", new AttributeRewriter(workerUrl.origin))
        .on("img", new AttributeRewriter(workerUrl.origin))
        .on("script", new AttributeRewriter(workerUrl.origin))
        .on("link", new AttributeRewriter(workerUrl.origin))
        .on("form", new AttributeRewriter(workerUrl.origin))

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
