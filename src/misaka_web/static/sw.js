/* MISAKA WebUI —— 手写 Service Worker（离线壳）。经典脚本、无依赖、无 workbox。
 *
 * 策略（CONTRACT 之外的 M4 约定）：
 *   - /api/ 与任何 /file 请求：**网络直通，一律不缓存**（含 PDF / Range 流）；
 *   - 导航请求：network-first，失败回退缓存里的 index.html（离线壳）；
 *   - 带 hash 的静态资源：cache-first；
 *   - 新 SW activate 时删掉旧缓存，并 clients.claim() 立即接管。
 *
 * 想作废旧缓存：把 VERSION 改一下（activate 会清掉名字不匹配的 cache）。
 */
/* The build stamps these two: the hashed asset list and a version derived from it. */
const BUILD_ASSETS = ["./assets/index-DH1NGnBV.css","./assets/index-Drp3xdPw.js"];
const VERSION = "2a87b86a";
const CACHE = "misaka-shell-" + VERSION;
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg", ...BUILD_ASSETS];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {
        /* 壳缓存失败不影响 SW 安装，运行时还会补 */
      }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

/** /api/ 与 /file 永远走网络：接口数据与文件流绝不进缓存。 */
function isNetworkOnly(url) {
  return url.pathname.includes("/api/") || url.pathname.endsWith("/file") || url.pathname.endsWith("/file/");
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put("./index.html", fresh.clone());
    return fresh;
  } catch (err) {
    const cached =
      (await cache.match("./index.html")) || (await cache.match("./")) || (await cache.match(request));
    return (
      cached ||
      new Response("离线，而且没有可用的缓存壳。", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      })
    );
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok && fresh.type === "basic") cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    return new Response("", { status: 504, statusText: "offline" });
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isNetworkOnly(url)) return; // 交给浏览器：network-only，不缓存

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});