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
// Convert any URL to proxied URL
// ---------------------------
function proxifyUrl(workerOrigin, targetUrl, value) {
  try {
    if (value.startsWith(workerOrigin)) return value; // already proxied
    const absolute = new URL(value, targetUrl.href).href;
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
          try {
            const absolute = new URL(url, this.targetUrl.href).href;
            if (absolute.startsWith(this.workerOrigin)) return part;
            return `${this.workerOrigin}/${absolute} ${size||""}`.trim();
          } catch {
            return part;
          }
        });
        el.setAttribute(attr, parts.join(","));
        continue;
      }
      el.setAttribute(attr, proxifyUrl(this.workerOrigin, this.targetUrl, val));
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

function proxify(el, attrs){
  attrs.forEach(attr=>{
    const val = el.getAttribute(attr);
    if(!val) return;
    if(attr==='srcset'||attr==='data-srcset'){
      const parts = val.split(',').map(p=>{
        const [url,size]=p.trim().split(' ');
        try{
          const abs=new URL(url,targetUrl.href).href;
          return abs.startsWith(workerOrigin)?p:\`\${workerOrigin}/\${abs} \${size||''}\`.trim();
        }catch{return p;}
      });
      el.setAttribute(attr, parts.join(','));
    }else{
      try{
        const abs=new URL(val,targetUrl.href).href;
        if(!val.startsWith(workerOrigin)) el.setAttribute(attr,\`\${workerOrigin}/\${abs}\`);
      }catch{}
    }
  });
}

// Initial rewrite
const attrs=['href','src','action','srcset','data-src','data-original','data-lazy','data-srcset','poster'];
document.querySelectorAll('*').forEach(el=>proxify(el, attrs));

// Observe DOM changes
const observer = new MutationObserver(mutations=>{
  for(const m of mutations){
    m.addedNodes.forEach(node=>{
      if(node.nodeType!==1) return;
      proxify(node, attrs);
      node.querySelectorAll('*').forEach(el=>proxify(el, attrs));
    });
  }
});
observer.observe(document.body,{childList:true,subtree:true});

// Intercept fetch
const _fetch=window.fetch;
window.fetch=function(url,...args){
  if(typeof url==='string' && !url.startsWith(workerOrigin)){
    try{ url=new URL(url,targetUrl.href).href }catch{}
    url=\`\${workerOrigin}/\${url}\`;
  }else if(url instanceof Request && !url.url.startsWith(workerOrigin)){
    try{ const u=new URL(url.url,targetUrl.href).href; url=new Request(\`\${workerOrigin}/\${u}\`,url);}catch{}
  }
  return _fetch(url,...args);
};

// Intercept XMLHttpRequest
const _open=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(method,url,...rest){
  if(typeof url==='string' && !url.startsWith(workerOrigin)){
    try{ url=new URL(url,targetUrl.href).href }catch{}
    url=\`\${workerOrigin}/\${url}\`;
  }
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
      if(!targetUrl) return new Response("Usage: /https://example.com",{status:400});

      const proxyRequest = createProxyRequest(request,targetUrl);
      const response = await fetch(proxyRequest);
      const headers = rewriteHeaders(response.headers);

      // Rewrite redirects
      const locationHeader = headers.get("location");
      if(locationHeader && !locationHeader.startsWith(workerUrl.origin))
        headers.set("location", `${workerUrl.origin}/${new URL(locationHeader,targetUrl).href}`);

      const contentType = headers.get("content-type")||"";

      // Non-HTML assets
      if(!contentType.includes("text/html")){
        return new Response(response.body,{status:response.status,headers});
      }

      // HTML + dynamic JS injection
      const rewriter = new HTMLRewriter()
        .on("a", new AttributeRewriter(workerUrl.origin,targetUrl))
        .on("img", new AttributeRewriter(workerUrl.origin,targetUrl))
        .on("script", new AttributeRewriter(workerUrl.origin,targetUrl))
        .on("link", new AttributeRewriter(workerUrl.origin,targetUrl))
        .on("form", new AttributeRewriter(workerUrl.origin,targetUrl))
        .on("iframe", new AttributeRewriter(workerUrl.origin,targetUrl))
        .on("source", new AttributeRewriter(workerUrl.origin,targetUrl))
        .on("head",{element(el){ el.append(`<script>${getInjectedJS()}</script>`,{html:true}) }});

      return rewriter.transform(new Response(response.body,{status:response.status,headers}));

    } catch(err){
      return new Response("Proxy error: "+err.message,{status:500});
    }
  }
};
