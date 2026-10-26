const CACHE_NAME='asset-manager-github-shell-v4';
const SHELL=['./','./index.html','./manifest.webmanifest','./api-client.js','./icon-asset-manager-192.png','./icon-asset-manager-512.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const request=event.request;
  const url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin)return;
  if(url.pathname.endsWith('/config.example.js')){
    event.respondWith(fetch(request).then(response=>{
      if(response.ok){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(request,copy));}
      return response;
    }).catch(()=>caches.match(request)));
    return;
  }
  if(url.hostname==='script.googleapis.com'||url.pathname.includes('/api/'))return;
  event.respondWith(caches.match(request).then(cached=>cached||fetch(request)));
});
