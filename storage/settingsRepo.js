/**
 * 应用设置。
 *
 * 目前只有一组目标值。用单条文档而不是逐项存 key，是为了以后加设置项时
 * 不必迁移数据结构。
 *
 * 已知简化：目标是全局的，不是按天快照的。也就是说你改了目标，过去每一天的
 * 完成度都会跟着变。设计草案 §3.5 要求按天快照，等预算模型落地时一并实现。
 */

import { get, put } from './db.js'
import { toNumberOrNull } from '../core/food.js'

const STORE = 'settings'
const DOC_KEY = 'app'

const DEFAULTS = {
  targets: {
    energyKcal: null,
    proteinG: null,
    fatG: null,
    carbG: null,
  },
}

export async function getSettings() {
  const doc = await get(STORE, DOC_KEY)
  if (!doc || !doc.value) return structuredCloneSafe(DEFAULTS)
  return {
    ...structuredCloneSafe(DEFAULTS),
    ...doc.value,
    targets: { ...DEFAULTS.targets, ...(doc.value.targets || {}) },
  }
}

export async function saveSettings(patch) {
  const current = await getSettings()
  const merged = {
    ...current,
    ...patch,
    targets: { ...current.targets, ...(patch.targets || {}) },
  }
  await put(STORE, { key: DOC_KEY, value: merged, updatedAt: new Date().toISOString() })
  return merged
}

export async function saveTargets(targets) {
  const cleaned = {
    energyKcal: toNumberOrNull(targets.energyKcal),
    proteinG: toNumberOrNull(targets.proteinG),
    fatG: toNumberOrNull(targets.fatG),
    carbG: toNumberOrNull(targets.carbG),
  }
  for (const [key, value] of Object.entries(cleaned)) {
    if (value !== null && value < 0) throw new Error(`${key} 不能为负数`)
  }
  return saveSettings({ targets: cleaned })
}

export function hasAnyTarget(targets) {
  if (!targets) return false
  return (
    targets.energyKcal !== null ||
    targets.proteinG !== null ||
    targets.fatG !== null ||
    targets.carbG !== null
  )
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value))
}
