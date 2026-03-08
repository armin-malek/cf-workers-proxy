// ---------------------------
// Helper functions
// ---------------------------
function extractTarget(request) {
  const url = new URL(request.url);
  const raw = url.pathname.slice(1);
  if (!raw.startsWith("http://") && !raw.startsWith("https://")) return null;
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
    redirect: "manual"
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

// ---------------------------
// Convert ANY url to absolute
// ---------------------------
function toAbsolute(targetUrl, value) {
  try {
    if (!value) return null;

    value = value.trim();

    if (value.startsWith("data:")) return value;
    if (value.startsWith("javascript:")) return value;
    if (value.startsWith("#")) return value;

    // protocol-relative
    if (value.startsWith("//")) {
      return `${targetUrl.protocol}${value}`;
    }

    // already absolute
    if (value.startsWith("http://") || value.startsWith("https://")) {
      return new URL(value).href;
    }

    // relative → absolute
    return new URL(value, targetUrl.origin).href;

  } catch {
    return value;
  }
}

// ---------------------------
// Convert any URL to proxied URL
// ---------------------------
function proxifyUrl(workerOrigin, targetUrl, value) {
  try {
    const absolute = toAbsolute(targetUrl, value);
    if (!absolute) return value;

    if (absolute.startsWith(workerOrigin)) return absolute;

    return `${workerOrigin}/${absolute}`;
  } catch {
    return value;
  }
}

// ---------------------------
// HTMLRewriter for attributes
// ---------------------------
class AttributeRewriter {
  constructor(workerOrigin, targetUrl) {
    this.workerOrigin = workerOrigin;
    this.targetUrl = targetUrl;
  }

  element(el) {
    const attrs = [
      "href","src","action","srcset",
      "data-src","data-original","data-lazy",
      "data-srcset","poster"
    ];

    for (const attr of attrs) {
      const val = el.getAttribute(attr);
      if (!val) continue;

      if (attr === "srcset" || attr === "data-srcset") {
        const parts = val.split(",").map(part => {
          const [url, size] = part.trim().split(" ");

          const absolute = toAbsolute(this.targetUrl, url);
          if (!absolute) return part;

          const proxied = absolute.startsWith(this.workerOrigin)
            ? absolute
            : `${this.workerOrigin}/${absolute}`;

          return `${proxied}${size ? " " + size : ""}`;
        });

        el.setAttribute(attr, parts.join(","));
        continue;
      }

      el.setAttribute(
        attr,
        proxifyUrl(this.workerOrigin, this.targetUrl, val)
      );
    }
  }
}

// ---------------------------
// Inject JS for dynamic content / AJAX
// ---------------------------
function getInjectedJS() {
return `(function(){

const workerOrigin = location.origin;
let pathMatch = location.pathname.match(/^\\/https?:\\/\\/[^\\/]+(\\/.*)?/);
let targetUrl = pathMatch ? new URL(pathMatch[0].slice(1)) : new URL(location.href);

function toAbsolute(value){
  try{
    if(!value) return null;

    value=value.trim();

    if(value.startsWith('data:')||value.startsWith('javascript:')||value.startsWith('#'))
      return value;

    if(value.startsWith('//'))
      return targetUrl.protocol + value;

    if(value.startsWith('http://')||value.startsWith('https://'))
      return new URL(value).href;

    return new URL(value,targetUrl.origin).href;

  }catch{return value;}
}

function proxify(el,attrs){
  attrs.forEach(attr=>{
    const val=el.getAttribute(attr);
    if(!val) return;

    if(attr==='srcset'||attr==='data-srcset'){
      const parts=val.split(',').map(p=>{
        const [url,size]=p.trim().split(' ');
        const abs=toAbsolute(url);
        if(!abs) return p;

        const prox=abs.startsWith(workerOrigin)?abs:\`\${workerOrigin}/\${abs}\`;
        return \`\${prox}\${size?' '+size:''}\`;
      });

      el.setAttribute(attr,parts.join(','));
      return;
    }

    const abs=toAbsolute(val);
    if(!abs) return;

    if(!abs.startsWith(workerOrigin))
      el.setAttribute(attr,\`\${workerOrigin}/\${abs}\`);
  });
}

const attrs=['href','src','action','srcset','data-src','data-original','data-lazy','data-srcset','poster'];

document.querySelectorAll('*').forEach(el=>proxify(el,attrs));

const observer=new MutationObserver(mutations=>{
  for(const m of mutations){
    m.addedNodes.forEach(node=>{
      if(node.nodeType!==1) return;
      proxify(node,attrs);
      node.querySelectorAll('*').forEach(el=>proxify(el,attrs));
    });
  }
});

observer.observe(document.body,{childList:true,subtree:true});

const _fetch=window.fetch;
window.fetch=function(url,...args){

  try{
    if(typeof url==='string'){
      const abs=toAbsolute(url);
      if(abs && !abs.startsWith(workerOrigin))
        url=\`\${workerOrigin}/\${abs}\`;
    }

    if(url instanceof Request){
      const abs=toAbsolute(url.url);
      if(abs && !abs.startsWith(workerOrigin))
        url=new Request(\`\${workerOrigin}/\${abs}\`,url);
    }
  }catch{}

  return _fetch(url,...args);
};

const _open=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(method,url,...rest){
  try{
    const abs=toAbsolute(url);
    if(abs && !abs.startsWith(workerOrigin))
      url=\`\${workerOrigin}/\${abs}\`;
  }catch{}
  return _open.call(this,method,url,...rest);
};

})();`;
}

// ---------------------------
// Worker entry
// ---------------------------
export default {
  async fetch(request) {
    try {
      const workerUrl = new URL(request.url);
      const targetUrl = extractTarget(request);

      if (!targetUrl)
        return new Response("Usage: /https://example.com",{status:400});

      const proxyRequest = createProxyRequest(request,targetUrl);
      const response = await fetch(proxyRequest);
      const headers = rewriteHeaders(response.headers);

      const locationHeader = headers.get("location");
      if (locationHeader && !locationHeader.startsWith(workerUrl.origin)) {
        const absolute = toAbsolute(targetUrl, locationHeader);
        headers.set("location", `${workerUrl.origin}/${absolute}`);
      }

      const contentType = headers.get("content-type") || "";

      if (!contentType.includes("text/html")) {
        return new Response(response.body,{
          status:response.status,
          headers
        });
      }

      const rewriter = new HTMLRewriter()
        .on("*", new AttributeRewriter(workerUrl.origin,targetUrl))
        .on("head",{
          element(el){
            el.append(
              `<script>${getInjectedJS()}</script>`,
              {html:true}
            );
          }
        });

      return rewriter.transform(
        new Response(response.body,{
          status:response.status,
          headers
        })
      );

    } catch(err) {
      return new Response("Proxy error: "+err.message,{status:500});
    }
  }
};
