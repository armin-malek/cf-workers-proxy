function getInjectedJS() {
return `(function(){

const workerOrigin = location.origin;

let pathMatch = location.pathname.match(/^\\/https?:\\/\\/[^\\/]+/);
let targetOrigin = pathMatch ? pathMatch[0].slice(1) : location.origin;

function toAbsolute(url){
  try{

    if(!url) return url;

    if(url.startsWith("data:") || url.startsWith("javascript:") || url.startsWith("#"))
      return url;

    if(url.startsWith("//"))
      return location.protocol + url;

    if(url.startsWith("http://") || url.startsWith("https://"))
      return new URL(url).href;

    return new URL(url, targetOrigin).href;

  }catch(e){
    return url;
  }
}

function proxify(url){
  const abs = toAbsolute(url);

  if(!abs) return url;

  if(abs.startsWith(workerOrigin))
    return abs;

  return workerOrigin + "/" + abs;
}


// ------------------
// FETCH interception
// ------------------

const originalFetch = window.fetch;

window.fetch = function(input, init){

  try{

    if(typeof input === "string"){
      input = proxify(input);
    }

    else if(input instanceof URL){
      input = proxify(input.href);
    }

    else if(input instanceof Request){

      const newUrl = proxify(input.url);

      input = new Request(newUrl, input);
    }

  }catch(e){}

  return originalFetch.call(this, input, init);
};


// ------------------
// XHR interception
// ------------------

const origOpen = XMLHttpRequest.prototype.open;

XMLHttpRequest.prototype.open = function(method, url){

  try{
    url = proxify(url);
  }catch(e){}

  return origOpen.apply(this, [method, url, ...Array.from(arguments).slice(2)]);
};


// ------------------
// Fix axios/jQuery
// ------------------

const origSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.send = function(body){

  try{
    if(this.responseURL && !this.responseURL.startsWith(workerOrigin)){
      this.responseURL = proxify(this.responseURL);
    }
  }catch(e){}

  return origSend.call(this, body);
};

})();`;
}
