#!/usr/bin/env node
/**
 * 创建 Gist 信箱。
 *
 * 为什么用 Gist 当信箱（而不是普通仓库文件）：
 *   · Gist 按文件名覆盖，**不需要处理 sha** —— 快捷指令少一半动作
 *   · 不产生 commit 噪音，不碰你的代码仓库
 *   · 读一个公开 Gist 不需要任何凭据，所以**应用里没有口令**
 *
 * 为什么不用 Cloudflare Worker 之类：workers.dev 域名在国内被 DNS 污染，
 * 手机根本拉不到。见 docs/自动同步.md 里的说明。
 *
 * 用法：
 *   1. 生成一个只勾 gist 权限的 token：
 *        https://github.com/settings/tokens/new?scopes=gist&description=carlories-mailbox
 *   2. 存成 <项目根>/.github-gist-token（或设环境变量 GITHUB_GIST_TOKEN）
 *   3. node tools/setup-gist.mjs
 *
 * 重复运行会复用已有的信箱（id 存在 .gist-id 里），不会每次新建一个。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  GIST_FILENAME,
  GIST_PLACEHOLDER,
  extractGistContent,
  formatGistConfig,
} from '../app/core/healthSync.js'

export const DEFAULT_API = 'https://api.github.com'
export const GIST_DESCRIPTION = 'Carlories 健康数据信箱（应用只读，写入靠快捷指令）'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const TOKEN_FILE = join(ROOT, '.github-gist-token')
const ID_FILE = join(ROOT, '.gist-id')

/**
 * 初始内容。
 *
 * **不能为空或纯空白** —— GitHub 会以 422 拒绝没有内容的文件。
 * 也不能是任何像载荷的东西，否则应用会把它当数据读进去。
 */
const INITIAL_CONTENT = GIST_PLACEHOLDER

export function createClient({ token, apiBase = DEFAULT_API }) {
  async function call(method, path, body) {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'carlories-setup-gist',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    const text = await response.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = { raw: text }
    }

    if (!response.ok) {
      // GitHub 的 422 会把具体是哪个字段不合法放在 errors 里，只打印 message
      // 只会得到一句没用的「Validation Failed」。
      const details = json && Array.isArray(json.errors) && json.errors.length > 0
        ? json.errors
            .map((e) => [e.resource, e.field, e.code].filter(Boolean).join('.'))
            .join('; ')
        : null
      const error = new Error(
        `${method} ${path} → ${response.status} `
        + `${(json && json.message) || ''}${details ? `（${details}）` : ''}`,
      )
      error.status = response.status
      error.payload = json
      throw error
    }
    return json
  }

  return { call }
}

export async function runSetupGist({
  token,
  apiBase = DEFAULT_API,
  idFile = ID_FILE,
  log = console.log,
} = {}) {
  const { call } = createClient({ token, apiBase })

  log('验证 token…')
  const user = await call('GET', '/user')
  log(`  已登录：${user.login}`)

  let gistId = existsSync(idFile) ? readFileSync(idFile, 'utf8').trim() : null
  let gist = null

  if (gistId) {
    log(`检查已有信箱 ${gistId} …`)
    try {
      gist = await call('GET', `/gists/${gistId}`)
      log('  可用，继续用它')
    } catch (error) {
      if (error.status !== 404) throw error
      log('  这个信箱已经不在了，重新建一个')
      gistId = null
    }
  }

  if (!gist) {
    log('创建秘密 Gist…')
    gist = await call('POST', '/gists', {
      description: GIST_DESCRIPTION,
      public: false,
      files: { [GIST_FILENAME]: { content: INITIAL_CONTENT } },
    })
    gistId = gist.id
    writeFileSync(idFile, `${gistId}\n`, 'utf8')
    log(`  已创建：${gistId}`)
    log('  已保存到 .gist-id，重复运行会复用它')
  }

  const configString = formatGistConfig(gistId)
  const url = `https://gist.github.com/${user.login}/${gistId}`

  // 关键验证：应用是**不带任何凭据**去读这个 Gist 的。如果匿名读不到，
  // 整个方案就是假的 —— 所以这里就用和浏览器一模一样的方式读一次。
  log('\n验证匿名读取（应用就是这样读的，不带 token）…')
  try {
    const anonymous = await fetch(`${apiBase}/gists/${gistId}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'carlories-setup-gist' },
    })
    if (anonymous.ok) {
      const payload = await anonymous.json()
      const content = extractGistContent(payload)
      log(content
        ? '  读到了内容'
        : '  读得到（目前是占位符，所以应用会显示「还没有内容」，这是对的）')
    } else {
      log(`  ⚠ 匿名读取失败：HTTP ${anonymous.status}`)
      log('  这个信箱多半是公开的而不是秘密的，或者被限制了。应用可能读不到。')
    }
  } catch (error) {
    log(`  ⚠ 匿名读取出错：${error.message}`)
  }

  log(`
${'─'.repeat(62)}
信箱就绪。

  地址：${url}
  （秘密 Gist 不会被搜索到，但拿到链接的人能看。里面只有每天两个数字。）

配置串（复制这一整行）：

${configString}

${'─'.repeat(62)}
下一步：把它告诉应用

  iPhone 上打开应用 → 今日 → 同步设置 → 粘进「Gist 地址或 ID」→ 保存配置

${'─'.repeat(62)}
再下一步：改快捷指令，让它往信箱里写

  在「同步到 Carlories」里加一个「获取 URL 内容」：

    网址：${DEFAULT_API}/gists/${gistId}
    方法：PATCH
    头部：Authorization = Bearer <你刚才那个 gist token>
          Accept        = application/vnd.github+json
    请求体：JSON
    请求体内容（把两个方括号换成变量）：

      {"files":{"${GIST_FILENAME}":{"content":"CAL/TODAY ACT=[活动统计结果] RST=[静息统计结果]"}}}

  ⚠️ 整段 JSON 用**一个「文本」动作**手打即可，不需要搭嵌套字典。
     方括号那两处拖入「计算统计」的结果，它们应该是纯数字。

  改完手动跑一次，然后打开
    ${url}
  看 carlories.txt 里的内容对不对。对不上就把快捷指令的报错发我。

${'─'.repeat(62)}`)

  return { gistId, url, configString, owner: user.login }
}

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
  const token = process.env.GITHUB_GIST_TOKEN
    || (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').match(/gh[pousr]_[A-Za-z0-9_]{16,}/)?.[0] : null)

  if (!token) {
    console.error(`
没有找到 GitHub token。三步：

  1. 打开这个链接生成一个 token（只勾 gist 一项就够了）：
     https://github.com/settings/tokens/new?scopes=gist&description=carlories-mailbox

  2. 把生成的 token 粘贴保存到：
     ${TOKEN_FILE}

  3. 重新运行本脚本。

这个 token 只够读写你的 Gist，碰不到仓库和代码。它同时也要填进快捷指令，
所以留着别删。
`.trim())
    process.exit(1)
  }

  runSetupGist({ token, apiBase: process.env.GITHUB_API_BASE || DEFAULT_API }).catch((error) => {
    console.error(`\n失败：${error.message}`)
    if (error.status === 401) console.error('token 无效或已过期。')
    if (error.status === 403 || error.status === 404) {
      console.error('token 权限不足。确认它勾选了 gist。')
      console.error('（注意：repo 权限**不包含** gist，这两个是分开的。）')
    }
    printTlsHint(error)
    process.exit(1)
  })
}

/**
 * 这台机器上 github 域名被 hosts 指到了本地代理，而 Node 默认不读 Windows
 * 证书库，于是报一个跟真实原因毫无关系的「fetch failed」。把这个坑直接说出来。
 */
export function printTlsHint(error) {
  const message = `${error && error.message} ${(error && error.cause && error.cause.message) || ''}`
  if (!/fetch failed|certificate|UNABLE_TO_VERIFY/i.test(message)) return
  console.error(`
提示：这是证书问题，不是网络不通。

这台机器的 hosts 把 github 域名指到了本地代理，代理用自己的证书做中间人；
而 Node 默认只用自带的 CA 库，不读 Windows 证书库。加一个参数即可：

  node --use-system-ca tools/setup-gist.mjs

（或者用 npm run setup:gist —— 那个脚本里已经带上了这个参数。）`)
}
