/* FREUDE service worker — offline / installable PWA.
   Two caches:
   - SHELL (versioned): app shell + score + audio + CDN engine/player. Bump VERSION to refresh
     these on a release; the activate step deletes only OLD shell caches.
   - SOUND (stable): the magenta per-instrument samples (~21MB), warmed once by the page. This
     cache is NEVER deleted on a version bump, so shipping a new build doesn't force a 21MB
     re-download.
   Fetch is cache-first; anything new (Verovio WASM, soundfont samples) is cached the first time
   it's fetched, so after one online session — including playing audio once — the app works
   fully offline. */
const VERSION = "v6";
const SHELL = "freude-shell-" + VERSION;
const SOUND = "freude-soundfont-v1";
const SOUND_HOST = "storage.googleapis.com/magentadata/js/soundfonts";
const isSound = (u) => u.indexOf(SOUND_HOST) >= 0;

// same-origin shell (exact query strings must match what index.html requests)
const LOCAL = [
  "./",
  "./index.html",
  "./styles.css?v=39",
  "./app.js?v=40",
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
      const c = await caches.open(SHELL);
      await Promise.allSettled(LOCAL.map((u) => c.add(u)));
      await Promise.allSettled(
        CROSS.map(async (u) => {
          try { await c.put(u, await fetch(u, { mode: "no-cors" })); } catch (_) {}
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
      // delete stale SHELL caches only; keep the persistent SOUND cache
      await Promise.all(keys.filter((k) => k !== SHELL && k !== SOUND).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  if (req.headers.has("range")) return; // let the browser handle audio range requests

  e.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === "opaque" || res.type === "cors")) {
          const target = isSound(req.url) ? SOUND : SHELL;
          const copy = res.clone();
          caches.open(target).then((c) => c.put(req, copy)).catch(() => {});
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
