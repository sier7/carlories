/**
 * 当日消耗数据。
 *
 * 这一层现在写的是**手动输入**的数字，但它就是将来快捷指令同步落地的位置
 * （见设计草案 §7）。把接口先按「一条记录 = 一天」的形状定下来，
 * 接健康数据时只需多写一个写入方，界面和计算都不用动。
 *
 * 日期是主键，所以同一天重复导入天然幂等 —— 不会重复累加。
 */

import { get, put, remove } from './db.js'
import { toNumberOrNull } from '../core/food.js'

const STORE = 'dayHealth'

export const SOURCE_MANUAL = 'manual'
export const SOURCE_SHORTCUT = 'shortcut'

export async function getDayHealth(date) {
  return (await get(STORE, date)) || null
}

export async function setDayHealth(date, { activeKcal, restingKcal, source = SOURCE_MANUAL }) {
  const record = {
    date,
    activeKcal: toNumberOrNull(activeKcal),
    restingKcal: toNumberOrNull(restingKcal),
    source,
    importedAt: new Date().toISOString(),
  }
  for (const [key, value] of Object.entries({
    activeKcal: record.activeKcal,
    restingKcal: record.restingKcal,
  })) {
    if (value !== null && value < 0) throw new Error(`${key} 不能为负数`)
  }
  if (record.activeKcal === null && record.restingKcal === null) {
    await remove(STORE, date)
    return null
  }
  await put(STORE, record)
  return record
}

export async function clearDayHealth(date) {
  await remove(STORE, date)
}

/**
 * 批量导入（快捷指令同步走这里）。
 *
 * 日期是主键，所以同一天重复导入天然幂等 —— 这正是每天自动同步多次
 * 所必需的性质：第 10 次导入和第 1 次结果一样，不会累加。
 */
export async function importHealthRecords(records) {
  const written = []
  for (const record of records || []) {
    const saved = await setDayHealth(record.date, {
      activeKcal: record.activeKcal,
      restingKcal: record.restingKcal,
      source: record.source || SOURCE_SHORTCUT,
    })
    if (saved) written.push(saved)
  }
  return written
}

/** 总消耗 = 活动 + 静息。缺哪一项就按 0 计，不猜。 */
export function totalBurn(record) {
  if (!record) return null
  const active = record.activeKcal
  const resting = record.restingKcal
  if (active === null && resting === null) return null
  return (active || 0) + (resting || 0)
}

/** 数据新鲜度：用于在界面上说明这个消耗数字有多旧，而不是假装它是实时的 */
export function freshness(record, now = new Date()) {
  if (!record || !record.importedAt) return null
  const minutes = Math.floor((now - new Date(record.importedAt)) / 60000)
  if (!isFinite(minutes) || minutes < 0) return null
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}
