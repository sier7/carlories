#!/usr/bin/env node
/**
 * core/ 的纯逻辑测试。
 *
 * 这一层之所以要和浏览器解耦，就是为了能用它跑测试。这里覆盖的是
 * 整个应用唯一「算错就会静默出错」的部分 —— 份量换算与营养计算。
 * 界面错了看得见，算错了看不见。
 *
 * 运行：node tools/test-core.mjs
 */

import {
  createFood,
  validateFood,
  factorFor,
  nutritionForAmount,
  gramsPerBasisUnit,
  energyPer100g,
  basisLabel,
  availableUnits,
  sumNutrients,
  macroRatio,
  toNumberOrNull,
  round,
  BASIS_PER_100G,
  BASIS_PER_SERVING,
} from '../app/core/food.js'

let passed = 0
let failed = 0

function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}\n      期望 ${e}\n      实际 ${a}`)
  }
}

function group(title) {
  console.log(`\n${title}`)
}

function approx(actual, expected, tolerance = 1e-9) {
  if (typeof actual !== 'number' || !isFinite(actual)) return false
  return Math.abs(actual - expected) <= tolerance
}

function checkApprox(name, actual, expected, tolerance) {
  if (approx(actual, expected, tolerance)) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}\n      期望 ≈${expected}\n      实际 ${actual}`)
  }
}

// 鸡蛋：每 100 g，143 kcal，蛋白 13、脂肪 9、碳水 1
const eggPer100g = createFood({
  name: '鸡蛋（全蛋）',
  basis: { type: BASIS_PER_100G },
  state: 'raw',
  energyKcal: 143,
  proteinG: 13,
  fatG: 9,
  carbG: 1,
})

// 某蛋白棒：每份 = 1 根 = 60 g，220 kcal，蛋白 20、脂肪 7、碳水 22
const barPerServing = createFood({
  name: '蛋白棒',
  basis: { type: BASIS_PER_SERVING, servingGrams: 60, servingLabel: '1 根' },
  state: 'na',
  energyKcal: 220,
  proteinG: 20,
  fatG: 7,
  carbG: 22,
})

// ── 数字解析 ────────────────────────────────────────────────────────────

group('数字解析')
check('空串 → null', toNumberOrNull(''), null)
check('纯空白 → null', toNumberOrNull('   '), null)
check('undefined → null', toNumberOrNull(undefined), null)
check('数字字符串', toNumberOrNull('143'), 143)
check('小数', toNumberOrNull('13.5'), 13.5)
check('带千分位逗号', toNumberOrNull('1,234'), 1234)
check('中文逗号', toNumberOrNull('1，234'), 1234)
check('非法文本 → null（不是 NaN）', toNumberOrNull('abc'), null)
check('负数字符串保留符号', toNumberOrNull('-5'), -5)

group('四舍五入')
check('round(142.6, 0)', round(142.6, 0), 143)
check('round(13.45, 1)', round(13.45, 1), 13.5)
check('round(null) → null', round(null, 0), null)

group('幂等：createFood 不改变传入对象')
const inputSnapshot = { name: '测试', energyKcal: 100, proteinG: 1, fatG: 1, carbG: 1 }
const before = JSON.stringify(inputSnapshot)
createFood(inputSnapshot)
check('原始对象未被修改', JSON.stringify(inputSnapshot), before)

// ── 份量换算 ────────────────────────────────────────────────────────────

group('份量换算 —— 每 100 g 条目')
check('100 g 的系数是 1', factorFor(eggPer100g, 100, 'g'), 1)
check('150 g 的系数是 1.5', factorFor(eggPer100g, 150, 'g'), 1.5)
check('50 g 的系数是 0.5', factorFor(eggPer100g, 50, 'g'), 0.5)
check('每 100 g 条目拒绝「份」', factorFor(eggPer100g, 1, 'serving'), null)
check('负份量返回 null', factorFor(eggPer100g, -5, 'g'), null)
check('空份量返回 null', factorFor(eggPer100g, '', 'g'), null)
check('可用单位只有 g', availableUnits(eggPer100g), ['g'])

group('份量换算 —— 每份条目')
check('1 份的系数是 1', factorFor(barPerServing, 1, 'serving'), 1)
check('2 份的系数是 2', factorFor(barPerServing, 2, 'serving'), 2)
check('60 g 等于 1 份', factorFor(barPerServing, 60, 'g'), 1)
check('30 g 等于半份', factorFor(barPerServing, 30, 'g'), 0.5)
check('可用单位含 g 与份', availableUnits(barPerServing), ['g', 'serving'])

// ── 营养计算 ────────────────────────────────────────────────────────────

group('营养计算')
const egg150 = nutritionForAmount(eggPer100g, 150, 'g')
checkApprox('150 g 鸡蛋热量 = 214.5', egg150.energyKcal, 214.5)
checkApprox('150 g 鸡蛋蛋白 = 19.5', egg150.proteinG, 19.5)
checkApprox('150 g 鸡蛋脂肪 = 13.5', egg150.fatG, 13.5)

const bar2 = nutritionForAmount(barPerServing, 2, 'serving')
checkApprox('2 份蛋白棒热量 = 440', bar2.energyKcal, 440)
checkApprox('2 份蛋白棒蛋白 = 40', bar2.proteinG, 40)

const barInGrams = nutritionForAmount(barPerServing, 30, 'g')
checkApprox('30 g 蛋白棒（等于半份）热量 = 110', barInGrams.energyKcal, 110)

group('关键一致性：克与份两条路径必须得到同一个数')
const viaServing = nutritionForAmount(barPerServing, 1.5, 'serving')
const viaGrams = nutritionForAmount(barPerServing, 90, 'g')
checkApprox('1.5 份 vs 90 g 热量一致', viaGrams.energyKcal, viaServing.energyKcal)
checkApprox('1.5 份 vs 90 g 蛋白一致', viaGrams.proteinG, viaServing.proteinG)

group('未填选的营养字段保持 null，而不是变成 0')
const noFiber = nutritionForAmount(eggPer100g, 100, 'g')
check('未填纤维 → null', noFiber.fiberG, null)
check('未填钠 → null', noFiber.sodiumMg, null)
check('已填热量 → 数值', noFiber.energyKcal, 143)

// ── 基准量折算 ──────────────────────────────────────────────────────────

group('基准量折算')
check('每 100 g 条目的基准克重', gramsPerBasisUnit(eggPer100g.basis), 100)
check('每份条目的基准克重', gramsPerBasisUnit(barPerServing.basis), 60)
check('每 100 g 折算仍是原值', energyPer100g(eggPer100g), 143)
checkApprox('每份条目折算成每 100 g', energyPer100g(barPerServing), 220 * (100 / 60))
check('基准量描述（每100g）', basisLabel(eggPer100g), '每 100 g')
check('基准量描述（每份）', basisLabel(barPerServing), '每 1 根（60 g）')

// ── 校验 ────────────────────────────────────────────────────────────────

group('校验：阻断性错误')
check('缺名称报错', validateFood(createFood({ ...eggPer100g, name: '' })).errors.length > 0, true)
check(
  '每份但没填克重 —— 不再是错误（外食的「1 碗」本来就不知道多少克）',
  validateFood(createFood({ ...barPerServing, basis: { type: BASIS_PER_SERVING } })).errors,
  [],
)
check(
  '但会明确告诉你这条只能用「份」记录',
  validateFood(createFood({ ...barPerServing, basis: { type: BASIS_PER_SERVING } })).warnings.some(
    (w) => w.includes('每份克重'),
  ),
  true,
)
check(
  '每份克重填 0 仍然报错（那是填错了，不是留空）',
  validateFood(
    createFood({ ...barPerServing, basis: { type: BASIS_PER_SERVING, servingGrams: 0 } }),
  ).errors.length > 0,
  true,
)
check(
  '缺热量 → 报错',
  validateFood(createFood({ ...eggPer100g, energyKcal: null })).errors.some((e) =>
    e.includes('热量'),
  ),
  true,
)
check(
  '负数 → 报错',
  validateFood(createFood({ ...eggPer100g, proteinG: -1 })).errors.some((e) =>
    e.includes('负数'),
  ),
  true,
)

group('校验：只有热量是必填')
const onlyKcal = createFood({
  name: '只知道热量的东西',
  basis: { type: 'per100g' },
  energyKcal: 250,
})
check('三大营养素全空也能通过校验', validateFood(onlyKcal).errors, [])
check(
  '但会提示无法统计营养素比例',
  validateFood(onlyKcal).warnings.some((w) => w.includes('营养素比例')),
  true,
)
check('热量缺失仍然被拦住', validateFood(createFood({ name: 'x' })).errors.length > 0, true)
check(
  '填了负的蛋白质仍然被拦住（选填不等于可以不合法）',
  validateFood(createFood({ ...onlyKcal, proteinG: -3 })).errors.length > 0,
  true,
)

group('校验：一份合法数据不应产生任何错误')
check('鸡蛋无错误', validateFood(eggPer100g).errors, [])
check('蛋白棒无错误', validateFood(barPerServing).errors, [])

group('校验：一致性告警（数据质量，不阻断保存）')
const eggWarnings = validateFood(eggPer100g).warnings
check('143 kcal vs 4/9/4 算出的 137 kcal，容差内不告警', eggWarnings.length, 0)

const typoFood = createFood({
  name: '打错一位的条目',
  basis: { type: BASIS_PER_100G },
  energyKcal: 143,
  proteinG: 30,
  fatG: 20,
  carbG: 60,
})
check(
  '营养素算出的热量严重对不上 → 告警',
  validateFood(typoFood).warnings.some((w) => w.includes('对不上')),
  true,
)

const impossible = createFood({
  name: '每 100 g 超过纯油脂',
  basis: { type: BASIS_PER_100G },
  energyKcal: 950,
  proteinG: 0,
  fatG: 100,
  carbG: 0,
})
check(
  '每 100 g 超过 900 kcal → 告警',
  validateFood(impossible).warnings.some((w) => w.includes('900')),
  true,
)

const misleading = createFood({
  name: '每份很小但热量很高',
  basis: { type: BASIS_PER_SERVING, servingGrams: 10 },
  energyKcal: 200,
  proteinG: 0,
  fatG: 22,
  carbG: 0,
})
check(
  '每份 10 g 却有 200 kcal（折合每 100 g 为 2000）→ 告警',
  validateFood(misleading).warnings.some((w) => w.includes('900')),
  true,
)

const onlyEnergy = createFood({
  name: '只填热量',
  basis: { type: BASIS_PER_100G },
  energyKcal: 300,
  proteinG: 0,
  fatG: 0,
  carbG: 0,
})
check(
  '只填热量、三大营养素全零 → 提示',
  validateFood(onlyEnergy).warnings.some((w) => w.includes('营养素比例')),
  true,
)

group('校验：有错误时不产出告警（避免噪音）')
const brokenAndInconsistent = validateFood(
  createFood({ name: '', energyKcal: null, proteinG: 30, fatG: 20, carbG: 60 }),
)
check('有阻断错误时 warnings 为空', brokenAndInconsistent.warnings, [])

// ── 汇总与比例 ──────────────────────────────────────────────────────────

group('汇总与三大营养素比例')
const total = sumNutrients([nutritionForAmount(eggPer100g, 100, 'g'), barInGrams])
checkApprox('热量汇总 = 143 + 110', total.energyKcal, 253)
checkApprox('蛋白汇总 = 13 + 10', total.proteinG, 23)

const ratio = macroRatio({ proteinG: 100, fatG: 50, carbG: 100 })
// 蛋白 400 kcal、脂肪 450 kcal、碳水 400 kcal，合计 1250
checkApprox('蛋白供能占比', ratio.protein, 400 / 1250)
checkApprox('脂肪供能占比', ratio.fat, 450 / 1250)
checkApprox('碳水供能占比', ratio.carb, 400 / 1250)
check('空输入的比例为 null', macroRatio({ proteinG: 0, fatG: 0, carbG: 0 }), null)

group('汇总时 null 视为 0')
const withNulls = sumNutrients([{ energyKcal: 100, proteinG: null }, { energyKcal: 50 }])
checkApprox('null 不污染总和', withNulls.energyKcal, 150)
checkApprox('缺失字段计为 0', withNulls.proteinG, 0)

// ── 生熟场景 ────────────────────────────────────────────────────────────

group('生熟并存：两者是合法且必须区分的独立条目')
const rawRice = createFood({
  name: '大米（生）',
  basis: { type: BASIS_PER_100G },
  state: 'raw',
  energyKcal: 346,
  proteinG: 7.4,
  fatG: 0.8,
  carbG: 77.9,
})
const cookedRice = createFood({
  name: '米饭（熟）',
  basis: { type: BASIS_PER_100G },
  state: 'cooked',
  energyKcal: 130,
  proteinG: 2.6,
  fatG: 0.3,
  carbG: 28.6,
})
check('生米状态为 raw', rawRice.state, 'raw')
check('熟饭状态为 cooked', cookedRice.state, 'cooked')
check(
  '同样 100 g，生米热量是熟饭的 2.6 倍以上（这正是必须区分的原因）',
  rawRice.energyKcal / cookedRice.energyKcal > 2.5,
  true,
)
check('两条都能通过校验', [
  ...validateFood(rawRice).errors,
  ...validateFood(cookedRice).errors,
], [])

// ── 日期工具 ────────────────────────────────────────────────────────────

group('日期：按本地日历字段构造，不走 UTC')
{
  const { dateKey, timeKey, addDays, parseDateKey, dateLabel, daysBetween, isValidDateKey } =
    await import('../app/core/date.js')

  check('dateKey 用本地时间', dateKey(new Date(2026, 9, 3)), '2026-10-03')
  check('月份补零', dateKey(new Date(2026, 0, 5)), '2026-01-05')
  check('timeKey 补零', timeKey(new Date(2026, 9, 3, 7, 4)), '07:04')

  // 这个用例是整段日期逻辑存在的理由：东八区晚上 8 点之后，
  // toISOString() 会给出第二天，于是「今天的记录」会被算到明天去。
  check(
    '本地时间的晚上不会被算成第二天',
    dateKey(new Date(2026, 9, 3, 23, 30)),
    '2026-10-03',
  )

  check('addDays 跨月', addDays('2026-10-31', 1), '2026-11-01')
  check('addDays 跨年', addDays('2026-12-31', 1), '2027-01-01')
  check('addDays 回退跨月', addDays('2026-03-01', -1), '2026-02-28')
  check('addDays 闰年 2 月', addDays('2028-02-28', 1), '2028-02-29')

  check('parseDateKey 正常', parseDateKey('2026-10-03'), { year: 2026, month: 10, day: 3 })
  check('parseDateKey 拒绝 2 月 30 日（不被 Date 自动进位骗过）', parseDateKey('2026-02-30'), null)
  check('parseDateKey 拒绝乱格式', parseDateKey('2026/10/03'), null)
  check('isValidDateKey', isValidDateKey('2026-10-03'), true)

  check('dateLabel：今天', dateLabel('2026-10-03', '2026-10-03'), '今天')
  check('dateLabel：昨天', dateLabel('2026-10-02', '2026-10-03'), '昨天')
  check('dateLabel：具体日期带星期', dateLabel('2026-09-28', '2026-10-03'), '9 月 28 日 周一')
  check('dateLabel：跨年带年份', dateLabel('2025-09-28', '2026-10-03'), '2025 年 9 月 28 日 周日')

  check('daysBetween', daysBetween('2026-10-01', '2026-10-03'), 2)
  check('daysBetween 反向为负', daysBetween('2026-10-03', '2026-10-01'), -2)
}

// ── 记录条目 ────────────────────────────────────────────────────────────

group('记录条目：快照、汇总、变更检测')
{
  const {
    snapshotFromFood,
    createLogEntry,
    buildEntryFromFood,
    entryNutrients,
    summarizeEntries,
    sortEntries,
    isEntryStale,
    refreshEntrySnapshot,
    withAmount,
    validateEntry,
  } = await import('../app/core/log.js')

  const egg = createFood({
    name: '鸡蛋（全蛋）',
    basis: { type: 'per100g' },
    state: 'raw',
    energyKcal: 143,
    proteinG: 13,
    fatG: 9,
    carbG: 1,
  })

  const snap = snapshotFromFood(egg)
  check('快照保留名称', snap.name, '鸡蛋（全蛋）')
  check('快照保留基准量', snap.basis, { type: 'per100g' })
  check('快照记录了食物版本戳', snap.foodUpdatedAt, egg.updatedAt)

  const entry = buildEntryFromFood({ food: egg, amount: 150, unit: 'g', date: '2026-10-03', time: '08:12' })
  checkApprox('150 g 记录贡献 214.5 kcal', entryNutrients(entry).energyKcal, 214.5)
  checkApprox('150 g 记录贡献 19.5 g 蛋白', entryNutrients(entry).proteinG, 19.5)
  check('记录通过校验', validateEntry(entry).errors, [])

  group('快照保证历史不被追溯改写')
  const edited = { ...egg, energyKcal: 200, updatedAt: new Date(Date.now() + 1000).toISOString() }
  checkApprox(
    '食物改值后，已有记录的数值不变',
    entryNutrients(entry).energyKcal,
    214.5,
  )
  check('但会被标记为用了旧数据', isEntryStale(entry, edited), true)
  check('未改动的食物不算过期', isEntryStale(entry, egg), false)

  const refreshed = refreshEntrySnapshot(entry, edited)
  checkApprox(
    '显式刷新后才按新值计算',
    entryNutrients(refreshed).energyKcal,
    300,
  )
  check('刷新后不再标记为旧数据', isEntryStale(refreshed, edited), false)

  check('食物被删除时不算过期（快照仍可用）', isEntryStale(entry, null), false)

  group('只改份量，不动快照')
  const bigger = withAmount(entry, 300, 'g')
  checkApprox('改成 300 g 后翻倍', entryNutrients(bigger).energyKcal, 429)
  check('快照本身未被替换', bigger.snapshot.foodUpdatedAt, entry.snapshot.foodUpdatedAt)

  group('当量换算：每份条目按克记录')
  const bar = createFood({
    name: '蛋白棒',
    basis: { type: 'perServing', servingGrams: 60, servingLabel: '1 根' },
    energyKcal: 220,
    proteinG: 20,
    fatG: 7,
    carbG: 22,
  })
  const barEntry = buildEntryFromFood({ food: bar, amount: 90, unit: 'g', date: '2026-10-03', time: '15:00' })
  checkApprox('90 g = 1.5 份 = 330 kcal', entryNutrients(barEntry).energyKcal, 330)

  const noGrams = createFood({
    name: '只知道每份、不知道克重',
    basis: { type: 'perServing' },
    energyKcal: 100,
    proteinG: 1,
    fatG: 1,
    carbG: 1,
  })
  check('没有克重的每份条目：可用单位只剩「份」', availableUnits(noGrams), ['serving'])

  const serveEntry = buildEntryFromFood({
    food: noGrams, amount: 1, unit: 'serving', date: '2026-10-03', time: '15:00',
  })
  check('按份记录是合法的', validateEntry(serveEntry).errors, [])
  checkApprox('1 份 = 100 kcal', entryNutrients(serveEntry).energyKcal, 100)

  const badEntry = buildEntryFromFood({
    food: noGrams, amount: 50, unit: 'g', date: '2026-10-03', time: '15:00',
  })
  check('同一份数据按克记录被拦住', validateEntry(badEntry).errors.length > 0, true)
  check('份量为 0 → 校验拦住', validateEntry(withAmount(entry, 0, 'g')).errors.length > 0, true)
  check('缺日期 → 校验拦住', validateEntry({ ...entry, date: '' }).errors.length > 0, true)

  group('当日汇总')
  const rice = createFood({
    name: '米饭（熟）',
    basis: { type: 'per100g' },
    state: 'cooked',
    energyKcal: 130,
    proteinG: 2.6,
    fatG: 0.3,
    carbG: 28.6,
  })
  const riceEntry = buildEntryFromFood({ food: rice, amount: 200, unit: 'g', date: '2026-10-03', time: '12:30' })

  const summary = summarizeEntries([entry, riceEntry])
  checkApprox('热量汇总 = 214.5 + 260', summary.totals.energyKcal, 474.5)
  checkApprox('蛋白汇总 = 19.5 + 5.2', summary.totals.proteinG, 24.7)
  checkApprox('碳水汇总 = 1.5 + 57.2', summary.totals.carbG, 58.7)
  check('明细条数', summary.items.length, 2)

  const manualSum =
    entryNutrients(entry).energyKcal + entryNutrients(riceEntry).energyKcal
  check(
    '汇总走的和逐条相加是同一条计算路径（不存在两套算法）',
    Math.abs(manualSum - summary.totals.energyKcal) < 1e-9,
    true,
  )

  group('排序：按时间，同日按创建顺序')
  const out = sortEntries([
    { time: '18:00', createdAt: 'c' },
    { time: '08:12', createdAt: 'a' },
    { time: '12:30', createdAt: 'b' },
  ])
  check('时间升序', out.map((e) => e.time), ['08:12', '12:30', '18:00'])

  group('空集合的汇总不产生 NaN')
  const emptySummary = summarizeEntries([])
  check('热量为 0', emptySummary.totals.energyKcal, 0)
  check('明细为空', emptySummary.items.length, 0)
}

// ── 自由填写：不依赖食物库的记录 ────────────────────────────────────────

group('自由填写：记录不依赖食物库')
{
  const {
    buildFreeEntry,
    buildEntryFromFood,
    isFreeEntry,
    entryHasMacros,
    withFreeValues,
    entryNutrients,
    validateEntry,
  } = await import('../app/core/log.js')

  const free = buildFreeEntry({
    name: '楼下牛肉面',
    energyKcal: 800,
    date: '2026-10-03',
    time: '12:30',
  })

  check('自由条目不引用任何食物库条目', free.refId, null)
  check('isFreeEntry 认得出来', isFreeEntry(free), true)
  checkApprox('一条自由记录贡献 800 kcal', entryNutrients(free).energyKcal, 800)
  check('只填热量也能通过校验', validateEntry(free).errors, [])
  check('基准量是「1 份」', free.snapshot.basis.type, 'perServing')
  check('没有每份克重（外食本来就不称重）', free.snapshot.basis.servingGrams, null)
  check('份量是 1 份', [free.amount, free.unit], [1, 'serving'])
  check('未填营养素 → entryHasMacros 为假', entryHasMacros(free), false)

  check(
    '缺名称被拦住',
    validateEntry({ ...free, snapshot: { ...free.snapshot, name: '' } }).errors.length > 0,
    true,
  )
  check(
    '缺热量被拦住',
    validateEntry({ ...free, snapshot: { ...free.snapshot, energyKcal: null } }).errors.length > 0,
    true,
  )

  const withMacros = buildFreeEntry({
    name: '便利店三明治',
    energyKcal: 320,
    proteinG: 15,
    fatG: 12,
    carbG: 36,
    date: '2026-10-03',
    time: '08:00',
  })
  check('填了营养素 → entryHasMacros 为真', entryHasMacros(withMacros), true)

  group('食物库来的记录不算自由条目，且天然带完整营养素')
  const egg = createFood({
    name: '鸡蛋（全蛋）',
    basis: { type: 'per100g' },
    state: 'raw',
    energyKcal: 143,
    proteinG: 13,
    fatG: 9,
    carbG: 1,
  })
  const eggEntry = buildEntryFromFood({ food: egg, amount: 100, unit: 'g', date: '2026-10-03', time: '08:00' })
  check('来自食物库 → 不是自由条目', isFreeEntry(eggEntry), false)
  check('来自食物库 → 有完整营养素', entryHasMacros(eggEntry), true)

  group('编辑自由条目：改的是数值，不是份量')
  const edited = withFreeValues(free, { name: '牛肉面（大碗）', energyKcal: 950 })
  checkApprox('改成 950 kcal', entryNutrients(edited).energyKcal, 950)
  check('名称同步更新', edited.snapshot.name, '牛肉面（大碗）')
  check('id 不变（还是一条记录，不是新建）', edited.id, free.id)
  check('仍是 1 份', [edited.amount, edited.unit], [1, 'serving'])
  check('编辑后仍能通过校验', validateEntry(edited).errors, [])

  group('自由条目与食物库条目能一起汇总')
  const { summarizeEntries } = await import('../app/core/log.js')
  const mixed = summarizeEntries([free, eggEntry])
  checkApprox('热量 = 800 + 143', mixed.totals.energyKcal, 943)
  checkApprox('蛋白只算得到鸡蛋那份', mixed.totals.proteinG, 13)
}

// ── 历史索引：记过的东西自动成为可再调取的条目 ──────────────────────────

group('历史索引')
{
  const { buildHistoryIndex, resolveHistory, historyKey } = await import('../app/core/history.js')
  const { buildEntryFromFood, buildFreeEntry } = await import('../app/core/log.js')

  const egg = createFood({
    name: '鸡蛋（全蛋）',
    basis: { type: 'per100g' },
    state: 'raw',
    energyKcal: 143,
    proteinG: 13,
    fatG: 9,
    carbG: 1,
  })

  // 必须按时间倒序传入
  const entries = [
    buildFreeEntry({ name: '楼下牛肉面', energyKcal: 650, date: '2026-10-03', time: '12:30' }),
    buildEntryFromFood({ food: egg, amount: 150, unit: 'g', date: '2026-10-03', time: '08:00' }),
    buildFreeEntry({ name: '楼下牛肉面', energyKcal: 800, date: '2026-10-01', time: '12:30' }),
    buildEntryFromFood({ food: egg, amount: 100, unit: 'g', date: '2026-10-01', time: '08:00' }),
    buildFreeEntry({ name: '公司楼下的沙拉', energyKcal: 400, date: '2026-09-30', time: '12:00' }),
  ]

  const index = buildHistoryIndex(entries)

  check('五条记录去重成三条条目', index.length, 3)
  check('最近记录过的排最前', index[0].snapshot.name, '楼下牛肉面')
  check('重名条目保留**最近一次**的数值（650 而不是 800）', index[0].snapshot.energyKcal, 650)
  check('记录次数统计正确', index[0].times, 2)
  check('食物库条目也统计了次数', index[1].times, 2)
  check('保留最近一次的份量', [index[1].lastAmount, index[1].lastUnit], [150, 'g'])
  check('自由条目被标记为 free', index[0].free, true)
  check('食物库条目不被标记为 free', index[1].free, false)

  // repeatKcal 是 resolveHistory 算出来的 —— 「再记一次会加多少」要看条目的当前值，
  // 所以它必须挂在解析后的条目上，而不是原始索引上
  const baseline = resolveHistory(index, [egg])
  check('再记一次会加多少：自由条目就是那个数', baseline[0].repeatKcal, 650)
  checkApprox('再记一次会加多少：按克条目要乘份量', baseline[1].repeatKcal, 143 * 1.5)

  check('去重键：食物库条目按 id', historyKey(entries[1]), `food:${egg.id}`)
  check('去重键：自由条目按名称', historyKey(entries[0]), 'free:楼下牛肉面')

  group('历史是捷径，不是冻结的副本')
  const editedEgg = { ...egg, energyKcal: 200, updatedAt: new Date(Date.now() + 1000).toISOString() }
  const resolved = resolveHistory(index, [editedEgg])
  const eggItem = resolved.find((i) => i.refId === egg.id)

  check('食物还在 → 用食物的**当前**值', eggItem.source.energyKcal, 200)
  checkApprox('因此再记一次会加 300（150 g × 2.0）', eggItem.repeatKcal, 300)
  check('没有被标记为食物已删', eggItem.missingFromLibrary, false)

  group('食物被删掉之后')
  const orphaned = resolveHistory(index, []).find((i) => i.refId === egg.id)
  check('退回用它当初的快照', orphaned.source.energyKcal, 143)
  check('并标记出来', orphaned.missingFromLibrary, true)
  check('refId 仍然保留（这样它还是按份量编辑，不会被当成手填条目）', orphaned.repeatRefId, egg.id)

  group('历史里的自由条目')
  const freeItem = resolveHistory(index, [])[0]
  check('source 就是它自己的快照', freeItem.source.energyKcal, 650)
  check('再记一次仍然是 650', freeItem.repeatKcal, 650)
}

// ── 健康数据同步载荷 ────────────────────────────────────────────────────

group('健康数据同步：剪贴板载荷解析')
{
  const {
    parseHealthPayload,
    formatHealthPayload,
    looksLikeHealthPayload,
    recordForDate,
    describeRecords,
  } = await import('../app/core/healthSync.js')

  const sample = 'CAL/2026-10-03\nACT=842\nRST=1710'
  const parsed = parseHealthPayload(sample)
  const one = parsed.records[0]

  check('解析出一天', parsed.records.length, 1)
  check('日期正确', one.date, '2026-10-03')
  check('活动能量', one.activeKcal, 842)
  check('静息能量', one.restingKcal, 1710)
  check('来源标为快捷指令', one.source, 'shortcut')
  check('没有报错', parsed.problems, [])

  const twoDays = parseHealthPayload(
    'CAL/2026-10-03\nACT=842\nRST=1710\n\nCAL/2026-10-02\nACT=950\nRST=1690',
  )
  check('可以一次带多天（用于补录）', twoDays.records.length, 2)
  check('第二天也被正确解析', twoDays.records[1].activeKcal, 950)

  check(
    '幂等：同一份载荷重复解析结果完全一致',
    JSON.stringify(parseHealthPayload(sample)),
    JSON.stringify(parsed),
  )

  group('容错：快捷指令里拼出来的字符串不会总是规整')
  check('容忍空格与全角冒号', parseHealthPayload('CAL/2026-10-03\nACT : 842\nRST：1710').records[0].restingKcal, 1710)
  check('容忍千分位逗号', parseHealthPayload('CAL/2026-10-03\nACT=1,842\nRST=1,710').records[0].activeKcal, 1842)
  check('容忍中文逗号', parseHealthPayload('CAL/2026-10-03\nACT=1，842').records[0].activeKcal, 1842)
  check('容忍小写', parseHealthPayload('cal/2026-10-03\nact=842\nrst=1710').records[0].activeKcal, 842)
  check('只有 ACT 也能用（表没戴满一天）', parseHealthPayload('CAL/2026-10-03\nACT=842').records.length, 1)
  check('多余空行不影响', parseHealthPayload('\n\nCAL/2026-10-03\n\nACT=842\n\n').records.length, 1)

  group('坏输入：说清楚坏在哪，而不是崩或者静默吞掉')
  check('空剪贴板', parseHealthPayload('').problems[0], '剪贴板是空的')
  check('不是健康数据时点名格式', parseHealthPayload('随便什么东西').problems[0].includes('CAL/'), true)
  check('缺日期行时报错', parseHealthPayload('ACT=842').problems.length > 0, true)
  check('负数被拒绝', parseHealthPayload('CAL/2026-10-03\nACT=-5').records.length, 0)
  check(
    '一天坏掉不影响同份载荷里的其他天',
    (() => {
      const r = parseHealthPayload('CAL/2026-10-03\nACT=842\n什么鬼\n\nCAL/2026-10-02\nACT=100')
      return r.records.length === 2 && r.problems.length === 1
    })(),
    true,
  )

  group('CAL/TODAY：让快捷指令不必碰「格式化日期」')
  const todayPayload = parseHealthPayload('CAL/TODAY\nACT=842\nRST=1710', { today: '2026-10-03' })
  check('TODAY 被解析成传入的当天', todayPayload.records[0].date, '2026-10-03')
  check('数值照常', todayPayload.records[0].activeKcal, 842)
  check('解析后看不出区别（存进库的是具体日期）', todayPayload.problems.length, 0)
  check(
    '没告诉它今天是几号时明确报错，而不是存成一条没有日期的记录',
    parseHealthPayload('CAL/TODAY\nACT=842').records.length,
    0,
  )
  check(
    '并且说明原因',
    parseHealthPayload('CAL/TODAY\nACT=842').problems.some((p) => p.includes('TODAY')),
    true,
  )
  check(
    'TODAY 与具体日期可以混用（补录历史 + 今天）',
    parseHealthPayload('CAL/2026-10-01\nACT=900\n\nCAL/TODAY\nACT=842', { today: '2026-10-03' })
      .records.length,
    2,
  )

  group('单位后缀：快捷指令插进来的值可能不是纯数字')
  check('带 kcal 后缀', parseHealthPayload('CAL/2026-10-03\nACT=842 kcal').records[0].activeKcal, 842)
  check('带千卡后缀', parseHealthPayload('CAL/2026-10-03\nRST=1710 千卡').records[0].restingKcal, 1710)
  check('小数', parseHealthPayload('CAL/2026-10-03\nACT=842.53').records[0].activeKcal, 842.53)
  check('小数+单位', parseHealthPayload('CAL/2026-10-03\nACT=842.53 kcal').records[0].activeKcal, 842.53)
  check('数字与单位之间没空格', parseHealthPayload('CAL/2026-10-03\nACT=842kcal').records[0].activeKcal, 842)
  check('带千分位与单位', parseHealthPayload('CAL/2026-10-03\nACT=1,842 kcal').records[0].activeKcal, 1842)

  // 这一条是防回归：惰性量词会让 "842" 变成 数字 8 + 单位 "42"，
  // 于是每一次真实同步的数字都错得离谱，而且看起来毫无异常。
  check('多位数不能被拆散（842 必须是 842，不是 8）', () => {
    const r = parseHealthPayload('CAL/2026-10-03\nACT=842\nRST=1710')
    assert.equal(r.records[0].activeKcal, 842)
    assert.equal(r.records[0].restingKcal, 1710)
  })

  check(
    '千焦被拦下（大 4.184 倍，且数字看起来很合理，最难自己发现）',
    parseHealthPayload('CAL/2026-10-03\nACT=3525 kJ').records.length,
    0,
  )
  check(
    '并且说明该怎么办',
    parseHealthPayload('CAL/2026-10-03\nACT=3525 kJ').problems.some((p) => p.includes('千卡')),
    true,
  )
  check(
    '中文「千焦」同样拦下',
    parseHealthPayload('CAL/2026-10-03\nACT=3525 千焦').records.length,
    0,
  )
  check(
    '看不懂的后缀会被说出来，但数字仍然采用',
    (() => {
      const r = parseHealthPayload('CAL/2026-10-03\nACT=842 什么鬼')
      return r.records.length === 1 && r.records[0].activeKcal === 842 && r.problems.length === 1
    })(),
    true,
  )

  group('中继配置串：让手机上只需粘贴一次，而不用敲 32 位口令')
  {
    const {
      parseRelayConfig,
      formatRelayConfig,
      normalizeEndpoint,
      buildRelayUrl,
      RELAY_CONFIG_PREFIX,
    } = await import('../app/core/healthSync.js')

    const sample = `${RELAY_CONFIG_PREFIX}https://carlories-relay.abc.workers.dev|s3cretToken_-abc123`
    const parsed = parseRelayConfig(sample)

    check('解析出地址', parsed.endpoint, 'https://carlories-relay.abc.workers.dev')
    check('解析出口令', parsed.token, 's3cretToken_-abc123')
    check('标记为完整', parsed.incomplete, false)
    check('往返一致', formatRelayConfig(parsed), sample)

    check('容忍前后空白与换行', parseRelayConfig(`\n  ${sample}  \n`).token, 's3cretToken_-abc123')
    check('地址末尾的斜杠被去掉', parseRelayConfig(
      `${RELAY_CONFIG_PREFIX}https://x.workers.dev/|tok`,
    ).endpoint, 'https://x.workers.dev')

    check('只粘一个地址时也认得，但标为不完整', parseRelayConfig('https://x.workers.dev').incomplete, true)
    check('只有地址时没有口令', parseRelayConfig('https://x.workers.dev').token, null)

    check('乱七八糟的文本 → null', parseRelayConfig('随便什么东西'), null)
    check('空串 → null', parseRelayConfig(''), null)
    check('前缀对但没有分隔符 → null', parseRelayConfig(`${RELAY_CONFIG_PREFIX}abc`), null)
    check('地址不是 http(s) → null', parseRelayConfig(`${RELAY_CONFIG_PREFIX}ftp://x|tok`), null)
    check('口令为空 → null', parseRelayConfig(`${RELAY_CONFIG_PREFIX}https://x.workers.dev|`), null)

    check('口令里含竖线时按最后一个竖线切分（base64url 不会含，但防御一下）', () => {
      const r = parseRelayConfig(`${RELAY_CONFIG_PREFIX}https://x.workers.dev|a|b`)
      assert.equal(r.endpoint, 'https://x.workers.dev|a')
      assert.equal(r.token, 'b')
    })

    check('normalizeEndpoint 去掉尾部斜杠', normalizeEndpoint('https://x.dev///'), 'https://x.dev')
    check('拉取地址带上区间', buildRelayUrl('https://x.dev/', '2026-10-01', '2026-10-03'),
      'https://x.dev/days?from=2026-10-01&to=2026-10-03')
  }

  group('格式识别与回写')
  check('认得出自己的载荷', looksLikeHealthPayload('  \nCAL/2026-10-03'), true)
  check('不会把别的文本误认成载荷', looksLikeHealthPayload('CALORIES 800'), false)
  check('往返一致（写出去再读回来不变）', formatHealthPayload(parsed.records), sample)

  group('取用')
  check('挑出指定那天的记录', recordForDate(parsed.records, '2026-10-03').activeKcal, 842)
  check('找不到时返回 null', recordForDate(parsed.records, '2020-01-01'), null)
  check('摘要里带上日期与两个数', describeRecords([one]).includes('842'), true)
  check('没有数据时摘要不为空', describeRecords([]), '没有可用数据')
}

// ── 热量缺口与饮食模式 ──────────────────────────────────────────────────

group('热量缺口：单日、累计、以及折算成体重变化')
{
  const {
    totalBurn,
    dayBalance,
    buildDailyBalances,
    dailyNutrients,
    burnByDate,
    summarizeRange,
    describeBalance,
    cumulativeSeries,
    KCAL_PER_KG_FAT,
  } = await import('../app/core/balance.js')
  const { buildEntryFromFood, buildFreeEntry, entryNutrients } = await import('../app/core/log.js')

  group('总消耗')
  check('活动 + 静息', totalBurn({ activeKcal: 800, restingKcal: 1650 }), 2450)
  check('只有活动（表没戴满一天）', totalBurn({ activeKcal: 800, restingKcal: null }), 800)
  check('两项都缺 → null，而不是 0（0 会被当成「一整天没消耗」）', totalBurn({ activeKcal: null, restingKcal: null }), null)
  check('没有记录 → null', totalBurn(null), null)

  group('单日缺口：符号约定是「消耗 − 摄入」')
  const def = dayBalance({ date: '2026-10-03', totals: { energyKcal: 2000, proteinG: 120 }, burn: 2600 })
  check('摄入 2000、消耗 2600 → 缺口 600（正数）', def.balance, 600)
  check('这一天是完整的', def.complete, true)

  const sur = dayBalance({ date: '2026-10-03', totals: { energyKcal: 3200, proteinG: 150 }, burn: 2600 })
  check('摄入 3200、消耗 2600 → 盈余 600（负数）', sur.balance, -600)

  const noBurn = dayBalance({ date: '2026-10-03', totals: { energyKcal: 2000 }, burn: null })
  check('缺消耗 → 不完整，且缺口为 null 而不是硬算', [noBurn.complete, noBurn.balance], [false, null])
  check('原因标为缺消耗', noBurn.reason, 'no-burn')

  const noIntake = dayBalance({ date: '2026-10-03', totals: null, burn: 2600 })
  check('缺饮食 → 不完整', [noIntake.complete, noIntake.reason], [false, 'no-intake'])

  const empty = dayBalance({ date: '2026-10-03', totals: null, burn: null })
  check('两者都缺 → empty', empty.reason, 'empty')

  group('按天汇总摄入：和当天页走同一条计算路径')
  const egg = createFood({
    name: '鸡蛋（全蛋）', basis: { type: 'per100g' }, state: 'raw',
    energyKcal: 143, proteinG: 13, fatG: 9, carbG: 1,
  })
  const entries = [
    buildEntryFromFood({ food: egg, amount: 100, unit: 'g', date: '2026-10-03', time: '08:00' }),
    buildEntryFromFood({ food: egg, amount: 200, unit: 'g', date: '2026-10-03', time: '12:00' }),
    buildFreeEntry({ name: '外食', energyKcal: 700, proteinG: 30, date: '2026-10-04', time: '12:00' }),
  ]
  const totals = dailyNutrients(entries, entryNutrients)
  checkApprox('同一天的两条记录被加在一起（143 + 286）', totals.get('2026-10-03').energyKcal, 429)
  checkApprox('蛋白质也累加（13 + 26）', totals.get('2026-10-03').proteinG, 39)
  check('另一天单独统计', totals.get('2026-10-04').energyKcal, 700)

  group('★ 累计缺口只算完整的日子')
  {
    const days = buildDailyBalances({
      from: '2026-10-01',
      to: '2026-10-04',
      totalsByDate: new Map([
        ['2026-10-01', { energyKcal: 2000, proteinG: 130 }],
        // 10-02 只记了早餐就忘了晚饭 —— 这是最危险的情况
        ['2026-10-02', { energyKcal: 300, proteinG: 20 }],
        ['2026-10-03', { energyKcal: 2100, proteinG: 140 }],
        ['2026-10-04', { energyKcal: 1900, proteinG: 125 }],
      ]),
      burnByDate: new Map([
        ['2026-10-01', 2600],
        ['2026-10-02', 2550],
        ['2026-10-03', 2650],
        // 10-04 没有消耗数据
      ]),
    })

    check('生成了 4 天', days.length, 4)

    const summary = summarizeRange(days)
    check('完整 3 天', summary.completeDays, 3)
    check('1 天缺消耗', summary.missingBurnDays, 1)
    check('缺消耗那天不计入（否则它会凭空贡献 1900 的假缺口）',
      [days[3].complete, days[3].balance], [false, null])
    checkApprox('累计摄入只含 3 天', summary.totalIntake, 2000 + 300 + 2100)
    checkApprox('累计消耗只含 3 天', summary.totalBurn, 2600 + 2550 + 2650)
    checkApprox('累计缺口', summary.totalBalance, (2600 - 2000) + (2550 - 300) + (2650 - 2100))
    checkApprox('日均缺口按完整天数算', summary.averageBalance, summary.totalBalance / 3)
    checkApprox('折算脂肪公斤', summary.fatKg, summary.totalBalance / KCAL_PER_KG_FAT)

    check('标出摄入偏低的那天（可能是漏记，但不擅自排除）', summary.lowIntakeDays, 1)
    check('这一天仍然被计入累计', days[1].complete, true)
  }

  group('区间边界')
  const oneDay = buildDailyBalances({ from: '2026-10-03', to: '2026-10-03', totalsByDate: new Map(), burnByDate: new Map() })
  check('起止同一天 → 1 天', oneDay.length, 1)
  check('起止倒置 → 空数组，而不是崩溃或负数天', buildDailyBalances({ from: '2026-10-05', to: '2026-10-01', totalsByDate: new Map(), burnByDate: new Map() }).length, 0)

  group('给人看的说法')
  check('缺口', describeBalance(600), { kind: 'deficit', label: '缺口', value: 600 })
  check('盈余', describeBalance(-600), { kind: 'surplus', label: '盈余', value: 600 })
  check('持平', describeBalance(0), { kind: 'even', label: '持平', value: 0 })
  check('四舍五入到整数', describeBalance(0.4).value, 0)
  check('数据不全', describeBalance(null).kind, 'unknown')

  group('逐日累计走势')
  {
    const { cumulativeSeries } = await import('../app/core/balance.js')
    const days = buildDailyBalances({
      from: '2026-10-01', to: '2026-10-04',
      totalsByDate: new Map([
        ['2026-10-01', { energyKcal: 2000 }],
        ['2026-10-03', { energyKcal: 2000 }],
        ['2026-10-04', { energyKcal: 2000 }],
      ]),
      burnByDate: new Map([
        ['2026-10-01', 2500], ['2026-10-02', 2500], ['2026-10-03', 2500], ['2026-10-04', 2500],
      ]),
    })
    const series = cumulativeSeries(days)
    check('第 1 天累计 500', series[0], 500)
    check('第 2 天没有数据 → null（不是沿用 500，那会画成一条平线）', series[1], null)
    check('第 3 天接着往回累计（1000）', series[2], 1000)
    check('第 4 天 1500', series[3], 1500)
    check('空输入返回空数组', cumulativeSeries([]), [])
  }
}

// ── 结果 ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(52)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
