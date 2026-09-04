// ============================================================
// service-worker.js
// Cacheia só o "esqueleto" do app (HTML/CSS/JS/ícones) para abrir
// rápido e continuar instalável mesmo com uma rede ruim. As
// chamadas ao Microsoft Graph e o OCR sempre vão para a rede —
// este app não promete funcionar 100% offline, só não perder
// dados em caso de falha momentânea (isso é feito pelo IndexedDB
// em storage.js, não pelo service worker).
// ============================================================

const CACHE_NAME = "notasfiscais-shell-v6";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/styles.css",
  "./js/config.js",
  "./js/categorias.js",
  "./js/storage.js",
  "./js/auth.js",
  "./js/ocr.js",
  "./js/graph.js",
  "./js/app.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;

  if (isSameOrigin) {
    // App shell: cache-first, com atualização em segundo plano.
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok) caches.open(CACHE_NAME).then((c) => c.put(req, res.clone()));
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
  // Recursos de terceiros (Graph API, MSAL, Tesseract, fontes) sempre vão
  // direto para a rede — não interceptamos.
});
