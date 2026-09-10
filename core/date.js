/**
 * 本地日期工具。
 *
 * 刻意不使用 toISOString()：那是 UTC。东八区晚上 8 点之后 toISOString 会给出
 * 第二天的日期，于是「今天的记录」在晚上会被算到明天去。这里全部按本地时间
 * 的日历字段构造，避开这个坑，也避开夏令时导致的加一天不等于加 86400 秒。
 */

export function dateKey(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function timeKey(date = new Date()) {
  const h = String(date.getHours()).padStart(2, '0')
  const mi = String(date.getMinutes()).padStart(2, '0')
  return `${h}:${mi}`
}

export function parseDateKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''))
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const probe = new Date(year, month - 1, day)
  // 拒绝 2 月 30 日这类会被 Date 自动进位的日期
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
    return null
  }
  return { year, month, day }
}

export function isValidDateKey(key) {
  return parseDateKey(key) !== null
}

export function addDays(key, delta) {
  const p = parseDateKey(key)
  if (!p) return key
  return dateKey(new Date(p.year, p.month - 1, p.day + delta))
}

/** 两个日期相差几天（b - a） */
export function daysBetween(aKey, bKey) {
  const a = parseDateKey(aKey)
  const b = parseDateKey(bKey)
  if (!a || !b) return null
  const ms = new Date(b.year, b.month - 1, b.day) - new Date(a.year, a.month - 1, a.day)
  return Math.round(ms / 86400000)
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 「今天」「昨天」这类相对标签，够不着时才回到具体日期 */
export function dateLabel(key, today = dateKey()) {
  if (key === today) return '今天'
  if (key === addDays(today, -1)) return '昨天'
  if (key === addDays(today, 1)) return '明天'
  if (key === addDays(today, 2)) return '后天'

  const p = parseDateKey(key)
  if (!p) return String(key)
  const weekday = WEEKDAYS[new Date(p.year, p.month - 1, p.day).getDay()]
  const t = parseDateKey(today)
  const sameYear = t && t.year === p.year
  const base = sameYear
    ? `${p.month} 月 ${p.day} 日`
    : `${p.year} 年 ${p.month} 月 ${p.day} 日`
  return `${base} ${weekday}`
}

/** 给日期导航用的短标签 */
export function shortDateLabel(key) {
  const p = parseDateKey(key)
  if (!p) return String(key)
  return `${p.month}/${p.day}`
}

/** 相对今天的人话描述，用于「已过去 / 未到来」的提示 */
export function relativeLabel(key, today = dateKey()) {
  const diff = daysBetween(today, key)
  if (diff === null) return ''
  if (diff === 0) return '今天'
  if (diff === -1) return '昨天'
  if (diff === 1) return '明天'
  if (diff < 0) return `${-diff} 天前`
  return `${diff} 天后`
}
