#!/usr/bin/env node
/**
 * 中继（Cloudflare Worker）的测试。
 *
 * Worker 的 fetch 处理函数是纯的 —— 它只依赖 request 和 env，而 KV 可以用
 * 一个 Map 模拟。所以整条链路能在本地跑测试，不需要 Cloudflare 账号，
 * 也不会往云上写任何东西。
 *
 * 运行：node tools/test-worker.mjs
 */

import assert from 'node:assert/strict'
import { handleRequest, normalizeRecord } from '../worker/index.js'

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

// ── 模拟 KV ─────────────────────────────────────────────────────────────

function createMockKv() {
  const store = new Map()
  return {
    store,
    async put(key, value) {
      store.set(key, value)
    },
    async get(key) {
      return store.has(key) ? store.get(key) : null
    },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...store.keys()]
        .filter((name) => name.startsWith(prefix))
        .slice(0, limit)
        .map((name) => ({ name }))
      return { keys, list_complete: true }
    },
  }
}

const TOKEN = 'test-secret-token-abcdefghijklmnop'
const BASE = 'https://relay.example.workers.dev'

function makeEnv(overrides = {}) {
  return { CARLORIES: createMockKv(), SYNC_TOKEN: TOKEN, ...overrides }
}

function req(path, { method = 'GET', body = null, token = TOKEN, origin = 'https://sier7.github.io' } = {}) {
  const headers = { origin }
  if (token !== null) headers.authorization = `Bearer ${token}`
  if (body !== null) headers['content-type'] = 'application/json'
  return new Request(`${BASE}${path}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  })
}

const FIXED_NOW = new Date('2026-10-03T14:00:00Z') // UTC+8 时是 10-03 22:00

// ── 鉴权 ────────────────────────────────────────────────────────────────

group('鉴权')
await checkAsync('预检请求（OPTIONS）不需要口令，且带回 CORS 头', async () => {
  const res = await handleRequest(req('/ingest', { method: 'OPTIONS', token: null }), makeEnv())
  assert.equal(res.status, 204)
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://sier7.github.io')
  assert.ok(res.headers.get('access-control-allow-headers').includes('authorization'))
})

await checkAsync('没有口令 → 401', async () => {
  const res = await handleRequest(req('/days', { token: null }), makeEnv())
  assert.equal(res.status, 401)
})

await checkAsync('口令错误 → 401', async () => {
  const res = await handleRequest(req('/days', { token: 'wrong-token-wrong-token-wrong' }), makeEnv())
  assert.equal(res.status, 401)
})

await checkAsync('口令长度不同也拒绝', async () => {
  const res = await handleRequest(req('/days', { token: 'short' }), makeEnv())
  assert.equal(res.status, 401)
})

await checkAsync('口令正确 → 放行', async () => {
  const res = await handleRequest(req('/health'), makeEnv())
  assert.equal(res.status, 200)
})

await checkAsync('没绑 KV 时明确报错，而不是静默什么都没存', async () => {
  const res = await handleRequest(req('/health'), { SYNC_TOKEN: TOKEN })
  assert.equal(res.status, 500)
  assert.ok((await res.json()).error.includes('KV'))
})

await checkAsync('没设口令时明确报错（否则等于人人可读）', async () => {
  const res = await handleRequest(req('/health'), { CARLORIES: createMockKv() })
  assert.equal(res.status, 500)
  assert.ok((await res.json()).error.includes('SYNC_TOKEN'))
})

// ── 上报 ────────────────────────────────────────────────────────────────

group('上报')
await checkAsync('存下一条记录', async () => {
  const env = makeEnv()
  const res = await handleRequest(
    req('/ingest', { method: 'POST', body: { date: '2026-10-03', activeKcal: 842, restingKcal: 1710 } }),
    env,
  )
  assert.equal(res.status, 200)
  assert.deepEqual((await res.json()).stored, ['2026-10-03'])
  assert.ok(env.CARLORIES.store.has('day:2026-10-03'))
})

await checkAsync('★ date 写 "today" 时由服务器补日期（快捷指令因此不必碰格式化日期）', async () => {
  const env = makeEnv()
  const res = await handleRequest(
    req('/ingest', { method: 'POST', body: { date: 'today', activeKcal: 500, restingKcal: 1600 } }),
    env,
    FIXED_NOW,
  )
  assert.equal(res.status, 200)
  assert.deepEqual((await res.json()).stored, ['2026-10-03'])
})

await checkAsync('today 按配置的时区算，而不是 UTC', async () => {
  // 2026-10-03T16:30Z 在 UTC 是 3 号，在东八区已经是 4 号 00:30
  const lateNight = new Date('2026-10-03T16:30:00Z')
  const env = makeEnv()
  await handleRequest(
    req('/ingest', { method: 'POST', body: { date: 'today', activeKcal: 1 } }),
    env,
    lateNight,
  )
  assert.ok(env.CARLORIES.store.has('day:2026-10-04'))
})

await checkAsync('同一天重复上报是覆盖，不是累加（定时任务可以反复跑）', async () => {
  const env = makeEnv()
  await handleRequest(req('/ingest', { method: 'POST', body: { date: '2026-10-03', activeKcal: 100 } }), env)
  await handleRequest(req('/ingest', { method: 'POST', body: { date: '2026-10-03', activeKcal: 900 } }), env)
  const stored = JSON.parse(env.CARLORIES.store.get('day:2026-10-03'))
  assert.equal(stored.activeKcal, 900)
  assert.equal(env.CARLORIES.store.size, 1)
})

await checkAsync('接受 { records: [...] } 形式（补录多天）', async () => {
  const env = makeEnv()
  const res = await handleRequest(
    req('/ingest', {
      method: 'POST',
      body: { records: [
        { date: '2026-10-01', activeKcal: 900, restingKcal: 1690 },
        { date: '2026-10-02', activeKcal: 950, restingKcal: 1700 },
      ] },
    }),
    env,
  )
  assert.equal((await res.json()).stored.length, 2)
  assert.equal(env.CARLORIES.store.size, 2)
})

await checkAsync('接受裸数组', async () => {
  const env = makeEnv()
  const res = await handleRequest(
    req('/ingest', { method: 'POST', body: [{ date: '2026-10-01', activeKcal: 900 }] }),
    env,
  )
  assert.equal((await res.json()).stored.length, 1)
})

await checkAsync('接受 act / rst 简写（快捷指令里少打几个字）', async () => {
  const env = makeEnv()
  await handleRequest(req('/ingest', { method: 'POST', body: { date: '2026-10-03', act: 842, rst: 1710 } }), env)
  const stored = JSON.parse(env.CARLORIES.store.get('day:2026-10-03'))
  assert.equal(stored.activeKcal, 842)
  assert.equal(stored.restingKcal, 1710)
})

await checkAsync('只有一项也能存（表没戴满一天）', async () => {
  const env = makeEnv()
  const res = await handleRequest(req('/ingest', { method: 'POST', body: { date: '2026-10-03', activeKcal: 300 } }), env)
  assert.equal(res.status, 200)
})

group('上报：坏数据被挡在外面')
await checkAsync('日期格式不对 → 拒绝', async () => {
  const env = makeEnv()
  const res = await handleRequest(req('/ingest', { method: 'POST', body: { date: '10/03/2026', activeKcal: 500 } }), env)
  assert.equal(res.status, 400)
  assert.equal(env.CARLORIES.store.size, 0)
})

await checkAsync('两项都空 → 拒绝', async () => {
  const res = await handleRequest(req('/ingest', { method: 'POST', body: { date: '2026-10-03' } }), makeEnv())
  assert.equal(res.status, 400)
})

await checkAsync('负数 → 拒绝', async () => {
  const res = await handleRequest(req('/ingest', { method: 'POST', body: { date: '2026-10-03', activeKcal: -5 } }), makeEnv())
  assert.equal(res.status, 400)
})

await checkAsync('请求体不是 JSON → 400 而不是崩', async () => {
  const request = new Request(`${BASE}/ingest`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: '这不是 json',
  })
  const res = await handleRequest(request, makeEnv())
  assert.equal(res.status, 400)
})

await checkAsync('一批里坏一条时，好的仍然存下来并报告坏的那条', async () => {
  const env = makeEnv()
  const res = await handleRequest(
    req('/ingest', {
      method: 'POST',
      body: { records: [
        { date: '2026-10-01', activeKcal: 900 },
        { date: 'bad-date', activeKcal: 900 },
      ] },
    }),
    env,
  )
  const body = await res.json()
  assert.equal(body.stored.length, 1)
  assert.equal(body.problems.length, 1)
})

// ── 读取 ────────────────────────────────────────────────────────────────

group('读取')
await checkAsync('取回全部记录，按日期升序', async () => {
  const env = makeEnv()
  await handleRequest(req('/ingest', { method: 'POST', body: { records: [
    { date: '2026-10-03', activeKcal: 800, restingKcal: 1700 },
    { date: '2026-10-01', activeKcal: 900, restingKcal: 1690 },
    { date: '2026-10-02', activeKcal: 850, restingKcal: 1695 },
  ] } }), env)

  const res = await handleRequest(req('/days'), env)
  const body = await res.json()
  assert.equal(body.count, 3)
  assert.deepEqual(body.records.map((r) => r.date), ['2026-10-01', '2026-10-02', '2026-10-03'])
})

await checkAsync('from / to 过滤（含两端）', async () => {
  const env = makeEnv()
  await handleRequest(req('/ingest', { method: 'POST', body: { records: [
    { date: '2026-10-01', activeKcal: 900 },
    { date: '2026-10-02', activeKcal: 850 },
    { date: '2026-10-03', activeKcal: 800 },
  ] } }), env)

  const res = await handleRequest(req('/days?from=2026-10-02&to=2026-10-03'), env)
  assert.deepEqual((await res.json()).records.map((r) => r.date), ['2026-10-02', '2026-10-03'])
})

await checkAsync('没有数据时返回空数组，而不是报错', async () => {
  const res = await handleRequest(req('/days'), makeEnv())
  assert.deepEqual((await res.json()).records, [])
})

await checkAsync('坏掉的存储内容被跳过，不拖垮整个请求', async () => {
  const env = makeEnv()
  await handleRequest(req('/ingest', { method: 'POST', body: { date: '2026-10-01', activeKcal: 900 } }), env)
  env.CARLORIES.store.set('day:2026-10-02', '{坏掉的 json')
  const res = await handleRequest(req('/days'), env)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).count, 1)
})

group('其他')
await checkAsync('未知路径 → 404', async () => {
  const res = await handleRequest(req('/nope'), makeEnv())
  assert.equal(res.status, 404)
})

await checkAsync('用 GET 访问 /ingest → 404（不误处理）', async () => {
  const res = await handleRequest(req('/ingest'), makeEnv())
  assert.equal(res.status, 404)
})

await checkAsync('响应带 CORS 头，否则浏览器会拒绝读取', async () => {
  const res = await handleRequest(req('/days'), makeEnv())
  assert.ok(res.headers.get('access-control-allow-origin'))
})

group('normalizeRecord 单独可用')
check('合法记录', () => {
  const r = normalizeRecord({ date: '2026-10-03', activeKcal: 1, restingKcal: 2 }, { now: FIXED_NOW })
  assert.deepEqual([r.date, r.activeKcal, r.restingKcal], ['2026-10-03', 1, 2])
})
check('非对象 → null', () => assert.equal(normalizeRecord('x'), null))
check('带千分位逗号的字符串照样解析', () =>
  assert.equal(normalizeRecord({ date: '2026-10-03', activeKcal: '1,842' }).activeKcal, 1842))

console.log(`\n${'─'.repeat(52)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
