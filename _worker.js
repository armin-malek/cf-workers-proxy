function logError(request, message) {
  console.error(
    `${message}, ip=${request.headers.get("cf-connecting-ip")}, ua=${request.headers.get("user-agent")}, url=${request.url}`
  );
}

function extractTarget(request) {
  const url = new URL(request.url);
  const raw = url.pathname.slice(1);

  if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
    return null;
  }

  const target = new URL(raw);
  target.search = url.search;

  return target;
}

function createProxyRequest(request, targetUrl) {
  const headers = new Headers(request.headers);

  headers.set("host", targetUrl.host);
  headers.set("origin", targetUrl.origin);

  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");

  return new Request(targetUrl.toString(), {
    method: request.method,
    headers,
    body: request.body,
    redirect: "follow"
  });
}

function rewriteHeaders(headers) {
  const newHeaders = new Headers(headers);

  newHeaders.delete("content-security-policy");
  newHeaders.delete("content-security-policy-report-only");
  newHeaders.delete("x-frame-options");
  newHeaders.delete("strict-transport-security");

  return newHeaders;
}

async function rewriteHtml(response, workerOrigin) {
  let text = await response.text();

  const replaceList = [
    /href="\/(.*?)"/g,
    /src="\/(.*?)"/g,
    /action="\/(.*?)"/g
  ];

  for (const regex of replaceList) {
    text = text.replace(regex, (match, path) => {
      return match.replace(`/${path}`, `${workerOrigin}/${path}`);
    });
  }

  return text;
}

export default {
  async fetch(request) {
    try {
      const workerUrl = new URL(request.url);

      const targetUrl = extractTarget(request);

      if (!targetUrl) {
        return new Response(
          "Usage:\n\nhttps://worker/https://example.com",
          { status: 400 }
        );
      }

      const proxyRequest = createProxyRequest(request, targetUrl);

      const response = await fetch(proxyRequest);

      const headers = rewriteHeaders(response.headers);

      const contentType = headers.get("content-type") || "";

      if (contentType.includes("text/html")) {
        const body = await rewriteHtml(response, workerUrl.origin);

        return new Response(body, {
          status: response.status,
          headers
        });
      }

      return new Response(response.body, {
        status: response.status,
        headers
      });

    } catch (err) {
      logError(request, err.message);

      return new Response("Proxy Error", {
        status: 500
      });
    }
  }
};
