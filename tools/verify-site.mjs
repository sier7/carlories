#!/usr/bin/env node
/**
 * 校验线上站点：逐个文件比对本地与 GitHub Pages 上的内容。
 *
 * 为什么需要它：部署成功不等于站点正确。少传一个模块，页面上就是白屏，
 * 而 GitHub 只会告诉你构建成功。这个工具把「本地 app/ 里的每个文件」
 * 都去线上下一次，比对状态码和**字节长度** —— 长度对不上就是内容不一致，
 * 这比只检查 200 强得多。
 *
 * 另有一个容易踩的坑促使我写它：PowerShell 的 Invoke-WebRequest 在这台机器上
 * 连不上 github.io（TLS 协商失败），会误报「站点没上线」。用 Node 的 fetch
 * 才测得准。所以校验必须走 Node。
 *
 * 用法：
 *   node tools/verify-site.mjs                      # 自动推导地址
 *   node tools/verify-site.mjs https://x.github.io/y/
 */

import { readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectFiles, parseToken } from './deploy.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function resolveBase() {
  const arg = process.argv[2]
  if (arg) return arg.endsWith('/') ? arg : `${arg}/`

  const tokenFile = join(ROOT, '.github-token')
  if (!existsSync(tokenFile)) return null
  const token = parseToken(readFileSync(tokenFile, 'utf8'))
  if (!token) return null

  // 从仓库里读 Pages 地址，避免手工拼错用户名
  return fetch('https://api.github.com/repos/sier7/carlories/pages', {
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'verify-site' },
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((json) => (json && json.html_url ? json.html_url.replace(/\/?$/, '/') : null))
}

const base = await resolveBase()
if (!base) {
  console.error('无法确定站点地址。用法：node tools/verify-site.mjs https://<用户名>.github.io/<仓库>/')
  process.exit(1)
}

console.log(`校验站点：${base}\n`)

const files = collectFiles().filter((f) => f.site && f.repoPath !== '.nojekyll')

let ok = 0
const problems = []

for (const file of files) {
  const url = base + file.repoPath
  let localSize = 0
  try {
    localSize = statSync(file.localPath).size
  } catch {
    problems.push({ path: file.repoPath, reason: '本地文件读不到' })
    continue
  }

  let response
  try {
    response = await fetch(url, { redirect: 'follow' })
  } catch (error) {
    problems.push({ path: file.repoPath, reason: `网络失败：${error.message}` })
    continue
  }

  if (!response.ok) {
    problems.push({ path: file.repoPath, reason: `HTTP ${response.status}` })
    continue
  }

  const remote = Buffer.from(await response.arrayBuffer())
  if (remote.length !== localSize) {
    problems.push({
      path: file.repoPath,
      reason: `长度不一致：本地 ${localSize} 字节，线上 ${remote.length} 字节`,
    })
    continue
  }

  ok++
  console.log(`  ✓ ${file.repoPath.padEnd(28)} ${String(remote.length).padStart(7)} 字节`)
}

console.log(`\n${'─'.repeat(56)}`)
if (problems.length === 0) {
  console.log(`全部通过：${ok}/${files.length} 个文件与本地完全一致。`)
  console.log(`\n  ${base}\n`)
  console.log('可以在 iPhone 上用 Safari 打开它了。')
  process.exit(0)
}

console.log(`通过 ${ok} 项，${problems.length} 项有问题：`)
for (const problem of problems) {
  console.log(`  ✗ ${problem.path}\n      ${problem.reason}`)
}
console.log('\n如果整批都失败，可能是 GitHub Pages 还在构建，等一分钟再跑一次。')
process.exit(1)
