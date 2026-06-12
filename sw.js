/* FREUDE service worker — offline / installable PWA.
   Strategy:
   - install: pre-cache the local app shell + the score, and the CDN engine/player libs.
   - fetch:   cache-first; anything new (Verovio WASM, the per-instrument soundfont
              magenta loads on demand, etc.) is cached the first time it's fetched, so
              after one online session — including playing audio once — the app works
              fully offline. Bump CACHE to force a refresh of everything. */
const CACHE = "freude-v3";

// same-origin shell (exact query strings must match what index.html requests)
const LOCAL = [
  "./",
  "./index.html",
  "./styles.css?v=37",
  "./app.js?v=36",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./sf-precache.json",
  "./source/score.mxl",
  "./source/practice.mid",
  "./source/sync.json",
];

// cross-origin engine + player libraries (cached as opaque responses)
const CROSS = [
  "https://www.verovio.org/javascript/latest/verovio-toolkit-wasm.js",
  "https://cdn.jsdelivr.net/combine/npm/tone@14.7.77,npm/@magenta/music@1.23.1/es6/core.js,npm/focus-visible@5,npm/html-midi-player@1.5.0",
  "https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js",
  "https://cdn.jsdelivr.net/npm/@tonejs/midi@2.0.28/build/Midi.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const c = await caches.open(CACHE);
      // add each individually so one 404/offline asset can't abort the whole install
      await Promise.allSettled(LOCAL.map((u) => c.add(u)));
      await Promise.allSettled(
        CROSS.map(async (u) => {
          try {
            const r = await fetch(u, { mode: "no-cors" });
            await c.put(u, r);
          } catch (_) {}
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  // never intercept range requests (audio sample streaming) — let the browser handle them
  if (req.headers.has("range")) return;

  e.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === "opaque" || res.type === "cors")) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      } catch (err) {
        if (req.mode === "navigate") {
          const fallback = await caches.match("./index.html");
          if (fallback) return fallback;
        }
        throw err;
      }
    })()
  );
});
