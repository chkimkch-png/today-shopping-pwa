const CACHE_NAME="today-shopping-pwa-v3";
const ASSETS=["./","./index.html","./styles.css","./app.js","./presets.js","./manifest.webmanifest","./icons/icon-192.png","./icons/icon-512.png"];
self.addEventListener("install",event=>event.waitUntil(
  caches.open(CACHE_NAME).then(cache=>Promise.all(ASSETS.map(u=>cache.add(new Request(u,{cache:"reload"}))))).then(()=>self.skipWaiting())
));
self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
// 네트워크 우선(최대 3초) → 실패/지연 시 저장본 사용: 수정 파일이 바로 반영되고, 오프라인에서도 열림
self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET")return;
  const url=new URL(event.request.url);
  if(url.origin!==location.origin)return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE_NAME);
    try{
      const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),3000);
      const response=await fetch(event.request,{signal:ctl.signal});
      clearTimeout(timer);
      if(response.ok)cache.put(event.request,response.clone());
      return response;
    }catch{
      return (await cache.match(event.request))||(await cache.match("./index.html"));
    }
  })());
});
