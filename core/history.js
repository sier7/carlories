/**
 * 历史索引：从你的饮食记录里提炼出「你记录过的东西」。
 *
 * 这是本应用的**主要**录入来源。
 *
 * 原先的设计要求每样吃食都先在食物表建档，记录时再去查表。对固定食谱还行，
 * 对真实生活完全行不通 —— 外食、换着吃、临时买的东西，你不可能事先建档，
 * 而且事后也不值得为它单独建一条。
 *
 * 所以反过来：**记过的东西自动成为可再次调取的条目。**
 * 食物库退化成可选的便利 —— 只在你需要精确克数换算（比如称重的生米）时才用。
 */

/**
 * 去重键。
 *
 * 来自食物库的按 id 去重（同一条目改了值也还是同一条）。
 * 自由填写的按名称去重 —— 这样「楼下牛肉面」记过五次之后，
 * 它就会稳稳地待在你列表的最前面，一次点击就能再记一次。
 */
export function historyKey(entry) {
  if (!entry || !entry.snapshot) return null
  if (entry.refId) return `food:${entry.refId}`
  const name = String(entry.snapshot.name || '').trim().toLowerCase()
  return name ? `free:${name}` : null
}

/**
 * 建立历史索引。
 *
 * entries 必须**按时间倒序**传入（最近的在前），因为去重时保留的是
 * 第一次遇到的那条 —— 也就是最近一次记录的样子。
 * 你上周把牛肉面记成 800，昨天记成 650，那么列表里显示 650。
 */
export function buildHistoryIndex(entries, { limit = 80 } = {}) {
  const byKey = new Map()

  for (const entry of entries || []) {
    const key = historyKey(entry)
    if (!key) continue

    const existing = byKey.get(key)
    if (existing) {
      existing.times += 1
      continue
    }

    byKey.set(key, {
      key,
      refId: entry.refId || null,
      free: !entry.refId,
      snapshot: entry.snapshot,
      lastAmount: entry.amount,
      lastUnit: entry.unit,
      lastDate: entry.date,
      lastTime: entry.time,
      times: 1,
    })
  }

  return [...byKey.values()].slice(0, limit)
}

export function filterHistory(items, query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return items
  return items.filter((item) => String(item.snapshot.name || '').toLowerCase().includes(q))
}

/** 历史里已经有对应食物条目的 refId 集合，用于在食物库分区里避免重复展示 */
export function historyRefIds(index) {
  return new Set(index.filter((item) => item.refId).map((item) => item.refId))
}

/**
 * 把历史条目接到当前的条目数据上。
 *
 * 关键在于：**历史是通往条目的捷径，不是一份冻结的副本。**
 * 你修正过「鸡蛋」的热量之后，从历史再记一次应该用**新的**值，
 * 而不是当初那个旧值 —— 否则你会以为自己在用修正后的数据，其实没有。
 * 只有当食物条目已经被删掉时，才退回用它当初的快照。
 */
export function resolveHistory(index, foods) {
  const byId = new Map((foods || []).map((f) => [f.id, f]))

  return (index || []).map((item) => {
    const food = item.refId ? byId.get(item.refId) : null
    const source = food || item.snapshot
    return {
      ...item,
      source,
      // 重复记录时用哪个 refId：食物还在就指向它；食物被删了也保留原 refId，
      // 这样这条记录仍然走「按份量编辑」而不是被当成新手填的自由条目
      repeatRefId: food ? food.id : item.refId || null,
      missingFromLibrary: Boolean(item.refId) && !food,
      repeatKcal: kcalForAmount(source, item.lastAmount, item.lastUnit),
    }
  })
}

function kcalForAmount(source, amount, unit) {
  const basis = source && source.basis
  if (!basis || typeof source.energyKcal !== 'number') return null
  if (typeof amount !== 'number') return null

  if (basis.type === 'per100g') return unit === 'g' ? source.energyKcal * (amount / 100) : null
  if (unit === 'serving') return source.energyKcal * amount
  if (unit === 'g' && typeof basis.servingGrams === 'number' && basis.servingGrams > 0) {
    return source.energyKcal * (amount / basis.servingGrams)
  }
  return null
}
