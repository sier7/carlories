/**
 * 食物热量表 —— 核心领域逻辑
 *
 * 本模块是纯逻辑：不接触 DOM、不接触存储、不接触任何浏览器 API（唯一例外是
 * newId() 里对 crypto.randomUUID 的可选使用，且有兜底）。
 *
 * 这样做的理由（见设计草案 §2）：它必须能在 Node 里直接跑测试，也必须能在
 * 将来被原生外壳整块复用。任何浏览器相关的依赖都属于 ui/ 或 storage/。
 */

// ── 基准量 ──────────────────────────────────────────────────────────────

export const BASIS_PER_100G = 'per100g'
export const BASIS_PER_SERVING = 'perServing'
export const BASIS_TYPES = [BASIS_PER_100G, BASIS_PER_SERVING]

// ── 生熟 ────────────────────────────────────────────────────────────────
// 100 g 生米约 346 kcal，100 g 熟米饭约 130 kcal，差 2.7 倍。
// 这是自填热量表最大的错误来源，所以 state 是必填字段而非可选项。

export const STATE_RAW = 'raw'
export const STATE_COOKED = 'cooked'
export const STATE_NA = 'na'
export const STATES = [STATE_NA, STATE_RAW, STATE_COOKED]

export const STATE_LABEL = {
  [STATE_NA]: '不适用',
  [STATE_RAW]: '生',
  [STATE_COOKED]: '熟',
}

// ── 营养字段 ────────────────────────────────────────────────────────────

/** 表单主网格里的四项 */
export const PRIMARY_NUTRIENTS = ['energyKcal', 'proteinG', 'fatG', 'carbG']
/** 三大营养素 */
export const MACRO_NUTRIENTS = ['proteinG', 'fatG', 'carbG']
/** 选填：填了才有意义，不填不报错 */
export const EXTRA_NUTRIENTS = ['fiberG', 'sodiumMg']
/** 全部营养字段 */
export const NUTRIENTS = [...PRIMARY_NUTRIENTS, ...EXTRA_NUTRIENTS]

/**
 * 硬性必填只有热量。
 *
 * 三大营养素**不是**必填。外食的时候你常常只知道这一份大约多少热量，
 * 不知道蛋白脂肪碳水各多少。强迫你填只会让你编一个数字进去 ——
 * 那比留空更糟，因为编的数字看起来和真的一样。留空至少诚实：
 * 界面会明确告诉你当天的营养素合计缺了几条、所以偏低。
 */
export const REQUIRED_NUTRIENTS = ['energyKcal']

export const FIELD_LABEL = {
  energyKcal: '热量',
  proteinG: '蛋白质',
  fatG: '脂肪',
  carbG: '碳水',
  fiberG: '纤维',
  sodiumMg: '钠',
}

export const FIELD_UNIT = {
  energyKcal: 'kcal',
  proteinG: 'g',
  fatG: 'g',
  carbG: 'g',
  fiberG: 'g',
  sodiumMg: 'mg',
}

/** 热量字段的小数位为 0，其余为 1，钠为 0 */
export const FIELD_DECIMALS = {
  energyKcal: 0,
  proteinG: 1,
  fatG: 1,
  carbG: 1,
  fiberG: 1,
  sodiumMg: 0,
}

/** Atwater 系数：蛋白 4、脂肪 9、碳水 4 kcal/g */
const KCAL_PER_GRAM = { proteinG: 4, fatG: 9, carbG: 4 }

/** 纯油脂约 900 kcal / 100 g，作为不可能值的上界参考 */
const MAX_KCAL_PER_100G = 900

// ── 工具 ────────────────────────────────────────────────────────────────

export function round(value, decimals = 0) {
  if (typeof value !== 'number' || !isFinite(value)) return null
  const f = 10 ** decimals
  return Math.round(value * f) / f
}

/** 安全解析数字：空串、空白、非法输入一律返回 null，而不是 NaN */
export function toNumberOrNull(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return isFinite(value) ? value : null
  const s = String(value).trim().replace(/[,，\s]/g, '')
  if (s === '') return null
  const n = Number(s)
  return isFinite(n) ? n : null
}

/**
 * 生成 id。crypto.randomUUID 只在安全上下文可用，而通过局域网 IP 以 HTTP
 * 访问时不是安全上下文，所以必须有兜底（见设计草案 §11）。
 */
export function newId() {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID()
    } catch {
      /* 落到兜底分支 */
    }
  }
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// ── 实体 ────────────────────────────────────────────────────────────────

function normalizeBasis(raw) {
  const b = raw && typeof raw === 'object' ? raw : {}
  if (b.type === BASIS_PER_SERVING) {
    return {
      type: BASIS_PER_SERVING,
      servingGrams: toNumberOrNull(b.servingGrams),
      servingLabel: String(b.servingLabel ?? '').trim(),
    }
  }
  return { type: BASIS_PER_100G }
}

/**
 * 把任意输入规范成一条合法形状的食物条目。
 * fresh=true 时强制刷新 updatedAt（用于用户新增/编辑）；
 * fresh=false 时保留传入的 createdAt/updatedAt（用于导入，避免备份还原后时间戳全变）。
 */
export function normalizeFood(input = {}, { fresh = false } = {}) {
  const now = new Date().toISOString()
  const food = {
    id: input.id ? String(input.id) : newId(),
    name: String(input.name ?? '').trim(),
    basis: normalizeBasis(input.basis),
    state: STATES.includes(input.state) ? input.state : STATE_NA,
    source: String(input.source ?? '').trim(),
    note: String(input.note ?? '').trim(),
    verified: input.verified === true,
    createdAt: input.createdAt || now,
    updatedAt: fresh ? now : input.updatedAt || now,
  }
  for (const field of NUTRIENTS) {
    food[field] = toNumberOrNull(input[field])
  }
  return food
}

/** 用户新增或编辑时使用 */
export function createFood(input = {}) {
  return normalizeFood(input, { fresh: true })
}

// ── 校验 ────────────────────────────────────────────────────────────────

/**
 * 返回 { errors, warnings }。
 * errors 阻断保存；warnings 只提示，允许保存。
 *
 * 这里刻意不在有 error 时计算 warnings：数字还没填全时算出来的
 * 一致性提示全是噪音。
 */
export function validateFood(food) {
  const errors = []
  const warnings = []

  if (!food.name) {
    errors.push('名称不能为空')
  }

  if (food.basis.type === BASIS_PER_SERVING) {
    const g = food.basis.servingGrams
    if (g !== null && g !== undefined && g <= 0) {
      errors.push('每份克重必须大于 0，或者留空表示按份记录')
    } else if (g !== null && g !== undefined && g > 2000) {
      warnings.push(`每份 ${g} g 偏大，确认一下基准量是否填错。`)
    } else if (g === null || g === undefined) {
      // 不是错误：外食的「1 碗」「1 杯」本来就不知道多少克。
      // 只是这条数据只能按份记录，不能按克。
      warnings.push('没有填每份克重，这条只能用「份」来记录，不能用克。')
    }
  } else if (food.basis.type !== BASIS_PER_100G) {
    errors.push('基准量类型无效')
  }

  for (const field of REQUIRED_NUTRIENTS) {
    const v = food[field]
    if (v === null || v === undefined) {
      errors.push(`${FIELD_LABEL[field]}为必填`)
    } else if (v < 0) {
      errors.push(`${FIELD_LABEL[field]}不能为负数`)
    }
  }

  for (const field of [...MACRO_NUTRIENTS, ...EXTRA_NUTRIENTS]) {
    const v = food[field]
    if (v === null || v === undefined) continue
    if (!isFinite(v)) {
      errors.push(`${FIELD_LABEL[field]}不是有效数字`)
    } else if (v < 0) {
      errors.push(`${FIELD_LABEL[field]}不能为负数`)
    }
  }

  if (errors.length === 0) {
    warnings.push(...consistencyWarnings(food))
  }

  return { errors, warnings }
}

/**
 * 数据质量检查。这不是「估算」，而是拿你自己的数字互相印证：
 * 如果热量和三大营养素按 4/9/4 换算后对不上，多半是打错了一位。
 */
function consistencyWarnings(food) {
  const out = []
  const energy = food.energyKcal
  const macrosKnown = MACRO_NUTRIENTS.every(
    (field) => typeof food[field] === 'number' && isFinite(food[field]),
  )

  if (!macrosKnown) {
    if (energy > 0) {
      out.push(
        '没有填三大营养素，无法统计营养素比例，当天的营养素合计会偏低。'
        + '外食时这很正常，留空比编一个数字好。',
      )
    }
  } else {
    const protein = food.proteinG
    const fat = food.fatG
    const carb = food.carbG
    const fromMacros =
      protein * KCAL_PER_GRAM.proteinG +
      fat * KCAL_PER_GRAM.fatG +
      carb * KCAL_PER_GRAM.carbG

    if (energy > 0 && fromMacros > 0) {
      const diff = Math.abs(fromMacros - energy) / energy
      // 容差 25%：纤维、糖醇、酒精都会让两者天然对不上，只抓明显的手误
      if (diff > 0.25) {
        out.push(
          `热量与三大营养素对不上：按 4/9/4 由营养素算出约 ${Math.round(fromMacros)} kcal，`
          + `而你填的是 ${round(energy, 0)} kcal，相差 ${Math.round(diff * 100)}%。请核对。`,
        )
      }
    }

    if (energy === 0 && protein + fat + carb > 0) {
      out.push('三大营养素不为零但热量为 0，确认一下？')
    }

    if (energy > 0 && protein + fat + carb === 0) {
      out.push('三大营养素都是 0 但热量不为 0，无法统计营养素比例，确认一下。')
    }
  }

  const per100 = energyPer100g(food)
  if (per100 !== null && per100 > MAX_KCAL_PER_100G) {
    out.push(
      `折算成每 100 g 是 ${Math.round(per100)} kcal，超过纯油脂（约 ${MAX_KCAL_PER_100G}）。`
      + '检查基准量或单位是否填错。',
    )
  }

  return out
}

// ── 基准量换算 ──────────────────────────────────────────────────────────

/** 一个基准单位对应多少克；「每份」但没填克重时返回 null */
export function gramsPerBasisUnit(basis) {
  if (!basis) return null
  if (basis.type === BASIS_PER_100G) return 100
  const g = basis.servingGrams
  return typeof g === 'number' && isFinite(g) && g > 0 ? g : null
}

/** 折算成每 100 g 的热量，用于跨条目比较和异常检测 */
export function energyPer100g(food) {
  const grams = gramsPerBasisUnit(food.basis)
  if (!grams || typeof food.energyKcal !== 'number') return null
  return food.energyKcal * (100 / grams)
}

/** 人类可读的基准量描述，如「每 100 g」「每 1 个（50 g）」 */
export function basisLabel(food) {
  const b = food && food.basis
  if (!b) return ''
  if (b.type === BASIS_PER_100G) return '每 100 g'
  const label = b.servingLabel || '1 份'
  const g = b.servingGrams
  return g ? `每 ${label}（${g} g）` : `每 ${label}`
}

/**
 * 该条目允许用什么单位记录份量。
 *
 * 「每 100 g」的条目只能用克记。
 * 「每份」的条目：填了克重则两种都能用；**没填克重时只能按份记** ——
 * 这时它仍然是一条完全可用的数据，只是无法用克来计量。
 */
export function availableUnits(food) {
  const basis = food && food.basis
  if (!basis || basis.type !== BASIS_PER_SERVING) return ['g']
  return gramsPerBasisUnit(basis) ? ['g', 'serving'] : ['serving']
}

/**
 * 份量系数：该份量相当于几个基准单位。
 *
 * 这是整个应用的运算核心 —— 日常记录必须退化成
 * 「系数 × 库中已核对的值」这一次乘法，不含任何猜测。
 */
export function factorFor(food, amount, unit) {
  const a = toNumberOrNull(amount)
  if (a === null || a < 0) return null
  const basis = food && food.basis
  if (!basis) return null

  if (basis.type === BASIS_PER_100G) {
    // 「每 100 g」的条目只能用克记录
    return unit === 'g' ? a / 100 : null
  }

  if (unit === 'serving') return a
  if (unit === 'g') {
    const grams = gramsPerBasisUnit(basis)
    return grams ? a / grams : null
  }
  return null
}

/** 计算某个份量下的全部营养值；份量非法时返回 null */
export function nutritionForAmount(food, amount, unit) {
  const k = factorFor(food, amount, unit)
  if (k === null) return null
  const out = {}
  for (const field of NUTRIENTS) {
    const v = food[field]
    out[field] = typeof v === 'number' && isFinite(v) ? v * k : null
  }
  return out
}

/** 汇总多条 {营养字段: 数值}，null 视为 0 */
export function sumNutrients(parts) {
  const out = {}
  for (const field of NUTRIENTS) out[field] = 0
  for (const part of parts) {
    if (!part) continue
    for (const field of NUTRIENTS) {
      const v = part[field]
      if (typeof v === 'number' && isFinite(v)) out[field] += v
    }
  }
  return out
}

/** 三大营养素的供能占比，用于展示「营养素比例」 */
export function macroRatio(nutrients) {
  if (!nutrients) return null
  const p = (nutrients.proteinG || 0) * 4
  const f = (nutrients.fatG || 0) * 9
  const c = (nutrients.carbG || 0) * 4
  const total = p + f + c
  if (total <= 0) return null
  return { protein: p / total, fat: f / total, carb: c / total }
}
