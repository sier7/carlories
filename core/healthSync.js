/**
 * 健康数据同步载荷的解析。
 *
 * 载荷刻意用纯文本而不是 JSON：
 *   · 快捷指令里拼字符串比拼 JSON 简单得多（少一层字典构造）
 *   · 你在剪贴板里一眼能看懂，数字对不上时能手工改
 *   · 格式坏了也看得见坏在哪一行
 *
 * 格式：
 *   CAL/2026-10-03
 *   ACT=842
 *   RST=1710
 *
 * 可以连着放多天，用于补录：
 *   CAL/2026-10-02
 *   ACT=950
 *   RST=1690
 *
 * 日期是幂等键：同一天重复导入即覆盖，不会重复累加。
 */

import { toNumberOrNull } from './food.js'

export const PAYLOAD_PREFIX = 'CAL/'
export const SOURCE_SHORTCUT = 'shortcut'

/** 日期可以写字面量 TODAY，由应用解析成当天。见 parseHealthPayload 的说明 */
export const TODAY_TOKEN = 'TODAY'

/**
 * 单位词。快捷指令把「计算统计」的结果插进「文本」动作时，可能带上单位后缀
 * （`842.5 kcal`）。所以取值不能假设后面什么都没有。
 */
const KILOJOULE_UNITS = /^(kj|千焦|千焦耳|kilojoule|kilojoules)$/i
const KCAL_UNITS = /^(kcal|cal|千卡|大卡|卡|卡路里|kilocalorie|kilocalories)$/i

/**
 * 从「数字 + 可选单位」里拆出数字。
 *
 * 数字部分必须**贪婪**匹配。用惰性量词会得到灾难性的结果：
 *   "842" 会被拆成数字 8 + 单位 "42"
 * 因为正则总是可以让数字部分尽量短、把剩下的都推给单位部分。
 */
function parseQuantity(text) {
  const match = /^\s*(-?[\d][\d.,，]*)\s*(.*)$/.exec(String(text ?? ''))
  if (!match) return { value: null, unit: '' }
  return { value: toNumberOrNull(match[1]), unit: match[2].trim() }
}

/** 剪贴板里乱七八糟什么都有，先廉价地判断一下是不是我们的东西 */
export function looksLikeHealthPayload(text) {
  return typeof text === 'string' && /^\s*CAL\//im.test(text)
}

/**
 * 解析。返回 { records, problems }。
 *
 * 单行出错不会毁掉整份载荷 —— 能认的都认下来，认不出的逐条报告。
 * 这与食物表导入的「整体成功或整体失败」不同：那里是在覆盖你的档案，
 * 这里只是往一天的格子里填两个数，部分成功没有歧义。
 *
 * 关于 CAL/TODAY：
 * 日期本来该由快捷指令用「格式化日期」动作生成成 yyyy-MM-dd，但那一步是
 * 整个快捷指令里最容易配错的地方（格式字符串写错就得到一个非法日期）。
 * 所以允许直接写 TODAY —— 快捷指令里打四个字母就行，由应用补上当天日期。
 *
 * @param text 剪贴板内容
 * @param options.today 当天日期（YYYY-MM-DD）。用了 TODAY 却没给就会报错。
 */
export function parseHealthPayload(text, { today = null } = {}) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { records: [], problems: ['剪贴板是空的'] }
  }
  if (!looksLikeHealthPayload(text)) {
    return {
      records: [],
      problems: ['剪贴板里的内容不是健康数据（应该以 CAL/ 开头）'],
    }
  }

  const records = []
  const problems = []
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

  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue

    const head = /^CAL\/(\d{4}-\d{2}-\d{2}|TODAY)$/i.exec(line)
    if (head) {
      flush()
      const token = head[1].toUpperCase()
      let date = head[1]
      if (token === TODAY_TOKEN) {
        if (!today) {
          problems.push('载荷里写了 TODAY，但应用不知道今天是几号')
          date = null
        } else {
          date = today
        }
      }
      current = {
        date,
        activeKcal: null,
        restingKcal: null,
        source: SOURCE_SHORTCUT,
      }
      continue
    }

    const kv = /^(ACT|RST)\s*[=:：]\s*(.*)$/i.exec(line)
    if (kv) {
      if (!current) {
        problems.push(`「${line}」前面缺少 CAL/日期 这一行`)
        continue
      }

      const { value, unit } = parseQuantity(kv[2])
      if (value === null) {
        problems.push(`「${line}」里找不到数字`)
        continue
      }
      if (value < 0) {
        problems.push(`「${line}」是负数`)
        continue
      }
      // 千焦比千卡大 4.184 倍。这是这套数据里最容易出错、也最难自己发现的
      // 一种错 —— 数字看起来完全正常，只是整体偏大四倍。
      if (KILOJOULE_UNITS.test(unit)) {
        problems.push(
          `「${line}」的单位看起来是千焦而不是千卡。`
          + '去健康 App 里把能量单位改成「千卡」再同步一次 —— '
          + '千焦的数字会比真实的卡路里大 4.184 倍。',
        )
        continue
      }
      if (unit !== '' && !KCAL_UNITS.test(unit)) {
        // 数字仍然采用，但把多余内容说出来，免得悄悄丢掉信息
        problems.push(`「${line}」数字后面有看不懂的内容「${unit}」，已按前面的数字处理`)
      }

      if (kv[1].toUpperCase() === 'ACT') current.activeKcal = value
      else current.restingKcal = value
      continue
    }

    problems.push(`看不懂这一行：「${line}」`)
  }

  flush()

  // 丢掉落不到任何一天的记录（TODAY 但没给 today 的情况）
  const usable = records.filter((r) => Boolean(r.date))
  if (usable.length !== records.length) {
    problems.push('有记录没有有效日期，已跳过')
  }

  return { records: usable, problems }
}

/** 反向：把记录拼成载荷文本。用于出错时对照，以及测试往返一致性 */
export function formatHealthPayload(records) {
  return (records || [])
    .map((r) => {
      const lines = [`${PAYLOAD_PREFIX}${r.date}`]
      if (typeof r.activeKcal === 'number') lines.push(`ACT=${Math.round(r.activeKcal)}`)
      if (typeof r.restingKcal === 'number') lines.push(`RST=${Math.round(r.restingKcal)}`)
      return lines.join('\n')
    })
    .join('\n\n')
}

/** 从多条记录里挑出与给定日期相关的那条 */
export function recordForDate(records, date) {
  return (records || []).find((r) => r.date === date) || null
}

/** 供界面提示用的一句话摘要 */
export function describeRecords(records) {
  if (!records || records.length === 0) return '没有可用数据'
  if (records.length === 1) {
    const r = records[0]
    return `${r.date}：活动 ${r.activeKcal ?? '—'} + 静息 ${r.restingKcal ?? '—'} kcal`
  }
  return `${records.length} 天：${records.map((r) => r.date).join('、')}`
}
