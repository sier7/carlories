/**
 * Carlories 健康数据中继 —— Cloudflare Worker。
 *
 * 它解决的问题：iOS 上网页应用读剪贴板必须由用户手势触发，所以「数据自动
 * 进到应用里」这件事在纯网页方案里做不到零点击。
 *
 * 办法是在中间放一个只做转发的小服务：
 *
 *   快捷指令（定时自动跑）--POST--> 这里 <--GET-- 应用（打开时自动拉）
 *
 * 于是应用不需要读剪贴板，也就不需要任何点击。
 *
 * 存的是什么：**每天两个整数**（活动能量、静息能量）加一个日期。
 * 不是健康记录，不是样本，没有心率、睡眠、位置。数据保留 400 天。
 *
 * 接口：
 *   POST /ingest   { date: "today" | "YYYY-MM-DD", activeKcal, restingKcal }
 *                  也接受 { records: [...] } 或直接一个数组
 *   GET  /days?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   GET  /health   连通性自检
 *
 * 鉴权：所有请求都要带 Authorization: Bearer <SYNC_TOKEN>。
 */

const DAY_PREFIX = 'day:'
const TTL_SECONDS = 400 * 24 * 60 * 60
const DEFAULT_TZ_OFFSET = 8

// ── 小工具 ──────────────────────────────────────────────────────────────

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
  }
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders(origin),
    },
  })
}

/** 定长比较，避免用响应时间把口令一位一位试出来 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length === 0 || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function bearerToken(request) {
  const header = request.headers.get('authorization') || ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[,，\s]/g, ''))
  return isFinite(n) ? n : null
}

/**
 * 算出「当地今天是几号」。
 *
 * 快捷指令里生成 yyyy-MM-dd 要经过「格式化日期」动作，而那一步是整个快捷
 * 指令里最容易配错的地方（格式串写错就得到一个非法日期，报错还指不到那里）。
 * 所以让载荷直接写 "today"，由这里补上日期。
 */
function localToday(offsetHours, now) {
  const offset = Number.isFinite(Number(offsetHours)) ? Number(offsetHours) : DEFAULT_TZ_OFFSET
  const shifted = new Date((now ? now.getTime() : Date.now()) + offset * 3600 * 1000)
  return shifted.toISOString().slice(0, 10)
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** 把一条外来记录规整成能存的样子；不合法返回 null */
export function normalizeRecord(raw, { tzOffset = DEFAULT_TZ_OFFSET, now = null } = {}) {
  if (!raw || typeof raw !== 'object') return null

  let date = String(raw.date ?? '').trim()
  if (date.toLowerCase() === 'today') date = localToday(tzOffset, now)
  if (!DATE_PATTERN.test(date)) return null

  const active = numberOrNull(raw.activeKcal ?? raw.act)
  const resting = numberOrNull(raw.restingKcal ?? raw.rst)
  if (active === null && resting === null) return null
  if ((active !== null && active < 0) || (resting !== null && resting < 0)) return null

  return {
    date,
    activeKcal: active,
    restingKcal: resting,
    updatedAt: (now ? new Date(now) : new Date()).toISOString(),
  }
}

// ── 路由 ────────────────────────────────────────────────────────────────

export async function handleRequest(request, env, now = null) {
  const origin = request.headers.get('origin') || '*'

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) })
  }

  if (!env || !env.CARLORIES) {
    return json({ error: '中继没有绑定 KV 存储' }, 500, origin)
  }
  if (!env.SYNC_TOKEN) {
    return json({ error: '中继没有设置 SYNC_TOKEN' }, 500, origin)
  }
  if (!safeEqual(bearerToken(request) || '', env.SYNC_TOKEN)) {
    return json({ error: 'unauthorized' }, 401, origin)
  }

  const url = new URL(request.url)
  const tzOffset = env.TZ_OFFSET_HOURS

  if (url.pathname === '/ingest' && request.method === 'POST') {
    return ingest(request, env, origin, { tzOffset, now })
  }
  if (url.pathname === '/days' && request.method === 'GET') {
    return listDays(url, env, origin)
  }
  if (url.pathname === '/health') {
    return json({ ok: true }, 200, origin)
  }
  return json({ error: 'not found' }, 404, origin)
}

async function ingest(request, env, origin, { tzOffset, now }) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: '请求体不是 JSON' }, 400, origin)
  }

  const incoming = Array.isArray(body)
    ? body
    : Array.isArray(body && body.records)
      ? body.records
      : [body]

  const stored = []
  const problems = []

  for (const raw of incoming) {
    const record = normalizeRecord(raw, { tzOffset, now })
    if (!record) {
      problems.push(`记录不合法：${JSON.stringify(raw).slice(0, 100)}`)
      continue
    }
    // 日期做键 —— 同一天重复上报天然幂等，这正是定时任务可以反复跑的前提
    await env.CARLORIES.put(DAY_PREFIX + record.date, JSON.stringify(record), {
      expirationTtl: TTL_SECONDS,
    })
    stored.push(record.date)
  }

  if (stored.length === 0) {
    return json({ error: '没有任何一条可用记录', problems }, 400, origin)
  }
  return json({ stored, problems }, 200, origin)
}

async function listDays(url, env, origin) {
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')

  const listed = await env.CARLORIES.list({ prefix: DAY_PREFIX, limit: 1000 })
  const dates = listed.keys
    .map((key) => key.name.slice(DAY_PREFIX.length))
    .filter((date) => (!from || date >= from) && (!to || date <= to))
    .sort()

  const records = []
  for (const date of dates) {
    const raw = await env.CARLORIES.get(DAY_PREFIX + date)
    if (!raw) continue
    try {
      records.push(JSON.parse(raw))
    } catch {
      // 坏数据跳过而不是让整个请求失败
    }
  }

  return json({ records, count: records.length }, 200, origin)
}

export default {
  fetch(request, env) {
    return handleRequest(request, env)
  },
}
