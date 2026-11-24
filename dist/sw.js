const cacheName = 'kwast-pilot-v2';
const shell = ['index.html','app.css','app.js','map.js','config.js','install.js','app.webmanifest','icon-192.png','icon-512.png'];
self.addEventListener('install', event => {
    event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(shell)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
    event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('kwast-pilot-') && key !== cacheName).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    const supported = shell.some(path => new URL(path,self.registration.scope).href === url.href);
    if (!supported && !(event.request.mode === 'navigate' && url.href === self.registration.scope)) return;
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request.mode === 'navigate' ? new URL('index.html',self.registration.scope).href : event.request)));
});
