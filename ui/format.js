/** 数字与文案格式化。集中在一次，避免同一个数字在界面两处长得不一样。 */

import { FIELD_DECIMALS, round } from '../core/food.js'

export function fmtKcal(value) {
  if (typeof value !== 'number' || !isFinite(value)) return '—'
  return Math.round(value).toLocaleString('zh-CN')
}

export function fmtGram(value, decimals = FIELD_DECIMALS.proteinG) {
  const r = round(value, decimals)
  if (r === null) return '—'
  return r.toFixed(decimals).replace(/\.0+$/, '')
}

/** 带正负号的差值：零不显示符号 */
export function fmtDelta(value) {
  if (typeof value !== 'number' || !isFinite(value)) return '—'
  const r = Math.round(value)
  if (r === 0) return '0'
  return (r > 0 ? '+' : '−') + Math.abs(r).toLocaleString('zh-CN')
}

/** 份量的显示文案：150 g / 1.5 份 */
export function fmtAmount(amount, unit) {
  const n = round(amount, 2)
  if (n === null) return '—'
  return `${n} ${unit === 'serving' ? '份' : 'g'}`
}

export function percent(value, total) {
  if (!total || total <= 0) return null
  return Math.min(2, Math.max(0, value / total))
}
