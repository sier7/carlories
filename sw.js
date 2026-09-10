/**
 * Service Worker。
 *
 * 手机上的网页应用如果没装 Service Worker，断网就是一个白屏的浏览器错误页。
 * 而这个应用的全部数据本来就在本地 —— 没道理因为没网就用不了。
 *
 * 策略是 stale-while-revalidate：先用缓存立刻渲染，同时后台拉新版本写回缓存，
 * 所以下一次打开就是新版。对个人应用来说这比 network-first 好：它永远
 * 不需要等网络，也不会因为网络慢而卡在加载中。
 */

const CACHE = 'carlories-v1'

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './core/food.js',
  './core/log.js',
  './core/date.js',
  './core/history.js',
  './core/healthSync.js',
  './storage/db.js',
  './storage/foodRepo.js',
  './storage/logRepo.js',
  './storage/dayRepo.js',
  './storage/settingsRepo.js',
  './ui/dom.js',
  './ui/widgets.js',
  './ui/format.js',
  './ui/main.js',
  './ui/dayView.js',
  './ui/libraryView.js',
  './ui/foodForm.js',
  './ui/freeEntryForm.js',
  './ui/foodPicker.js',
  './ui/sheets.js',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // 逐个 add 而不是 addAll：任何一个 404 都不该让整次安装失败
      await Promise.all(
        SHELL.map((path) => cache.add(path).catch(() => null)),
      )
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      const cached = await cache.match(request, { ignoreSearch: true })

      const fromNetwork = fetch(request)
        .then((response) => {
          if (response && response.ok) cache.put(request, response.clone())
          return response
        })
        .catch(() => null)

      if (cached) return cached

      const fresh = await fromNetwork
      if (fresh) return fresh

      if (request.mode === 'navigate') {
        const fallback = await cache.match('./index.html')
        if (fallback) return fallback
      }

      return new Response('离线，且这个资源没有缓存', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    })(),
  )
})
