#!/usr/bin/env node
/**
 * 零依赖静态服务器。
 *
 * 为什么需要它：应用用的是原生 ES 模块，而浏览器在 file:// 协议下会因
 * CORS 拒绝加载模块。直接双击 index.html 打不开，必须经 HTTP。
 *
 * 用法：
 *   node tools/serve.mjs              # 仅本机，http://127.0.0.1:5173
 *   node tools/serve.mjs --lan        # 同时监听局域网，便于用手机调试
 *
 * 注意（设计草案 §11）：iOS 上剪贴板 API 需要安全上下文，通过局域网 IP
 * 以 HTTP 访问时不满足条件。所以局域网调试只能验界面，不能验剪贴板。
 */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'

const ROOT = resolve(fileURLToPath(new URL('../app', import.meta.url)))
const PORT = Number(process.env.PORT || 5173)
const USE_LAN = process.argv.includes('--lan')
const HOST = process.env.HOST || (USE_LAN ? '0.0.0.0' : '127.0.0.1')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/') pathname = '/index.html'

    // 阻止路径穿越：规范化后必须仍在 ROOT 之内
    const target = resolve(join(ROOT, normalize(pathname)))
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      res.writeHead(403).end('403')
      return
    }

    const info = await stat(target).catch(() => null)
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 未找到')
      return
    }

    const body = await readFile(target)
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(`500 ${error.message}`)
  }
})

server.listen(PORT, HOST, () => {
  console.log(`静态服务已启动，根目录：${ROOT}`)
  console.log(`  本机：  http://127.0.0.1:${PORT}/`)
  if (USE_LAN) {
    for (const [name, addrs] of Object.entries(networkInterfaces())) {
      for (const addr of addrs || []) {
        if (addr.family === 'IPv4' && !addr.internal) {
          console.log(`  局域网（${name}）：http://${addr.address}:${PORT}/`)
        }
      }
    }
    console.log('  提示：局域网 HTTP 不是安全上下文，剪贴板功能不可用。')
  }
})
