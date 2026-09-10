/**
 * 食物仓储：食物热量表的读写入口。
 *
 * 这一层负责把 core 的纯逻辑接到 IndexedDB 上，并把「导出/导入」做扎实 ——
 * 食物表是手工积累的资产，最严重的失效模式是它被清空（设计草案 §8）。
 * 导出不是可选项。
 */

import { getAll, put, remove, putMany, clear, count } from './db.js'
import { createFood, normalizeFood, validateFood } from '../core/food.js'

const STORE = 'foods'

export const EXPORT_FORMAT = 'carlories.export'
export const EXPORT_SCHEMA_VERSION = 1

/** 全部食物，按名称排序（中文按拼音） */
export async function listFoods() {
  const all = await getAll(STORE)
  return sortFoods(all)
}

export function sortFoods(foods) {
  return [...foods].sort((a, b) =>
    String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'),
  )
}

export async function countFoods() {
  return count(STORE)
}

/**
 * 保存一条食物。校验失败时抛错，错误对象上带 validation 字段，
 * 供界面区分「阻断性错误」与「提示性警告」。
 */
export async function saveFood(input) {
  const food = createFood(input)
  const { errors, warnings } = validateFood(food)
  if (errors.length > 0) {
    const error = new Error(errors.join('；'))
    error.validation = { errors, warnings }
    throw error
  }
  await put(STORE, food)
  return { food, warnings }
}

export async function deleteFood(id) {
  await remove(STORE, id)
}

/** 按名称、备注、来源做包含匹配。食物表规模在数百条量级，内存过滤足够且对中文更友好 */
export function filterFoods(foods, query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return foods
  return foods.filter((food) => {
    const haystack = [food.name, food.note, food.source]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return haystack.includes(q)
  })
}

// ── 导出 / 导入 ─────────────────────────────────────────────────────────

export async function exportAll() {
  const foods = await listFoods()
  return {
    format: EXPORT_FORMAT,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    counts: { foods: foods.length },
    foods,
  }
}

export function exportToJson(payload) {
  return JSON.stringify(payload, null, 2)
}

/**
 * 解析导入内容。先整体校验形状，任一条目形状非法就整体拒绝 ——
 * 半个导入比不导入更糟（用户无法判断库里现在是什么状态）。
 */
export function parseImport(text) {
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('不是合法的 JSON 文本')
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error('内容不是一个对象')
  }
  if (payload.format !== EXPORT_FORMAT) {
    throw new Error(`格式不匹配：期望 ${EXPORT_FORMAT}，实际为 ${payload.format ?? '(缺失)'}`)
  }
  if (!Array.isArray(payload.foods)) {
    throw new Error('缺少 foods 数组')
  }

  const foods = payload.foods.map((raw) => normalizeFood(raw, { fresh: false }))

  const invalid = []
  foods.forEach((food, i) => {
    const { errors } = validateFood(food)
    if (errors.length > 0) invalid.push(`第 ${i + 1} 条（${food.name || '无名称'}）：${errors.join('；')}`)
  })
  if (invalid.length > 0) {
    throw new Error(`有 ${invalid.length} 条数据不合法，已整体取消导入：\n${invalid.slice(0, 5).join('\n')}`)
  }

  return { foods, exportedAt: payload.exportedAt ?? null }
}

/**
 * mode:
 *   'merge'   按 id 合并，同 id 覆盖（默认）
 *   'replace' 先清空再写入
 *
 * 刻意不提供「按名称去重」的智能合并：名称相同但基准量不同的条目
 * （100 g 生米 vs 100 g 熟米饭）是合法的，自动合并会造成静默失真。
 */
export async function importFoods({ foods }, { mode = 'merge' } = {}) {
  if (mode === 'replace') {
    await clear(STORE)
  }
  const written = await putMany(STORE, foods)
  return { imported: written, mode }
}
