#!/usr/bin/env node
/**
 * 生成应用图标。
 *
 * 为什么不用现成的图片：没有图片编辑工具，也不该为了三张图标去装一个。
 * PNG 的最小结构很简单（IHDR + IDAT + IEND，IDAT 是 zlib 压缩的扫描线），
 * Node 自带 zlib 和 Buffer，够用了。
 *
 * 画法用 4×4 超采样再做平均，这样柱子边缘是平滑的 —— 直接按像素判定
 * 会得到锯齿，在小尺寸图标上尤其明显。
 *
 * 运行：node tools/make-icons.mjs
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = resolve(fileURLToPath(new URL('../app/icons', import.meta.url)))

// ── 最小 PNG 编码器 ─────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = -1
  for (let i = 0; i < buffer.length; i++) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // 过滤器类型：None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 颜色类型：RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── 图形 ────────────────────────────────────────────────────────────────
//
// 三根逐步升高的柱子：这是记录类应用最直白的图形语言，
// 而且能用矩形精确画出来，不需要字体或矢量库。

const BG = [13, 14, 18, 255]
const BAR_DIM = [58, 88, 148, 255]
const BAR_HOT = [77, 139, 255, 255]

const BARS = [
  { x: 0.2075, w: 0.135, top: 0.545 },
  { x: 0.4325, w: 0.135, top: 0.365 },
  { x: 0.6575, w: 0.135, top: 0.185 },
]
const BOTTOM = 0.815
const CORNER = 0.035 // 柱子顶部的圆角半径
const PLATE = 0.235 // 整个底板圆角半径

function inRoundedRect(u, v, x, y, w, h, r) {
  if (u < x || u > x + w || v < y || v > y + h) return false
  const cx = Math.min(Math.max(u, x + r), x + w - r)
  const cy = Math.min(Math.max(v, y + r), y + h - r)
  const dx = u - cx
  const dy = v - cy
  return dx * dx + dy * dy <= r * r
}

function colorAt(u, v) {
  // 底板：圆角方块（iOS 会再套一层自己的遮罩，这里保持一致不至于爆边）
  if (!inRoundedRect(u, v, 0, 0, 1, 1, PLATE)) return [0, 0, 0, 0]

  for (let i = 0; i < BARS.length; i++) {
    const bar = BARS[i]
    const height = BOTTOM - bar.top
    if (inRoundedRect(u, v, bar.x, bar.top, bar.w, height, CORNER)) {
      return i === BARS.length - 1 ? BAR_HOT : BAR_DIM
    }
  }
  return BG
}

function renderIcon(size, samples = 4) {
  const rgba = Buffer.alloc(size * size * 4)
  const step = 1 / (size * samples)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const u = (x * samples + sx + 0.5) * step
          const v = (y * samples + sy + 0.5) * step
          const [cr, cg, cb, ca] = colorAt(u, v)
          const alpha = ca / 255
          r += cr * alpha
          g += cg * alpha
          b += cb * alpha
          a += ca
        }
      }
      const n = samples * samples
      const alpha = a / n
      const weight = alpha > 0 ? a / 255 : 1
      const offset = (y * size + x) * 4
      rgba[offset] = Math.round(r / weight)
      rgba[offset + 1] = Math.round(g / weight)
      rgba[offset + 2] = Math.round(b / weight)
      rgba[offset + 3] = Math.round(alpha)
    }
  }
  return encodePng(size, size, rgba)
}

// ── 输出 ────────────────────────────────────────────────────────────────

const TARGETS = [
  { file: 'icon-180.png', size: 180 }, // apple-touch-icon
  { file: 'icon-192.png', size: 192 }, // Android / manifest
  { file: 'icon-512.png', size: 512 }, // manifest 大图
]

mkdirSync(OUT_DIR, { recursive: true })

for (const target of TARGETS) {
  const png = renderIcon(target.size)
  const path = resolve(OUT_DIR, target.file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, png)
  console.log(`生成 ${target.file}  ${target.size}×${target.size}  ${png.length} 字节`)
}
