#!/usr/bin/env node
/**
 * 部署中继到 Cloudflare Workers。
 *
 * 走 Cloudflare 的 REST API，不需要装 wrangler，也不需要 npm。
 *
 * 需要你准备两样东西：
 *   1. 一个 Cloudflare API Token（自定义 token，权限见下面的链接说明）
 *   2. 你的 Cloudflare Account ID（可以留空，脚本会自己去找）
 *
 * 把它们存成 <项目根>/.cloudflare：
 *
 *   第一行：API Token
 *   第二行：（可选）Account ID
 *
 * 然后 node tools/deploy-worker.mjs
 *
 * 脚本会：找到或创建 KV 命名空间 → 生成一个同步口令 → 上传 Worker → 打开
 * workers.dev 子域 → 打印一条「配置串」。
 * 那条配置串粘进应用就能用，不用在手机上打长串字符。
 *
 * 口令保存在 .relay-token 里，重复部署会沿用同一个，所以快捷指令和应用
 * 不需要每次改。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const CF_API = 'https://api.cloudflare.com/client/v4'
export const WORKER_NAME = 'carlories-relay'
export const KV_TITLE = 'carlories-sync'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const CRED_FILE = join(ROOT, '.cloudflare')
const TOKEN_FILE = join(ROOT, '.relay-token')
const SCRIPT_FILE = join(ROOT, 'worker', 'index.js')

// ── 凭据 ────────────────────────────────────────────────────────────────

export function parseCredentials(raw) {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))

  const token = lines.find((line) => line.length >= 20 && !/^[0-9a-f]{32}$/i.test(line)) || null
  const accountId = lines.find((line) => /^[0-9a-f]{32}$/i.test(line)) || null
  return { token, accountId }
}

// ── Cloudflare API 客户端 ───────────────────────────────────────────────

export function createClient({ token, apiBase = CF_API }) {
  async function call(method, path, { body, form } = {}) {
    const headers = {
      authorization: `Bearer ${token}`,
      'user-agent': 'carlories-relay-deploy',
    }
    if (body) headers['content-type'] = 'application/json'

    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers,
      body: form || (body ? JSON.stringify(body) : undefined),
    })

    const text = await response.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = { raw: text }
    }

    if (!response.ok || (json && json.success === false)) {
      const detail = json && Array.isArray(json.errors) && json.errors.length > 0
        ? json.errors.map((e) => `${e.code}: ${e.message}`).join('; ')
        : `HTTP ${response.status}`
      const error = new Error(`${method} ${path} → ${detail}`)
      error.status = response.status
      error.payload = json
      throw error
    }
    return json ? json.result : null
  }

  return { call }
}

// ── 主流程 ──────────────────────────────────────────────────────────────

export async function runDeployWorker({
  token,
  accountId = null,
  apiBase = CF_API,
  scriptFile = SCRIPT_FILE,
  tokenFile = TOKEN_FILE,
  tzOffsetHours = 8,
  log = console.log,
} = {}) {
  const { call } = createClient({ token, apiBase })

  log('验证 API Token…')
  const verified = await call('GET', '/user/tokens/verify')
  if (!verified || verified.status !== 'active') {
    throw new Error(`Token 状态是「${verified && verified.status}」，不是 active`)
  }
  log('  有效')

  log('确定 Account ID…')
  let account = accountId
  if (!account) {
    const accounts = await call('GET', '/accounts')
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error('这个 Token 读不到任何账号。请在 .cloudflare 第二行直接填 Account ID。')
    }
    if (accounts.length > 1) {
      log(`  这个 Token 下有 ${accounts.length} 个账号，用第一个：${accounts[0].name}`)
    }
    account = accounts[0].id
  }
  log(`  ${account}`)

  log('找到或创建 KV 命名空间…')
  const namespaces = (await call('GET', `/accounts/${account}/storage/kv/namespaces`)) || []
  let namespace = namespaces.find((ns) => ns.title === KV_TITLE)
  if (namespace) {
    log(`  已存在：${namespace.id}`)
  } else {
    namespace = await call('POST', `/accounts/${account}/storage/kv/namespaces`, {
      body: { title: KV_TITLE },
    })
    log(`  已创建：${namespace.id}`)
  }

  log('准备同步口令…')
  let syncToken
  if (existsSync(tokenFile)) {
    syncToken = readFileSync(tokenFile, 'utf8').trim()
    log('  沿用 .relay-token 里已有的口令')
  } else {
    syncToken = randomBytes(24).toString('base64url')
    writeFileSync(tokenFile, `${syncToken}\n`, 'utf8')
    log('  已生成并保存到 .relay-token')
  }

  log('上传 Worker…')
  const code = readFileSync(scriptFile, 'utf8')
  const metadata = {
    main_module: 'index.js',
    compatibility_date: '2024-09-23',
    bindings: [
      { type: 'kv_namespace', name: 'CARLORIES', namespace_id: namespace.id },
      { type: 'plain_text', name: 'SYNC_TOKEN', text: syncToken },
      { type: 'plain_text', name: 'TZ_OFFSET_HOURS', text: String(tzOffsetHours) },
    ],
  }

  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  form.append(
    'index.js',
    new Blob([code], { type: 'application/javascript+module' }),
    'index.js',
  )

  await call('PUT', `/accounts/${account}/workers/scripts/${WORKER_NAME}`, { form })
  log('  已上传')

  log('打开 workers.dev 子域…')
  try {
    await call('POST', `/accounts/${account}/workers/scripts/${WORKER_NAME}/subdomain`, {
      body: { enabled: true, previews_enabled: false },
    })
    log('  已打开')
  } catch (error) {
    log(`  打开失败：${error.message}`)
    log('  可以手动去 Workers 面板里把 Workers.dev 路由打开')
  }

  const sub = await call('GET', `/accounts/${account}/workers/subdomain`)
  const subdomain = sub && sub.subdomain
  if (!subdomain) {
    throw new Error('读不到 workers.dev 子域，请去面板里确认它已经开通')
  }

  const url = `https://${WORKER_NAME}.${subdomain}.workers.dev`
  // 一条配置串，粘进应用即可。避免在手机上敲长串字符。
  const configString = `carlories-relay:v1|${url}|${syncToken}`
  const fingerprint = createHash('sha256').update(syncToken).digest('hex').slice(0, 8)

  log(`
${'─'.repeat(60)}
中继已部署。

  地址：${url}
  口令指纹：${fingerprint}（前 8 位，用于核对，不是口令本身）

把下面这一整行复制下来，粘进手机的「今日 → 同步设置 → 中继配置」：

${configString}

同步口令（就是上面这行里最后一个 | 之后的部分；快捷指令的 Authorization
头部要用它，所以单独列一份方便复制）：

${syncToken}

${'─'.repeat(60)}
下一步：改快捷指令

  把原来的「拷贝到剪贴板」换成（或再加一个）「获取 URL 内容」：

    网址：${url}/ingest
    方法：POST
    头部：Authorization = Bearer <上面那个同步口令>
    请求体：JSON
      date         = today        ← 照字面打，服务器会补上日期
      activeKcal   = [活动能量的统计结果]
      restingKcal  = [静息能量的统计结果]

  保留「拷贝到剪贴板」也没坏处 —— 中继连不上时应用还能从剪贴板兜底。
${'─'.repeat(60)}`)

  return { url, syncToken, configString, namespaceId: namespace.id, accountId: account }
}

// ── CLI ─────────────────────────────────────────────────────────────────

function isMainModule() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return resolve(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isMainModule()) {
  const creds = existsSync(CRED_FILE)
    ? parseCredentials(readFileSync(CRED_FILE, 'utf8'))
    : { token: process.env.CLOUDFLARE_API_TOKEN || null, accountId: process.env.CLOUDFLARE_ACCOUNT_ID || null }

  if (!creds.token) {
    console.error(`
没有找到 Cloudflare API Token。三步：

  1. 打开 https://dash.cloudflare.com/profile/api-tokens
     点「Create Token」→「Create Custom Token」，权限加两项：
       · 账户 · Workers KV Storage · 编辑
       · 账户 · Workers Scripts · 编辑
     （想省掉填 Account ID 的话，再加一项「账户 · Account Settings · 读取」）

  2. 打开 https://dash.cloudflare.com/ 右下角能看到 Account ID，
     或者进任意域名的 Overview 页面右侧也有。

  3. 新建文件 ${CRED_FILE}
     第一行：粘贴 API Token
     第二行：粘贴 Account ID（可留空）

然后重新运行本脚本。没有 Cloudflare 账号的话，注册是免费的。
`.trim())
    process.exit(1)
  }

  runDeployWorker({
    token: creds.token,
    accountId: creds.accountId,
    apiBase: process.env.CLOUDFLARE_API_BASE || CF_API,
  }).catch((error) => {
    console.error(`\n失败：${error.message}`)
    if (error.status === 401 || error.status === 403) {
      console.error('Token 权限不足或被拒。确认它勾选了 Workers KV Storage 和 Workers Scripts 的编辑权限。')
    }
    process.exit(1)
  })
}
