/**
 * 热量缺口与饮食模式分析。
 *
 * 这是「增肌减脂」真正需要看的东西。
 *
 * 为什么单日缺口意义不大：一天的摄入和消耗各带几百 kcal 的噪音 ——
 * 某天算出缺口 1200，第二天又变成盈余 400，单看哪一天都会得出荒谬的结论。
 * 有意义的是**一段时间的累计缺口**，它把噪音平均掉了。
 *
 * 但累计有一个致命前提，见 summarizeRange：**不完整的日子必须被排除**。
 * 否则「忘了记晚饭」这一天会凭空贡献两千多 kcal 的假缺口。
 */

import { addDays, daysBetween } from './date.js'

/**
 * 约 7700 kcal 对应 1 kg 脂肪。
 *
 * ⚠️ 这是**粗略近似**，不是物理定律。源自 1958 年的 Wishnofsky 估算，
 * 现代研究认为实际减重会随体重下降而变慢（基础代谢降低、瘦体重流失），
 * 长期拿它折算会**高估**减重效果。
 *
 * 放在这里是为了给你量级感，不是让你当预言用。
 */
export const KCAL_PER_KG_FAT = 7700

/** 低于这个值算「偏低」，可能是记漏了 */
export const LOW_INTAKE_THRESHOLD = 800

/** 低于这个值算「极低」。长期如此通常意味着掉肌肉和代谢下降 */
export const VERY_LOW_INTAKE_THRESHOLD = 1000

export const REASON_COMPLETE = 'complete'
export const REASON_NO_INTAKE = 'no-intake'
export const REASON_NO_BURN = 'no-burn'
export const REASON_EMPTY = 'empty'

/**
 * 总消耗 = 活动 + 静息。
 * 缺哪一项按 0 计，**不猜**；两项都没有时返回 null，表示「不知道」，
 * 而不是「0 消耗」。
 */
export function totalBurn(record) {
  if (!record) return null
  const active = typeof record.activeKcal === 'number' ? record.activeKcal : null
  const resting = typeof record.restingKcal === 'number' ? record.restingKcal : null
  if (active === null && resting === null) return null
  return (active || 0) + (resting || 0)
}

/**
 * 把记录按天汇总成营养值。
 *
 * 走的是和当天页同一个 nutrientsOf（即 entryNutrients），
 * 避免出现「当天页显示 1800、趋势页算出 1850」这种两套算法打架的情况。
 */
export function dailyNutrients(entries, nutrientsOf) {
  const map = new Map()
  for (const entry of entries || []) {
    const nutrients = nutrientsOf(entry)
    if (!nutrients) continue
    const current = map.get(entry.date) || { energyKcal: 0, proteinG: 0, fatG: 0, carbG: 0 }
    current.energyKcal += nutrients.energyKcal || 0
    current.proteinG += nutrients.proteinG || 0
    current.fatG += nutrients.fatG || 0
    current.carbG += nutrients.carbG || 0
    map.set(entry.date, current)
  }
  return map
}

export function burnByDate(records) {
  const map = new Map()
  for (const record of records || []) {
    const total = totalBurn(record)
    if (total !== null) map.set(record.date, total)
  }
  return map
}

/**
 * 单日缺口。
 *
 * 符号约定：**balance = 消耗 − 摄入**
 *   正数 = 缺口（在减脂）
 *   负数 = 盈余（在增肌）
 * 让「缺口」在数值上是正数，符合中文里「我有 500 的缺口」的说法。
 */
export function dayBalance({ date, totals, burn }) {
  const intake = totals && typeof totals.energyKcal === 'number' ? totals.energyKcal : 0
  const proteinG = totals && typeof totals.proteinG === 'number' ? totals.proteinG : 0
  const intakeKnown = intake > 0
  const burnKnown = typeof burn === 'number' && isFinite(burn) && burn > 0

  if (!intakeKnown && !burnKnown) {
    return { date, intake: 0, proteinG: 0, burn: 0, balance: null, complete: false, reason: REASON_EMPTY }
  }
  if (!intakeKnown) {
    return { date, intake: 0, proteinG: 0, burn, balance: null, complete: false, reason: REASON_NO_INTAKE }
  }
  if (!burnKnown) {
    return { date, intake, proteinG, burn: 0, balance: null, complete: false, reason: REASON_NO_BURN }
  }

  return {
    date,
    intake,
    proteinG,
    burn,
    balance: burn - intake,
    complete: true,
    reason: REASON_COMPLETE,
    // 标记但不排除 —— 有人确实在做轻断食，不该替他决定那天不算数。
    // 界面会把这个数字说出来，由他自己判断是不是漏记。
    lowIntake: intake < LOW_INTAKE_THRESHOLD,
  }
}

/** 按日期把摄入与消耗对齐成逐日记录，区间两端都包含 */
export function buildDailyBalances({ from, to, totalsByDate, burnByDate: burnMap }) {
  const span = daysBetween(from, to)
  if (span === null || span < 0) return []

  const days = []
  for (let i = 0; i <= span; i++) {
    const date = addDays(from, i)
    days.push(dayBalance({
      date,
      totals: totalsByDate && totalsByDate.has(date) ? totalsByDate.get(date) : null,
      burn: burnMap && burnMap.has(date) ? burnMap.get(date) : null,
    }))
  }
  return days
}

/**
 * 区间汇总。
 *
 * **只累加完整的日子。** 这是这个函数里唯一真正重要的决定。
 *
 * 反例：某天你只记了早餐（300 kcal），忘了记晚饭，而消耗照常 2400。
 * 把这天算进去，它会贡献 2100 kcal 的假缺口 —— 足以让你误判整周进度，
 * 而且不会以任何形式报错。所以不完整的天一律排除，
 * 并把「排除了几天、为什么」原样报出来。
 */
export function summarizeRange(balances) {
  const all = balances || []
  const complete = all.filter((d) => d.complete)

  let totalIntake = 0
  let totalBurn = 0
  let totalProtein = 0
  for (const day of complete) {
    totalIntake += day.intake
    totalBurn += day.burn
    totalProtein += day.proteinG || 0
  }
  const totalBalance = totalBurn - totalIntake
  const countOf = (reason) => all.filter((d) => d.reason === reason).length

  return {
    days: all,
    totalDays: all.length,
    completeDays: complete.length,
    missingIntakeDays: countOf(REASON_NO_INTAKE),
    missingBurnDays: countOf(REASON_NO_BURN),
    emptyDays: countOf(REASON_EMPTY),
    lowIntakeDays: complete.filter((d) => d.lowIntake).length,
    veryLowIntakeDays: complete.filter((d) => d.intake < VERY_LOW_INTAKE_THRESHOLD).length,
    totalIntake,
    totalBurn,
    totalProtein,
    totalBalance,
    averageBalance: complete.length > 0 ? totalBalance / complete.length : null,
    averageIntake: complete.length > 0 ? totalIntake / complete.length : null,
    averageBurn: complete.length > 0 ? totalBurn / complete.length : null,
    averageProtein: complete.length > 0 ? totalProtein / complete.length : null,
    fatKg: totalBalance / KCAL_PER_KG_FAT,
  }
}

/** 把 balance 变成给人看的说法。正数缺口、负数盈余、零持平 */
export function describeBalance(balance) {
  if (typeof balance !== 'number' || !isFinite(balance)) {
    return { kind: 'unknown', label: '数据不全', value: null }
  }
  const rounded = Math.round(balance)
  if (rounded === 0) return { kind: 'even', label: '持平', value: 0 }
  if (rounded > 0) return { kind: 'deficit', label: '缺口', value: rounded }
  return { kind: 'surplus', label: '盈余', value: -rounded }
}

/**
 * 逐日累计缺口，用于画走势。
 *
 * 缺失的日子返回 null 而不是沿用前一天的值 —— 让折线在那里**断开**。
 * 沿用会画出一条平线，看起来像「那天刚好持平」，而事实是「那天我们不知道」。
 * 这两件事必须能被看出来。
 */
export function cumulativeSeries(days) {
  let acc = 0
  return (days || []).map((day) => {
    if (!day.complete) return null
    acc += day.balance
    return acc
  })
}
