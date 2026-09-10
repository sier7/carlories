/**
 * 饮食记录 —— 核心领域逻辑。
 *
 * 一次记录（LogEntry）不存「算好的营养值」，而是存两样东西：
 *   1. 指向食物条目的引用（refId）+ 份量（amount / unit）
 *   2. 记录当时食物长什么样的**快照**（snapshot）
 *
 * 为什么不直接存算好的总值，也不直接每次去查食物库：
 *
 *   只查库 → 你三个月后修正了一条食物数据，历史记录被静默改写。
 *   只存总值 → 你无法回答「这条记录当时是按什么算的」，不可审计。
 *
 * 所以快照被存成一个**和食物同构的对象**，这样 entryNutrients() 可以直接
 * 复用 core/food.js 里的 nutritionForAmount()，不需要第二套计算路径 ——
 * 两条计算路径迟早会算出不同的数。
 *
 * 食物被修正后，记录不会自动跟着变，但 isEntryStale() 会把它标出来，
 * 由你决定要不要更新。见设计草案 §3.3 与 §1 原则 2。
 */

import {
  BASIS_PER_100G,
  BASIS_PER_SERVING,
  MACRO_NUTRIENTS,
  NUTRIENTS,
  newId,
  nutritionForAmount,
  sumNutrients,
  toNumberOrNull,
} from './food.js'

export const REF_FOOD = 'food'
export const REF_DISH = 'dish'

const VALID_UNITS = ['g', 'serving']

/**
 * 把一条食物冻成一个快照。
 * 快照刻意保持「食物同构」：nutritionForAmount() 能直接吃它。
 */
export function snapshotFromFood(food) {
  if (!food) return null
  const snapshot = {
    name: food.name,
    basis: { ...(food.basis || { type: 'per100g' }) },
    state: food.state || 'na',
    capturedAt: new Date().toISOString(),
    // 记录当时食物条目的版本，用于事后检测「这条记录依据的是旧数据」
    foodUpdatedAt: food.updatedAt || null,
  }
  for (const field of NUTRIENTS) {
    snapshot[field] = typeof food[field] === 'number' ? food[field] : null
  }
  return snapshot
}

export function createLogEntry(input = {}) {
  const now = new Date().toISOString()
  return {
    id: input.id ? String(input.id) : newId(),
    date: input.date,
    time: input.time,
    refType: input.refType === REF_DISH ? REF_DISH : REF_FOOD,
    refId: input.refId ?? null,
    amount: toNumberOrNull(input.amount),
    unit: VALID_UNITS.includes(input.unit) ? input.unit : 'g',
    snapshot: input.snapshot ?? null,
    note: String(input.note ?? '').trim(),
    createdAt: input.createdAt || now,
    updatedAt: now,
  }
}

/** 由一条食物 + 份量组装出可保存的记录 */
export function buildEntryFromFood({ food, amount, unit, date, time }) {
  return createLogEntry({
    date,
    time,
    refType: REF_FOOD,
    refId: food.id,
    amount,
    unit,
    snapshot: snapshotFromFood(food),
  })
}

// ── 自由填写 ────────────────────────────────────────────────────────────
//
// 食物库是可选的便利，不是记录的前提。
// 外食、临时吃的东西、菜单上印着热量的套餐 —— 这些你只想直接敲一个数字，
// 不想先为它建一条档案。
//
// 实现上很省事：记录本来就有快照，所以「自由填写」只是让快照来自手打的值，
// 而不是来自食物库。后续的汇总、编辑、再次调取全部沿用同一条路径。

/**
 * 由手填数据构造快照。
 *
 * 基准量固定为「1 份」，份量为 1 —— 意思就是「就是这一份，多少热量」。
 * 不填每份克重，所以这条数据只能用「份」计量，这与外食的认知是一致的：
 * 你知道一碗面多少热量，不知道它多少克。
 */
export function snapshotFromFreeInput(input = {}) {
  const snapshot = {
    name: String(input.name ?? '').trim(),
    basis: { type: BASIS_PER_SERVING, servingGrams: null, servingLabel: '1 份' },
    state: 'na',
    capturedAt: new Date().toISOString(),
    // 没有对应的食物条目，所以没有版本戳 —— 这条数据永远由你自己维护
    foodUpdatedAt: null,
  }
  for (const field of NUTRIENTS) {
    snapshot[field] = toNumberOrNull(input[field])
  }
  return snapshot
}

export function buildFreeEntry({ name, energyKcal, proteinG, fatG, carbG, fiberG, sodiumMg, date, time }) {
  return createLogEntry({
    date,
    time,
    refType: REF_FOOD,
    refId: null,
    amount: 1,
    unit: 'serving',
    snapshot: snapshotFromFreeInput({ name, energyKcal, proteinG, fatG, carbG, fiberG, sodiumMg }),
  })
}

/** 编辑自由条目：数值整个换掉，其余（日期、时间、id）保持 */
export function withFreeValues(entry, input) {
  return {
    ...entry,
    snapshot: snapshotFromFreeInput(input),
    amount: 1,
    unit: 'serving',
    updatedAt: new Date().toISOString(),
  }
}

/** 这条记录是自己填的，不对应食物库里的任何条目 */
export function isFreeEntry(entry) {
  return Boolean(entry) && !entry.refId
}

/** 这条记录有没有完整的三大营养素（缺了的话当天的营养素合计就偏低） */
export function entryHasMacros(entry) {
  const snapshot = entry && entry.snapshot
  if (!snapshot) return false
  return MACRO_NUTRIENTS.every(
    (field) => typeof snapshot[field] === 'number' && isFinite(snapshot[field]),
  )
}

export function validateEntry(entry) {
  const errors = []

  if (!entry.date) errors.push('缺少日期')
  if (!entry.time) errors.push('缺少时间')

  if (!entry.snapshot) {
    errors.push('缺少条目数据')
  } else {
    if (!entry.snapshot.name) errors.push('名称为必填')
    if (isFreeEntry(entry) && typeof entry.snapshot.energyKcal !== 'number') {
      errors.push('热量为必填')
    }
    if (entry.snapshot.basis && entry.snapshot.basis.type === BASIS_PER_SERVING) {
      const grams = entry.snapshot.basis.servingGrams
      if (grams !== null && grams !== undefined && !(grams > 0)) {
        errors.push('每份克重必须大于 0')
      }
    } else if (!entry.snapshot.basis) {
      errors.push('缺少基准量')
    }
    if (factorOf(entry) === null) {
      errors.push(
        entry.unit === 'serving'
          ? '该条目的基准量不支持按份记录'
          : '该条目没有「每份克重」，无法按克记录。改成按份记录，或回到食物库补上克重。',
      )
    }
  }

  if (entry.amount === null || entry.amount === undefined) errors.push('缺少份量')
  else if (!(entry.amount > 0)) errors.push('份量必须大于 0')

  return { errors, warnings: [] }
}

function factorOf(entry) {
  const probe = nutritionForAmount(entry.snapshot, entry.amount, entry.unit)
  return probe === null ? null : true
}

/** 这条记录贡献了多少营养（营养字段之和，非空） */
export function entryNutrients(entry) {
  if (!entry || !entry.snapshot) return null
  return nutritionForAmount(entry.snapshot, entry.amount, entry.unit)
}

/** 该份量相当于几个基准单位，用于展示「150 g = 1.5 份」这类信息 */
export function entryDisplay(entry) {
  const unitLabel = entry.unit === 'serving' ? '份' : 'g'
  return `${entry.amount} ${unitLabel}`
}

/**
 * 当天汇总。返回每条的明细与总计，界面两处都要用，
 * 分开算会产生「明细加起来不等于总计」这类难以察觉的偏差。
 */
export function summarizeEntries(entries) {
  const items = (entries || []).map((entry) => ({
    entry,
    nutrients: entryNutrients(entry),
  }))
  const totals = sumNutrients(items.map((i) => i.nutrients))
  return { items, totals }
}

export function sortEntries(entries) {
  return [...(entries || [])].sort((a, b) => {
    const t = String(a.time || '').localeCompare(String(b.time || ''))
    if (t !== 0) return t
    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
  })
}

/**
 * 这条记录依据的食物数据是否已经过期。
 *
 * 检测方式是比对版本戳而不是比对数值：数值比对会漏掉「改了又改回来」
 * 这种情况，也会因为浮点写法差异误报。
 */
export function isEntryStale(entry, currentFood) {
  if (!entry || !entry.snapshot) return false
  if (!currentFood) return false // 食物被删了不算过期，快照仍可用
  const loggedVersion = entry.snapshot.foodUpdatedAt
  if (!loggedVersion) return true // 早期数据没记版本，应当人工过目
  return currentFood.updatedAt !== loggedVersion
}

/** 用食物的当前值刷新记录快照（用户显式发起，不自动发生） */
export function refreshEntrySnapshot(entry, food) {
  return {
    ...entry,
    snapshot: snapshotFromFood(food),
    updatedAt: new Date().toISOString(),
  }
}

/** 仅改份量，快照不动 */
export function withAmount(entry, amount, unit) {
  return {
    ...entry,
    amount: toNumberOrNull(amount),
    unit: VALID_UNITS.includes(unit) ? unit : entry.unit,
    updatedAt: new Date().toISOString(),
  }
}
