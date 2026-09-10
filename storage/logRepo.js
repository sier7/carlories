/**
 * 饮食记录仓储。
 *
 * 记录表的规模会长得比食物表快得多（一天三五条，一年上千条），
 * 所以按 date 索引查，而不是全量取回再过滤。
 */

import { getAll, getAllByIndex, getAllByIndexRange, put, remove, count } from './db.js'
import { createLogEntry, sortEntries, validateEntry } from '../core/log.js'

const STORE = 'logs'

export async function listEntriesForDate(date) {
  const rows = await getAllByIndex(STORE, 'byDate', date)
  return sortEntries(rows)
}

/**
 * 一段日期内的全部记录，一次查回。
 * 逐天查的话，90 天就是 90 次事务 —— 趋势页每次切换区间都要跑一遍。
 */
export async function listEntriesInRange(from, to) {
  const rows = await getAllByIndexRange(STORE, 'byDate', from, to)
  return sortEntries(rows)
}

/**
 * 最近的全部记录，按时间倒序。用于建立「历史索引」（core/history.js）。
 *
 * 这里刻意用 getAll 后在内存里排序：个人应用一年的记录也就千余条，
 * 读回来是几毫秒的事，而按日期倒序分页在 IndexedDB 上要写游标，
 * 复杂度和收益不成比例。
 *
 * 已知上限：记录数真到了几万条时需要改成游标分页。
 */
export async function listRecentEntries(limit = 1000) {
  const all = await getAll(STORE)
  all.sort((a, b) => {
    const byDate = String(b.date || '').localeCompare(String(a.date || ''))
    if (byDate !== 0) return byDate
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
  })
  return all.slice(0, limit)
}

export async function saveEntry(entry) {
  const normalized = createLogEntry(entry)
  const { errors } = validateEntry(normalized)
  if (errors.length > 0) {
    const error = new Error(errors.join('；'))
    error.validation = { errors, warnings: [] }
    throw error
  }
  await put(STORE, normalized)
  return normalized
}

export async function saveEntries(entries) {
  for (const entry of entries) await saveEntry(entry)
  return entries.length
}

export async function deleteEntry(id) {
  await remove(STORE, id)
}

export async function countEntries() {
  return count(STORE)
}
