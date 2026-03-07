export default {
  async fetch(request) {
    try {
      const url = new URL(request.url);

      // The proxied URL is everything after the first slash
      // e.g. /https://example.com/path → target https://example.com/path
      const proxiedUrl = url.pathname.slice(1) + url.search + url.hash;
      if (!proxiedUrl.startsWith("http://") && !proxiedUrl.startsWith("https://")) {
        return new Response("Usage: /https://example.com/...", { status: 400 });
      }

      const targetUrl = new URL(proxiedUrl);

      // Clone headers and set host/origin
      const headers = new Headers(request.headers);
      headers.set("host", targetUrl.host);
      headers.set("origin", targetUrl.origin);

      // Remove Cloudflare headers that may break requests
      headers.delete("cf-connecting-ip");
      headers.delete("cf-ipcountry");
      headers.delete("cf-ray");

      // Create a new request for the target
      const proxyRequest = new Request(targetUrl.toString(), {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
      });

      // Fetch the target
      const response = await fetch(proxyRequest);

      // Copy headers and remove security headers that may break embedding
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete("content-security-policy");
      responseHeaders.delete("content-security-policy-report-only");
      responseHeaders.delete("x-frame-options");
      responseHeaders.delete("strict-transport-security");

      // Rewrite redirect Location headers to go through the worker
      const location = responseHeaders.get("location");
      if (location && !location.startsWith(url.origin)) {
        const absLocation = new URL(location, targetUrl).href;
        responseHeaders.set("location", `${url.origin}/${absLocation}`);
      }

      // Return the proxied response as-is
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      });

    } catch (err) {
      return new Response("Proxy error: " + err.message, { status: 500 });
    }
  }
};
