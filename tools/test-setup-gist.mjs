#!/usr/bin/env node
/**
 * Gist 信箱创建脚本的测试：对着一个**模拟的 GitHub API** 完整跑一遍。
 *
 * 为什么值得写：这段代码要连真实账号、建 Gist、写本地文件，中间任何一步失败
 * 用户看到的都只是一句 HTTP 报错。用模拟服务器能把整条链路在本地验证掉，
 * 不需要 token，也不会往真实账号里建任何东西。
 *
 * 运行：node tools/test-setup-gist.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runSetupGist, GIST_DESCRIPTION } from './setup-gist.mjs'
import { GIST_FILENAME, parseGistConfig } from '../app/core/healthSync.js'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const TMP = join(ROOT, '.tmp', 'gist-test')

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

async function checkAsync(name, fn) {
  try {
    await fn()
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

// ── 模拟 GitHub ─────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const GIST_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'

function createMockGithub({ existingGist = null, tokenValid = true } = {}) {
  const state = { gists: new Map(), creates: 0, requests: [] }
  if (existingGist) state.gists.set(existingGist, { id: existingGist })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname
    state.requests.push(`${req.method} ${path}`)

    const ok = (result) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
    }
    const fail = (status, message) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message }))
    }

    if (path === '/user' && req.method === 'GET') {
      if (!tokenValid) return fail(401, 'Bad credentials')
      return ok({ login: 'testuser' })
    }

    if (path === '/gists' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      const id = GIST_ID
      state.gists.set(id, { id, body })
      state.creates++
      return ok({ id })
    }

    const gistMatch = /^\/gists\/([^/]+)$/.exec(path)
    if (gistMatch && req.method === 'GET') {
      const gist = state.gists.get(gistMatch[1])
      if (!gist) return fail(404, 'Not Found')
      return ok(gist)
    }

    return fail(404, `no route for ${req.method} ${path}`)
  })

  return { state, server }
}

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
}

// ── A. 首次创建 ─────────────────────────────────────────────────────────

rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const TOKEN = 'ghp_SECRETTOKEN_never_logged_1234567890'

group('首次创建信箱')
{
  const mock = createMockGithub()
  const port = await listen(mock.server)
  const apiBase = `http://127.0.0.1:${port}`
  const idFile = join(TMP, '.gist-id')

  const logs = []
  let result = null

  await checkAsync('整条流程跑通，不抛错', async () => {
    result = await runSetupGist({ token: TOKEN, apiBase, idFile, log: (m) => logs.push(String(m)) })
    assert.ok(result)
  })

  check('创建了一个 Gist', () => assert.equal(mock.state.creates, 1))
  check('标记为秘密（public: false）', () => {
    const created = [...mock.state.gists.values()][0]
    assert.equal(created.body.public, false)
  })
  check('用了约定的文件名', () => {
    const created = [...mock.state.gists.values()][0]
    assert.ok(created.body.files[GIST_FILENAME], `实际：${Object.keys(created.body.files).join(',')}`)
  })
  check('初始内容不含任何看起来像数据的载荷（免得应用把占位符当数据）', () => {
    const created = [...mock.state.gists.values()][0]
    const content = created.body.files[GIST_FILENAME].content
    assert.ok(!/CAL\//.test(content), `实际内容：${JSON.stringify(content)}`)
  })
  check('描述写清楚了用途', () => {
    const created = [...mock.state.gists.values()][0]
    assert.equal(created.body.description, GIST_DESCRIPTION)
  })
  check('id 被保存到本地文件', () => assert.ok(existsSync(idFile)))
  check('本地文件里就是那个 id', () =>
    assert.equal(readFileSync(idFile, 'utf8').trim(), GIST_ID))

  group('输出')
  check('返回 Gist 地址', () => assert.equal(result.url, `https://gist.github.com/testuser/${GIST_ID}`))
  check('配置串能被应用解析回来', () =>
    assert.equal(parseGistConfig(result.configString).gistId, GIST_ID))
  check('配置串里没有 token', () =>
    assert.equal(result.configString.includes(TOKEN), false))
  check('日志里没有 token', () => assert.equal(logs.join('\n').includes(TOKEN), false))
  check('打印了给快捷指令用的 API 地址（含 id，不含 token）', () =>
    assert.ok(logs.join('\n').includes(`/gists/${GIST_ID}`)))
  check('打印了正确的文件名（快捷指令要照抄）', () =>
    assert.ok(logs.join('\n').includes(GIST_FILENAME)))

  group('重复运行')
  const secondLogs = []
  const second = await runSetupGist({
    token: TOKEN, apiBase, idFile, log: (m) => secondLogs.push(String(m)),
  })
  check('不再新建，复用已有信箱', () => assert.equal(mock.state.creates, 1))
  check('返回同一个 id', () => assert.equal(second.gistId, GIST_ID))
  check('日志里说明了是在复用', () => assert.ok(secondLogs.join('\n').includes('继续用它')))

  group('本地记录的 id 已经失效时')
  writeFileSync(idFile, 'deadbeefdeadbeefdeadbeefdeadbeef\n', 'utf8')
  const thirdLogs = []
  await runSetupGist({ token: TOKEN, apiBase, idFile, log: (m) => thirdLogs.push(String(m)) })
  check('会重新建一个，而不是卡住', () => assert.equal(mock.state.creates, 2))
  check('日志里说明了原因', () => assert.ok(thirdLogs.join('\n').includes('已经不在了')))
  check('新的 id 被写回本地文件', () =>
    assert.equal(readFileSync(idFile, 'utf8').trim(), GIST_ID))

  await new Promise((r) => mock.server.close(r))
}

// ── B. 出错时的表现 ─────────────────────────────────────────────────────

group('出错时要说清楚')
{
  const badMock = createMockGithub({ tokenValid: false })
  const port = await listen(badMock.server)

  let error = null
  await checkAsync('token 无效 → 抛错', async () => {
    try {
      await runSetupGist({
        token: 'bad', apiBase: `http://127.0.0.1:${port}`,
        idFile: join(TMP, '.gist-id-bad'), log: () => {},
      })
    } catch (e) {
      error = e
    }
    assert.ok(error)
  })
  check('错误里带上 GitHub 的原始说明', () =>
    assert.ok(error.message.includes('Bad credentials'), `实际：${error.message}`))
  check('状态码是 401，便于上层给针对性提示', () => assert.equal(error.status, 401))
  check('失败了就不该留下 id 文件', () => assert.equal(existsSync(join(TMP, '.gist-id-bad')), false))

  await new Promise((r) => badMock.server.close(r))
}

rmSync(TMP, { recursive: true, force: true })

console.log(`\n${'─'.repeat(52)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
