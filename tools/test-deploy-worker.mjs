#!/usr/bin/env node
/**
 * 中继部署脚本的测试：对着一个**模拟的 Cloudflare API** 把 tools/deploy-worker.mjs
 * 完整跑一遍。
 *
 * 为什么值得写：这段代码要连一个真实账号、建 KV、上传 Worker、开子域 ——
 * 其中任何一步失败，用户看到的都只是一句 HTTP 报错。用模拟服务器能在本地
 * 把整条链路验证掉，不需要 Cloudflare 账号，也不会往云上写任何东西。
 *
 * 运行：node tools/test-deploy-worker.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDeployWorker, parseCredentials } from './deploy-worker.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const TMP = join(ROOT, '.tmp', 'worker-deploy-test')

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

// ── 模拟 Cloudflare ─────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function createMockCloudflare({ tokenValid = true, namespaces = [] } = {}) {
  const state = {
    namespaces: [...namespaces],
    scriptUploads: [],
    subdomainEnabled: false,
    requests: [],
    subdomain: 'testuser',
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname
    state.requests.push(`${req.method} ${path}`)

    const ok = (result) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true, result, errors: [], messages: [] }))
    }
    const fail = (status, code, message) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: false, result: null, errors: [{ code, message }], messages: [] }))
    }

    if (path === '/user/tokens/verify' && req.method === 'GET') {
      if (!tokenValid) return fail(401, 1000, 'Invalid API Token')
      return ok({ status: 'active' })
    }

    if (path === '/accounts' && req.method === 'GET') {
      return ok([{ id: 'a'.repeat(32), name: 'Test Account' }])
    }

    const nsList = /^\/accounts\/([^/]+)\/storage\/kv\/namespaces$/.exec(path)
    if (nsList && req.method === 'GET') return ok(state.namespaces)
    if (nsList && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      const created = { id: `ns${state.namespaces.length + 1}`.padEnd(32, '0'), title: body.title }
      state.namespaces.push(created)
      return ok(created)
    }

    const scriptMatch = /^\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)$/.exec(path)
    if (scriptMatch && req.method === 'PUT') {
      const raw = await readBody(req)
      state.scriptUploads.push({ name: scriptMatch[2], raw })
      return ok({ id: scriptMatch[2] })
    }

    const subMatch = /^\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)\/subdomain$/.exec(path)
    if (subMatch && req.method === 'POST') {
      state.subdomainEnabled = true
      return ok({ enabled: true })
    }

    const subGet = /^\/accounts\/([^/]+)\/workers\/subdomain$/.exec(path)
    if (subGet && req.method === 'GET') {
      return ok({ subdomain: state.subdomain })
    }

    return fail(404, 7003, `no route for ${req.method} ${path}`)
  })

  return { state, server }
}

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
}

// ── A. 凭据解析 ─────────────────────────────────────────────────────────

group('凭据文件解析：两行，第二行可省')
{
  const TOKEN = 'cf-abcdefghijklmnopqrstuvwxyz123456'
  const ACCOUNT = 'b'.repeat(32)

  check('只有 token', () => {
    const c = parseCredentials(TOKEN)
    assert.equal(c.token, TOKEN)
    assert.equal(c.accountId, null)
  })
  check('token + account id', () => {
    const c = parseCredentials(`${TOKEN}\n${ACCOUNT}`)
    assert.equal(c.token, TOKEN)
    assert.equal(c.accountId, ACCOUNT)
  })
  check('顺序颠倒也能认出来（32 位十六进制就是 Account ID）', () => {
    const c = parseCredentials(`${ACCOUNT}\n${TOKEN}`)
    assert.equal(c.token, TOKEN)
    assert.equal(c.accountId, ACCOUNT)
  })
  check('忽略空行与 # 注释', () => {
    const c = parseCredentials(`# 我的 Cloudflare 凭据\n\n${TOKEN}\n\n${ACCOUNT}\n`)
    assert.equal(c.token, TOKEN)
    assert.equal(c.accountId, ACCOUNT)
  })
  check('空内容 → 都是 null', () => {
    assert.deepEqual(parseCredentials(''), { token: null, accountId: null })
  })
  check('太短的字符串不算 token（防止把注释当成 token 发出去）', () =>
    assert.equal(parseCredentials('abc').token, null))
}

// ── B. 完整部署流程 ─────────────────────────────────────────────────────

rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const TOKEN = 'cf_SECRETTOKEN_never_logged_1234567890'

group('部署：完整流程（对着模拟 Cloudflare）')
{
  const mock = createMockCloudflare()
  const port = await listen(mock.server)
  const apiBase = `http://127.0.0.1:${port}`
  const tokenFile = join(TMP, '.relay-token')

  const logs = []
  const log = (m) => logs.push(String(m))

  let result = null
  await checkAsync('整条流程跑通，不抛错', async () => {
    result = await runDeployWorker({ token: TOKEN, apiBase, tokenFile, log })
    assert.ok(result)
  })

  check('创建了 KV 命名空间', () => assert.equal(mock.state.namespaces.length, 1))
  check('命名空间名字正确', () => assert.equal(mock.state.namespaces[0].title, 'carlories-sync'))
  check('上传了 Worker 脚本', () => assert.equal(mock.state.scriptUploads.length, 1))
  check('脚本名正确', () => assert.equal(mock.state.scriptUploads[0].name, 'carlories-relay'))
  check('打开了 workers.dev 子域', () => assert.equal(mock.state.subdomainEnabled, true))

  group('上传内容')
  const upload = mock.state.scriptUploads[0].raw
  check('带上了真正的中继源码', () => assert.ok(upload.includes('handleRequest')))
  check('metadata 声明了模块入口', () => assert.ok(upload.includes('"main_module":"index.js"')))
  check('绑定了 KV 命名空间', () => assert.ok(upload.includes('"name":"CARLORIES"')))
  check('绑定里带上了命名空间 id', () =>
    assert.ok(upload.includes(`"namespace_id":"${mock.state.namespaces[0].id}"`)))
  check('注入了同步口令', () => assert.ok(upload.includes('"name":"SYNC_TOKEN"')))
  check('注入了时区偏移（today 按东八区算）', () =>
    assert.ok(upload.includes('"name":"TZ_OFFSET_HOURS"') && upload.includes('"text":"8"')))
  check('声明了兼容日期', () => assert.ok(upload.includes('"compatibility_date"')))

  group('输出')
  check('返回的地址形如 workers.dev', () =>
    assert.equal(result.url, 'https://carlories-relay.testuser.workers.dev'))
  check('口令已生成并写入本地文件', () => assert.ok(existsSync(tokenFile)))
  check('本地文件里就是返回的那个口令', () =>
    assert.equal(readFileSync(tokenFile, 'utf8').trim(), result.syncToken))
  check('口令有足够长度', () => assert.ok(result.syncToken.length >= 30))
  check('配置串格式正确，且能被应用解析', () => {
    assert.ok(result.configString.startsWith('carlories-relay:v1|'))
    const [prefix, endpoint, token] = result.configString.split('|')
    assert.equal(prefix, 'carlories-relay:v1')
    assert.equal(endpoint, result.url)
    assert.equal(token, result.syncToken)
  })

  group('安全：两个口令是两回事，别混为一谈')
  check('★ Cloudflare API Token 绝不出现在任何输出里', () =>
    assert.equal(logs.join('\n').includes(TOKEN), false))
  check('Cloudflare Token 也没有被写进本地口令文件', () =>
    assert.equal(readFileSync(tokenFile, 'utf8').includes(TOKEN), false))
  check('同步口令会打印出来 —— 这是必要的，快捷指令的头部要填它', () =>
    assert.ok(logs.join('\n').includes(result.syncToken)))
  check('同步口令与 Cloudflare Token 是两个独立的值', () =>
    assert.notEqual(result.syncToken, TOKEN))
  check('另外打印了口令指纹，方便核对', () =>
    assert.ok(logs.join('\n').includes('口令指纹')))
  check('口令足够长，不易被猜', () => assert.ok(result.syncToken.length >= 30))

  group('重复部署')
  const secondLogs = []
  const second = await runDeployWorker({
    token: TOKEN, apiBase, tokenFile, log: (m) => secondLogs.push(String(m)),
  })
  check('复用已有的 KV 命名空间，不再新建', () => assert.equal(mock.state.namespaces.length, 1))
  check('口令保持不变（否则快捷指令和应用都要改）', () =>
    assert.equal(second.syncToken, result.syncToken))
  check('识别出命名空间已存在', () =>
    assert.ok(secondLogs.join('\n').includes('已存在')))
  check('第二次仍然上传脚本', () => assert.equal(mock.state.scriptUploads.length, 2))

  await new Promise((r) => mock.server.close(r))
}

// ── C. 出错时的表现 ─────────────────────────────────────────────────────

group('出错时要说清楚，而不是丢一句 HTTP 错误')
{
  const badMock = createMockCloudflare({ tokenValid: false })
  const port = await listen(badMock.server)

  let error = null
  await checkAsync('Token 无效 → 抛错', async () => {
    try {
      await runDeployWorker({
        token: 'bad', apiBase: `http://127.0.0.1:${port}`, tokenFile: join(TMP, 't2'),
        log: () => {},
      })
    } catch (e) {
      error = e
    }
    assert.ok(error)
  })
  check('错误里带上了 Cloudflare 的原始说明', () =>
    assert.ok(error.message.includes('Invalid API Token'), `实际：${error.message}`))

  await new Promise((r) => badMock.server.close(r))

  // 子域没开通时应当明确报错
  const noSubMock = createMockCloudflare()
  noSubMock.state.subdomain = null
  const port2 = await listen(noSubMock.server)
  let error2 = null
  await checkAsync('读不到 workers.dev 子域 → 明确报错并给出下一步', async () => {
    try {
      await runDeployWorker({
        token: TOKEN, apiBase: `http://127.0.0.1:${port2}`, tokenFile: join(TMP, 't3'),
        log: () => {},
      })
    } catch (e) {
      error2 = e
    }
    assert.ok(error2)
    assert.ok(error2.message.includes('workers.dev'))
  })
  await new Promise((r) => noSubMock.server.close(r))
}

rmSync(TMP, { recursive: true, force: true })

console.log(`\n${'─'.repeat(52)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
