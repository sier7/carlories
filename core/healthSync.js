/**
 * 健康数据同步：载荷解析 + Gist 信箱配置。
 *
 * ── 为什么用 Gist 当信箱 ────────────────────────────────────────────────
 * iOS 上网页应用读剪贴板必须由用户手势触发，所以「数据自动进到应用里」
 * 在纯网页方案里做不到零点击。中间放个服务就能解决，但 Cloudflare 的
 * workers.dev 域名在国内被 DNS 污染，用不了。
 *
 * GitHub 这条路是通的（应用本身就托管在 GitHub Pages 上）。用 Gist 而不是
 * 仓库文件，是因为两点：
 *   · Gist 按文件名覆盖，**不需要处理 sha** —— 快捷指令少一半动作
 *   · 不产生 commit 噪音
 * 而且读一个公开 Gist 不需要任何凭据，所以**口令只出现在快捷指令里，
 * 不进应用**。
 *
 * ── 载荷格式 ────────────────────────────────────────────────────────────
 * 纯文本，两种写法都认：
 *
 *   CAL/2026-10-03          CAL/TODAY ACT=842 RST=1710
 *   ACT=842
 *   RST=1710
 *
 * 单行写法是为了让快捷指令能用一个「文本」动作直接拼出整个 JSON 请求体，
 * 而不必去搭嵌套字典 —— 那是整个流程里最容易配错的地方。
 *
 * 日期可以写 TODAY，由应用补上当天。这样快捷指令也不必碰「格式化日期」。
 */

import { toNumberOrNull } from './food.js'

export const PAYLOAD_PREFIX = 'CAL/'
export const SOURCE_SHORTCUT = 'shortcut'
export const TODAY_TOKEN = 'TODAY'

const KILOJOULE_UNITS = /^(kj|千焦|千焦耳|kilojoule|kilojoules)$/i
const KCAL_UNITS = /^(kcal|cal|千卡|大卡|卡|卡路里|kilocalorie|kilocalories)$/i

/**
 * 一次性扫出所有可识别的记号。
 *
 * 用「扫描」而不是「逐行解析」，是因为这样两种写法（多行 / 单行）走同一
 * 条代码路径 —— 两套解析迟早会分叉。好处是也能把夹在中间看不懂的内容
 * 原样报出来，而不是静默丢掉。
 */
/**
 * 只认已知的单位词。
 *
 * 这里**不能**用 `[A-Za-z]*` 这种任意字母：单行写法里 `ACT=842 RST=1710` 的
 * 「842」后面跟着空格，任意字母的单位组会把 `RST` 当成单位吞掉，于是静息
 * 能量整个丢失。白名单之外的内容会落进「看不懂」报告里，那才是对的。
 */
const UNIT_WORDS = [
  'kilocalories', 'kilojoules', 'kilocalorie', 'kilojoule',
  'calories', 'calorie', 'kcal', 'cal', 'kj',
  '卡路里', '千卡', '千焦', '大卡',
].join('|')

const TOKEN_PATTERN = new RegExp(
  [
    String.raw`CAL\/(\d{4}-\d{2}-\d{2}|TODAY)`,
    // 值前后的空白只能用 [ \t]，不能用 \s —— \s 包含换行，会跨行吞掉下一个键。
    String.raw`(ACT|RST)[ \t]*[=:：][ \t]*(-?[\d][\d.,，]*)(?:[ \t]*(${UNIT_WORDS}))?`,
  ].join('|'),
  'gi',
)

/** 剪贴板里乱七八糟什么都有，先廉价地判断一下是不是我们的东西 */
export function looksLikeHealthPayload(text) {
  return typeof text === 'string' && /CAL\//i.test(text)
}

/**
 * 解析。返回 { records, problems }。
 *
 * 认得出的都认下来，认不出的逐条报告 —— 与食物表导入的「整体成功或整体
 * 失败」不同：那里是在覆盖你的档案，这里只是往几天的格子里填两个数，
 * 部分成功没有歧义。
 *
 * @param text 剪贴板内容或 Gist 文件内容
 * @param options.today 当天日期（YYYY-MM-DD）。载荷里用了 TODAY 却没给就会报错。
 */
export function parseHealthPayload(text, { today = null } = {}) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { records: [], problems: ['内容是空的'] }
  }
  if (!looksLikeHealthPayload(text)) {
    return {
      records: [],
      problems: ['内容不是健康数据（里面应该有 CAL/ 开头的日期）'],
    }
  }

  const source = String(text)
  const records = []
  const problems = []
  const junk = []
  let current = null

  const flush = () => {
    if (!current) return
    if (current.activeKcal === null && current.restingKcal === null) {
      problems.push(`${current.date} 既没有 ACT 也没有 RST，已跳过`)
    } else {
      records.push(current)
    }
    current = null
  }

  TOKEN_PATTERN.lastIndex = 0
  let match
  let consumed = 0

  while ((match = TOKEN_PATTERN.exec(source)) !== null) {
    const between = source.slice(consumed, match.index).trim()
    if (between !== '') junk.push(between)
    consumed = match.index + match[0].length

    if (match[1] !== undefined) {
      flush()
      const token = match[1].toUpperCase()
      let date = match[1]
      if (token === TODAY_TOKEN) {
        if (!today) {
          problems.push('载荷里写了 TODAY，但应用不知道今天是几号')
          date = null
        } else {
          date = today
        }
      }
      current = { date, activeKcal: null, restingKcal: null, source: SOURCE_SHORTCUT }
      continue
    }

    // ACT / RST
    if (!current) {
      problems.push(`「${match[2]}=${match[3]}」前面缺少 CAL/日期`)
      continue
    }
    const value = toNumberOrNull(match[3])
    if (value === null || value < 0) {
      problems.push(`「${match[2]}=${match[3]}」不是有效的热量值`)
      continue
    }
    const unit = (match[4] || '').trim()
    // 千焦比千卡大 4.184 倍。这是这套数据里最容易出错、也最难自己发现的一种错 ——
    // 数字看起来完全正常，只是整体偏大四倍。
    if (unit !== '' && KILOJOULE_UNITS.test(unit)) {
      problems.push(
        `「${match[2]}=${match[3]} ${unit}」的单位看起来是千焦而不是千卡。`
        + '去健康 App 里把能量单位改成「千卡」再同步一次 —— '
        + '千焦的数字会比真实的卡路里大 4.184 倍。',
      )
      continue
    }
    if (unit !== '' && !KCAL_UNITS.test(unit)) {
      problems.push(`「${unit}」没看懂，已按前面的数字处理`)
    }

    if (match[2].toUpperCase() === 'ACT') current.activeKcal = value
    else current.restingKcal = value
  }

  const tail = source.slice(consumed).trim()
  if (tail !== '') junk.push(tail)
  flush()

  for (const piece of junk) {
    problems.push(`看不懂这段内容：「${piece.slice(0, 40)}」`)
  }

  const usable = records.filter((record) => Boolean(record.date))
  if (usable.length !== records.length) {
    problems.push('有记录没有有效日期，已跳过')
  }

  return { records: usable, problems }
}

/** 反向：把记录拼成载荷文本。用于出错时对照，以及测试往返一致性 */
export function formatHealthPayload(records) {
  return (records || [])
    .map((record) => {
      const lines = [`${PAYLOAD_PREFIX}${record.date}`]
      if (typeof record.activeKcal === 'number') lines.push(`ACT=${Math.round(record.activeKcal)}`)
      if (typeof record.restingKcal === 'number') lines.push(`RST=${Math.round(record.restingKcal)}`)
      return lines.join('\n')
    })
    .join('\n\n')
}

/** 从多条记录里挑出与给定日期相关的那条 */
export function recordForDate(records, date) {
  return (records || []).find((record) => record.date === date) || null
}

/** 供界面提示用的一句话摘要 */
export function describeRecords(records) {
  if (!records || records.length === 0) return '没有可用数据'
  if (records.length === 1) {
    const record = records[0]
    return `${record.date}：活动 ${record.activeKcal ?? '—'} + 静息 ${record.restingKcal ?? '—'} kcal`
  }
  return `${records.length} 天：${records.map((record) => record.date).join('、')}`
}

// ── Gist 信箱 ───────────────────────────────────────────────────────────

export const GIST_CONFIG_PREFIX = 'carlories-gist:v1|'
export const GIST_FILENAME = 'carlories.txt'

/**
 * 信箱刚建好时的占位内容。
 *
 * 不能是空串或纯空白 —— GitHub 会以 422 拒绝「没有内容的文件」。
 * 也不能是任何像载荷的东西，否则应用会把它当成数据读进去。
 * 建好之后由快捷指令覆盖掉。
 */
export const GIST_PLACEHOLDER = '（还没有数据。快捷指令跑过一次后，这里会变成一行 CAL/TODAY ACT=… RST=…）'

/**
 * 解析信箱配置。接受三种写法，因为用户可能从任何地方复制：
 *   carlories-gist:v1|<id>          ← 部署脚本打印的
 *   https://gist.github.com/<用户>/<id>
 *   <id>                             ← 光一个 id
 */
export function parseGistConfig(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return null

  let id = trimmed
  if (id.startsWith(GIST_CONFIG_PREFIX)) id = id.slice(GIST_CONFIG_PREFIX.length).trim()

  // gist 链接有两种形式：/用户/id 和 /id
  id = id.replace(/^https?:\/\/gist\.github\.com\/(?:[^/\s]+\/)?/i, '')
  id = id.replace(/[#?].*$/, '').replace(/\/+$/, '').trim()

  // gist id 是十六进制
  if (!/^[0-9a-f]{5,64}$/i.test(id)) return null
  return { gistId: id }
}

export function formatGistConfig(gistId) {
  return `${GIST_CONFIG_PREFIX}${gistId}`
}

export function buildGistApiUrl(gistId) {
  return `https://api.github.com/gists/${gistId}`
}

/**
 * 从 Gist 的 API 响应里取出载荷文本。
 *
 * 优先找约定文件名；找不到就退而在所有文件里找一个「看起来像载荷」的 ——
 * 你可能在网页上把文件重命名过，那时候不该整个同步就废掉。
 *
 * 占位内容会被当成「还没有数据」，这样界面能给出准确的提示，
 * 而不是报一句「内容不是健康数据」让人以为哪里坏了。
 */
export function extractGistContent(gist) {
  const files = (gist && gist.files) || {}

  const isPlaceholder = (text) => String(text).trim() === GIST_PLACEHOLDER.trim()

  const named = files[GIST_FILENAME]
  if (named && typeof named.content === 'string') {
    const content = named.content
    if (content.trim() !== '' && !isPlaceholder(content)) return content
    return null
  }

  for (const file of Object.values(files)) {
    if (!file || typeof file.content !== 'string') continue
    if (isPlaceholder(file.content)) continue
    if (looksLikeHealthPayload(file.content)) return file.content
  }
  return null
}
