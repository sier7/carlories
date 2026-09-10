#!/usr/bin/env node
/**
 * 部署流程测试：对着一个**模拟的 GitHub API** 把 tools/deploy.mjs 完整跑一遍。
 *
 * 为什么值得写：部署脚本是用户和应用之间唯一的障碍，而它原本一行都没被执行过。
 * 它要是跑到一半失败，用户只会看到一个含糊的 HTTP 错误，不知道该怪网络、
 * token 还是脚本。用模拟服务器能把「创建仓库 → 逐个上传 → 第二次更新时的 sha
 * 处理 → 开启 Pages」整条链路在本地验证，不需要真的 token，也不碰真仓库。
 *
 * 另外这里还做两件部署完整性检查（它们比部署本身更容易出事）：
 *   1. app/ 里每个相对 import 的目标都在待上传清单里
 *   2. sw.js 的预缓存清单里每个文件都真的存在
 * 任何一条不成立，线上的应用都会白屏或者离线失效 —— 而且不会有报错。
 *
 * 运行：node tools/test-deploy.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDeploy, collectFiles } from './deploy.mjs'

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const APP_DIR = join(PROJECT_ROOT, 'app')

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.log(`  ✗ ${name}\n      ${error.message}`)
  }
}

function group(title) {
  console.log(`\n${title}`)
}

// ── 模拟 GitHub API ─────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function createMockGithub() {
  const state = {
    repos: new Set(),
    repoCreates: 0,
    files: new Map(), // repoPath -> { content(base64), sha }
    pagesEnabled: false,
    shaCounter: 0,
    requests: [],
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname
    state.requests.push(`${req.method} ${path}`)

    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }

    // 注意：所有分支都必须在函数体内，否则一个已经 end 的响应会再被写一次
    if (path === '/user' && req.method === 'GET') {
      return json(200, { login: 'testuser' })
    }

    if (path === '/user/repos' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      if (state.repos.has(body.name)) return json(422, { message: 'name already exists' })
      state.repos.add(body.name)
      state.repoCreates++
      return json(201, { name: body.name })
    }

    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path)
    if (repoMatch && req.method === 'GET') {
      if (!state.repos.has(repoMatch[2])) return json(404, { message: 'Not Found' })
      return json(200, { name: repoMatch[2] })
    }

    const contentsMatch = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(path)
    if (contentsMatch) {
      const repoPath = decodeURIComponent(contentsMatch[3])

      if (req.method === 'GET') {
        const existing = state.files.get(repoPath)
        if (!existing) return json(404, { message: 'Not Found' })
        return json(200, { path: repoPath, sha: existing.sha })
      }

      if (req.method === 'PUT') {
        const body = JSON.parse(await readBody(req))
        // 真实 GitHub 的行为：文件已存在但不带 sha，是 422 而不是覆盖
        if (state.files.has(repoPath) && !body.sha) {
          return json(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' })
        }
        if (body.sha && state.files.get(repoPath)?.sha !== body.sha) {
          return json(409, { message: 'sha does not match' })
        }
        state.shaCounter++
        state.files.set(repoPath, { content: body.content, sha: `sha${state.shaCounter}` })
        return json(201, { content: { path: repoPath } })
      }
    }

    const pagesMatch = /^\/repos\/([^/]+)\/([^/]+)\/pages$/.exec(path)
    if (pagesMatch && req.method === 'POST') {
      if (state.pagesEnabled) return json(409, { message: 'Pages already enabled' })
      state.pagesEnabled = true
      return json(201, { html_url: `https://testuser.github.io/${pagesMatch[2]}/` })
    }

    return json(404, { message: 'Not Found' })
  })

  return { state, server }
}

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
}

// ── 完整性检查用的工具 ──────────────────────────────────────────────────

function walkFiles(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walkFiles(full, base))
    else out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

/** 抓出源码里所有 import 的模块说明符（静态、副作用、动态三种写法） */
function extractImportSpecifiers(source) {
  const specs = []
  for (const m of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) specs.push(m[1])
  for (const m of source.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) specs.push(m[1])
  for (const m of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1])
  return specs
}

// ── A. 模拟 GitHub 上跑完整流程 ─────────────────────────────────────────

group('部署：完整流程（对着模拟 GitHub API）')
{
  const mock = createMockGithub()
  const port = await listen(mock.server)
  const apiBase = `http://127.0.0.1:${port}`
  const TOKEN = 'ghp_SECRETTOKEN_must_never_be_logged'

  const logs = []
  const log = (message) => logs.push(String(message))

  const first = await runDeploy({
    token: TOKEN,
    repoName: 'carlories',
    apiBase,
    root: PROJECT_ROOT,
    log,
  })

  check('识别出用户', () => assert.equal(first.owner, 'testuser'))
  check('创建了仓库', () => assert.equal(mock.state.repos.has('carlories'), true))
  check('只创建了一次', () => assert.equal(mock.state.repoCreates, 1))
  check('没有任何文件上传失败', () => assert.equal(first.failed, 0))
  check('上传了全部文件', () => assert.equal(first.uploaded, first.files.length))
  check('文件数量合理（站点 + 源码 + 文档）', () => assert.ok(first.uploaded > 25, `只有 ${first.uploaded} 个`))
  check('开启了 GitHub Pages', () => assert.equal(mock.state.pagesEnabled, true))
  check('返回了正确的访问地址', () =>
    assert.equal(first.url, 'https://testuser.github.io/carlories/'))

  group('上传内容')
  check('站点入口在仓库根目录（Pages 的要求）', () =>
    assert.equal(mock.state.files.has('index.html'), true))
  check('Service Worker 在仓库根目录（否则作用域不对）', () =>
    assert.equal(mock.state.files.has('sw.js'), true))
  check('样式表', () => assert.equal(mock.state.files.has('styles.css'), true))
  check('PWA 清单', () => assert.equal(mock.state.files.has('manifest.webmanifest'), true))
  check('图标', () => assert.equal(mock.state.files.has('icons/icon-180.png'), true))
  check('核心逻辑模块', () => assert.equal(mock.state.files.has('core/food.js'), true))
  check('界面模块', () => assert.equal(mock.state.files.has('ui/main.js'), true))
  check('.nojekyll（否则 Pages 会拿 Jekyll 处理这些文件）', () =>
    assert.equal(mock.state.files.has('.nojekyll'), true))
  check('README 以原有路径上传', () => assert.equal(mock.state.files.has('README.md'), true))
  check('文档目录以原有路径上传', () =>
    assert.equal(mock.state.files.has('docs/装到手机上.md'), true))
  check('工具目录以原有路径上传', () =>
    assert.equal(mock.state.files.has('tools/serve.mjs'), true))

  group('内容确实是文件内容，不是空壳')
  const decode = (repoPath) => Buffer.from(mock.state.files.get(repoPath).content, 'base64')
  check('index.html 内容非空且是 HTML', () => {
    const text = decode('index.html').toString('utf8')
    assert.ok(text.includes('<!doctype html>'))
    assert.ok(text.includes('ui/main.js'))
  })
  check('PNG 图标被原样上传（二进制没被破坏）', () => {
    const buf = decode('icons/icon-512.png')
    assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })
  check('中文路径的文件内容正确', () => {
    const text = decode('docs/装到手机上.md').toString('utf8')
    assert.ok(text.includes('添加到主屏幕'))
  })

  group('安全：token 不能出现在任何输出里')
  check('日志里没有 token', () => {
    assert.equal(logs.join('\n').includes(TOKEN), false)
  })

  group('第二次部署（更新而不是重建）')
  const secondLogs = []
  const second = await runDeploy({
    token: TOKEN,
    repoName: 'carlories',
    apiBase,
    root: PROJECT_ROOT,
    log: (m) => secondLogs.push(String(m)),
  })

  check('没有重复创建仓库', () => assert.equal(mock.state.repoCreates, 1))
  check('第二次同样全部成功', () => assert.equal(second.failed, 0))
  check(
    '第二次也能全部上传 —— 这证明了 sha 回填正确（不带 sha 会被 GitHub 拒成 422）',
    () => assert.equal(second.uploaded, first.uploaded),
  )
  check('第二次识别出仓库已存在', () =>
    assert.ok(secondLogs.join('\n').includes('已存在')))
  check('第二次不再重复开启 Pages（409 被当成正常情况）', () =>
    assert.ok(secondLogs.join('\n').includes('之前已开启')))

  group('--check 模式不上传')
  const beforeCount = mock.state.files.size
  const checked = await runDeploy({
    token: TOKEN,
    repoName: 'carlories',
    apiBase,
    root: PROJECT_ROOT,
    checkOnly: true,
    log: () => {},
  })
  check('返回 checked 标记', () => assert.equal(checked.checked, true))
  check('没有新增任何文件', () => assert.equal(mock.state.files.size, beforeCount))

  group('坏 token')
  const badLogs = []
  let badError = null
  try {
    await runDeploy({ token: 'bogus', repoName: 'carlories', apiBase: 'http://127.0.0.1:1', log: (m) => badLogs.push(m) })
  } catch (error) {
    badError = error
  }
  check('连不上时抛出错误而不是静默成功', () => assert.ok(badError))

  await new Promise((r) => mock.server.close(r))
}

// ── B. 部署完整性 ───────────────────────────────────────────────────────

group('部署完整性：漏掉一个文件，线上就是白屏，而且不报错')
{
  const files = collectFiles(PROJECT_ROOT)
  const repoPaths = new Set(files.map((f) => f.repoPath))

  check('清单里没有重复路径（重复会导致上传互相覆盖）', () =>
    assert.equal(repoPaths.size, files.length))

  check('站点文件全部在仓库根目录，没有 app/ 前缀', () => {
    const stray = files.filter((f) => f.site && f.repoPath.startsWith('app/'))
    assert.deepEqual(stray.map((f) => f.repoPath), [])
  })

  check('app/ 里每个相对 import 的目标都在待上传清单里', () => {
    const jsFiles = walkFiles(APP_DIR).filter((p) => p.endsWith('.js'))
    const missing = []
    for (const rel of jsFiles) {
      const source = readFileSync(join(APP_DIR, rel), 'utf8')
      for (const spec of extractImportSpecifiers(source)) {
        if (!spec.startsWith('.')) continue
        const target = normalize(join(dirname(rel), spec)).split(sep).join('/')
        if (!repoPaths.has(target)) missing.push(`${rel} → ${spec}`)
      }
    }
    assert.deepEqual(missing, [])
  })

  check('sw.js 的预缓存清单里每个文件都真实存在', () => {
    const source = readFileSync(join(APP_DIR, 'sw.js'), 'utf8')
    const block = /const SHELL = \[([\s\S]*?)\]/.exec(source)
    assert.ok(block, '找不到 SHELL 数组')
    const paths = [...block[1].matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean)
    assert.ok(paths.length > 15, `只解析出 ${paths.length} 个路径，正则可能失效了`)
    const missing = paths.filter((p) => !existsSync(join(APP_DIR, p.split('/').join(sep))))
    assert.deepEqual(missing, [])
  })

  check('sw.js 里列出的每个模块都能在待上传清单里找到', () => {
    const source = readFileSync(join(APP_DIR, 'sw.js'), 'utf8')
    const block = /const SHELL = \[([\s\S]*?)\]/.exec(source)
    const paths = [...block[1].matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean)
    const missing = paths.filter((p) => !repoPaths.has(p))
    assert.deepEqual(missing, [])
  })

  check('index.html 引用的资源都存在', () => {
    const html = readFileSync(join(APP_DIR, 'index.html'), 'utf8')
    const refs = [...html.matchAll(/(?:href|src)="\.\/([^"]+)"/g)].map((m) => m[1])
    assert.ok(refs.length >= 4, `只找到 ${refs.length} 个引用`)
    const missing = refs.filter((p) => !existsSync(join(APP_DIR, p.split('/').join(sep))))
    assert.deepEqual(missing, [])
  })

  check('图标文件三个尺寸都在', () => {
    for (const name of ['icon-180.png', 'icon-192.png', 'icon-512.png']) {
      assert.ok(existsSync(join(APP_DIR, 'icons', name)), `缺少 ${name}`)
    }
  })
}

// ── C. token 文件的宽容解析 ─────────────────────────────────────────────

group('token 解析：人手工粘进去的东西不会总是干净的')
{
  const { parseToken } = await import('./deploy.mjs')
  const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'

  check('干干净净的一串', () => assert.equal(parseToken(TOKEN), TOKEN))
  check('前后有换行和空格', () => assert.equal(parseToken(`\n\n  ${TOKEN}  \n`), TOKEN))
  check('被引号包起来', () => assert.equal(parseToken(`"${TOKEN}"`), TOKEN))
  check('前后多带了说明文字', () =>
    assert.equal(parseToken(`我的 token 是 ${TOKEN} 别告诉别人`), TOKEN))
  check('多行内容里挑出 token 那行', () =>
    assert.equal(parseToken(`GitHub Token\n${TOKEN}\n2026-10-03`), TOKEN))
  check('细粒度 token 也认', () =>
    assert.equal(
      parseToken('github_pat_11ABCDEFG0abcdefghijklmnop'),
      'github_pat_11ABCDEFG0abcdefghijklmnop',
    ))
  check('空内容返回 null', () => assert.equal(parseToken('   \n  '), null))
  check('非字符串返回 null', () => assert.equal(parseToken(null), null))
  check('还没填时（文件里只有说明文字）返回 null，而不是把说明当成 token 发出去', () =>
    assert.equal(
      parseToken('把 GitHub token 粘贴到这个文件里，保存即可。\n\n这个文件已被忽略。'),
      null,
    ))
  check('超短的内容不当成 token', () => assert.equal(parseToken('abc'), null))
}

// ── 结果 ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(52)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
