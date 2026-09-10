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
  // Gist 信箱（见 core/healthSync.js 与 docs/自动同步.md）。
  // 配置好之后应用打开时直接从 Gist 拉取，不需要读剪贴板，也就不需要点击。
  //
  // 注意这里**只有 gistId，没有口令** —— 读一个公开 Gist 不需要任何凭据，
  // 所以写入用的 token 只存在于快捷指令里，不进这个应用。
  sync: {
    gistId: null,
  },
}

export async function getSettings() {
  const doc = await get(STORE, DOC_KEY)
  if (!doc || !doc.value) return structuredCloneSafe(DEFAULTS)
  return {
    ...structuredCloneSafe(DEFAULTS),
    ...doc.value,
    targets: { ...DEFAULTS.targets, ...(doc.value.targets || {}) },
    sync: { ...DEFAULTS.sync, ...(doc.value.sync || {}) },
  }
}

export async function saveSettings(patch) {
  const current = await getSettings()
  const merged = {
    ...current,
    ...patch,
    targets: { ...current.targets, ...(patch.targets || {}) },
    sync: { ...current.sync, ...(patch.sync || {}) },
  }
  await put(STORE, { key: DOC_KEY, value: merged, updatedAt: new Date().toISOString() })
  return merged
}

/** 保存 Gist 信箱。gistId 为空即视为关闭。 */
export async function saveSyncConfig({ gistId }) {
  const clean = gistId ? String(gistId).trim() : null
  if (clean && !/^[0-9a-f]{5,64}$/i.test(clean)) {
    throw new Error('Gist ID 看起来不对（它是一串十六进制字符）')
  }
  return saveSettings({ sync: { gistId: clean } })
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
