#!/usr/bin/env node
/**
 * 一键部署到 GitHub Pages。
 *
 * 为什么不用 git：这台机器上没装 git，而这个操作本质上就是「把一堆文件
 * 推到仓库里」，用 GitHub 的 REST API 直接做，不需要任何本地工具链。
 *
 * 缺点也要说清楚：每次都是全量 PUT，没有增量、没有历史 diff。
 * 对个人项目够用；等你哪天想要真正的版本管理，装个 git 再切过去。
 *
 * 用法：
 *   1. 在 GitHub 上生成一个 Personal Access Token（classic，勾选 repo 即可）
 *         https://github.com/settings/tokens/new?scopes=repo&description=carlories-deploy
 *   2. 把 token 存成 <项目根>/.github-token（已被 .gitignore 忽略）
 *      或设环境变量 GITHUB_TOKEN
 *   3. node tools/deploy.mjs
 *
 *   附加参数：
 *     --check     只验证 token 和仓库，不上传
 *     --name=xxx  指定仓库名（默认 carlories）
 *
 * 环境变量 GITHUB_API_BASE 可以替换 API 地址，用于对着模拟服务器做测试
 * （见 tools/test-deploy.mjs）。这是这段代码唯一能脱离真实 GitHub 验证的办法，
 * 而它是你和应用之间唯一的障碍，值得测。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const DEFAULT_API = 'https://api.github.com'
export const DEFAULT_REPO = 'carlories'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const APP_DIR = join(ROOT, 'app')

// ── 收集要上传的文件 ────────────────────────────────────────────────────
//
// app/ 里的文件在仓库里是**平铺在根目录**的 —— 因为 GitHub Pages 从仓库
// 根目录发布，而站点根目录必须正好是 index.html。
// tools/ 和 docs/ 按原样上传，方便你在 GitHub 网页上直接看。

function walk(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, base))
    } else {
      out.push(relative(base, full).split(sep).join('/'))
    }
  }
  return out
}

export function collectFiles(root = ROOT) {
  const appDir = join(root, 'app')
  const files = []

  for (const rel of walk(appDir)) {
    files.push({ repoPath: rel, localPath: join(appDir, rel), site: true })
  }

  // .nojekyll：不让 GitHub Pages 拿 Jekyll 处理这些文件
  files.push({ repoPath: '.nojekyll', content: Buffer.from(''), site: true })

  for (const rel of ['README.md', '.gitignore', 'package.json']) {
    const full = join(root, rel)
    if (existsSync(full)) files.push({ repoPath: rel, localPath: full, site: false })
  }
  for (const dir of ['tools', 'docs']) {
    const full = join(root, dir)
    if (!existsSync(full)) continue
    for (const rel of walk(full)) {
      files.push({ repoPath: `${dir}/${rel}`, localPath: join(full, rel), site: false })
    }
  }

  return files
}

export function contentOf(file) {
  if (file.content) return file.content
  return readFileSync(file.localPath)
}

// ── GitHub API 客户端 ───────────────────────────────────────────────────

export function createClient({ token, apiBase = DEFAULT_API }) {
  async function api(method, path, body) {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'carlories-deploy',
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
      const error = new Error(
        `${method} ${path} → ${response.status} ${json && json.message ? json.message : ''}`,
      )
      error.status = response.status
      error.payload = json
      throw error
    }
    return json
  }

  return { api }
}

// ── 主流程 ──────────────────────────────────────────────────────────────

export async function runDeploy({
  token,
  repoName = DEFAULT_REPO,
  checkOnly = false,
  apiBase = DEFAULT_API,
  root = ROOT,
  log = console.log,
} = {}) {
  const { api } = createClient({ token, apiBase })

  log('验证 token…')
  const user = await api('GET', '/user')
  const owner = user.login
  log(`  已登录：${owner}`)

  log(`检查仓库 ${owner}/${repoName} …`)
  let repoExists = true
  try {
    await api('GET', `/repos/${owner}/${repoName}`)
    log('  已存在，将更新其中的文件')
  } catch (error) {
    if (error.status !== 404) throw error
    repoExists = false
    log('  不存在，需要创建')
  }

  const url = `https://${owner}.github.io/${repoName}/`

  if (checkOnly) {
    log('\n--check 模式，到此为止。')
    log(`部署后将访问：${url}`)
    return { owner, repoName, url, uploaded: 0, failed: 0, checked: true }
  }

  if (!repoExists) {
    log('创建公开仓库…')
    await api('POST', '/user/repos', {
      name: repoName,
      description: '个人卡路里与营养记录应用',
      private: false,
      auto_init: false,
      has_issues: false,
      has_wiki: false,
      has_projects: false,
    })
    log('  已创建')
    await new Promise((r) => setTimeout(r, 1500))
  }

  const files = collectFiles(root)
  const siteCount = files.filter((f) => f.site).length
  log(`\n准备上传 ${files.length} 个文件（其中 ${siteCount} 个属于站点）…`)

  let uploaded = 0
  const failures = []

  for (const file of files) {
    const path = `/repos/${owner}/${repoName}/contents/${file.repoPath}`
    let sha
    try {
      const existing = await api('GET', path)
      sha = existing && existing.sha
    } catch (error) {
      if (error.status !== 404) throw error
    }

    try {
      await api('PUT', path, {
        message: sha ? `更新 ${file.repoPath}` : `添加 ${file.repoPath}`,
        content: contentOf(file).toString('base64'),
        ...(sha ? { sha } : {}),
      })
      uploaded++
    } catch (error) {
      failures.push({ path: file.repoPath, message: error.message })
    }
  }

  log(`  已上传 ${uploaded}/${files.length}`)
  for (const failure of failures) log(`  ✗ ${failure.path}：${failure.message}`)

  log('\n开启 GitHub Pages…')
  try {
    await api('POST', `/repos/${owner}/${repoName}/pages`, {
      source: { branch: 'main', path: '/' },
    })
    log('  已开启')
  } catch (error) {
    if (error.status === 409) {
      log('  之前已开启，跳过')
    } else {
      log(`  开启失败：${error.message}`)
      log('  可以手动去 Settings → Pages 里把 Source 设为 main / (root)')
    }
  }

  log(`
${'─'.repeat(56)}
上传 ${uploaded} 个文件${failures.length > 0 ? `，${failures.length} 个失败` : ''}。

  你的应用地址：${url}

首次发布通常需要 1–3 分钟。之后每次运行本脚本更新，大约 1 分钟生效。

在 iPhone 上：
  1. 用 Safari 打开上面的地址（必须 Safari，Chrome 装不了）
  2. 点底部分享按钮 → 「添加到主屏幕」
  3. 之后从主屏幕图标打开，就是全屏的应用
${'─'.repeat(56)}`)

  return { owner, repoName, url, uploaded, failed: failures.length, files, failures }
}

// ── CLI ─────────────────────────────────────────────────────────────────

function readToken(root = ROOT) {
  if (process.env.GITHUB_TOKEN) return parseToken(process.env.GITHUB_TOKEN)
  const tokenFile = join(root, '.github-token')
  if (existsSync(tokenFile)) return parseToken(readFileSync(tokenFile, 'utf8'))
  return null
}

/**
 * 从文件内容里挑出 token。
 *
 * 这个文件是人手工粘的，所以不能假设里面干干净净只有一串字符 ——
 * 常见情况：带着引号、前后有空行、复制时多带了一行说明文字。
 * 与其让人反复检查格式，不如这里宽容一点。
 */
export function parseToken(raw) {
  if (typeof raw !== 'string') return null
  const match = /(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})/.exec(raw)
  if (match) return match[0]

  // 兜底：只接受「看起来就是一串凭据」的内容 —— 没有空白、长度合理。
  // 否则用户还没填 token 时，文件里的说明文字会被整段当成 token 发出去，
  // 结果是一个令人困惑的 401，而真实原因是「你还没填」。
  const trimmed = raw.trim().replace(/^["'`]|["'`]$/g, '')
  if (trimmed.length >= 20 && !/\s/.test(trimmed)) return trimmed
  return null
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
  const args = process.argv.slice(2)
  const checkOnly = args.includes('--check')
  const repoName = (args.find((a) => a.startsWith('--name=')) || `--name=${DEFAULT_REPO}`).slice(7)
  const token = readToken()

  if (!token) {
    console.error(`
没有找到 GitHub token。需要两步：

  1. 打开这个链接生成一个 token（只勾 repo 就够了）：
     https://github.com/settings/tokens/new?scopes=repo&description=carlories-deploy

  2. 把生成的 token 粘贴保存到：
     ${join(ROOT, '.github-token')}

     或者设成环境变量 GITHUB_TOKEN

token 只会用于创建仓库和上传文件，不会出现在任何输出里。
`.trim())
    process.exit(1)
  }

  runDeploy({
    token,
    repoName,
    checkOnly,
    apiBase: process.env.GITHUB_API_BASE || DEFAULT_API,
  }).catch((error) => {
    console.error(`\n失败：${error.message}`)
    if (error.status === 401) console.error('token 无效或已过期，重新生成一个再试。')
    if (error.status === 403) console.error('token 权限不足。用 classic token 并勾选 repo。')
    if (error.status === 422) {
      console.error('多半是仓库名已被占用，或者 token 没有创建仓库的权限。')
      console.error('可以加 --name=别的名字 换一个。')
    }
    process.exit(1)
  })
}
