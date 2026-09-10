/**
 * 图表几何：纯计算，不碰 DOM。
 *
 * 抽出来单独放，是因为坐标算错是最难肉眼发现的一类 bug —— 图还在，
 * 只是某个柱子高度不对、某段线连错了地方。纯函数可以直接测。
 */

/** 把数值映射到像素坐标。domain 相同时返回区间中点，避免除零 */
export function scaleLinear(value, domainMin, domainMax, rangeMin, rangeMax) {
  if (domainMax === domainMin) return (rangeMin + rangeMax) / 2
  const t = (value - domainMin) / (domainMax - domainMin)
  return rangeMin + t * (rangeMax - rangeMin)
}

/**
 * 根据一组值算出纵轴范围与 y 映射。
 * includeZero 让 0 一定落在轴内 —— 缺口图必须有零线，否则看不出正负。
 */
export function computeYScale(values, { height, padding = 6, includeZero = true, minSpan = 1 }) {
  const numbers = (values || []).filter((v) => typeof v === 'number' && isFinite(v))
  let min = numbers.length > 0 ? Math.min(...numbers) : 0
  let max = numbers.length > 0 ? Math.max(...numbers) : 0

  if (includeZero) {
    min = Math.min(min, 0)
    max = Math.max(max, 0)
  }
  if (max - min < minSpan) {
    const mid = (max + min) / 2
    min = mid - minSpan / 2
    max = mid + minSpan / 2
  }

  const inner = Math.max(1, height - padding * 2)
  return {
    min,
    max,
    y: (value) => padding + (1 - (value - min) / (max - min)) * inner,
  }
}

/** 把宽度平均分成 count 个槽位，并给出每个槽位里柱子的左右边界 */
export function slotLayout(count, width, { gapRatio = 0.34 } = {}) {
  const safeCount = Math.max(1, count)
  const slotWidth = width / safeCount
  const barWidth = Math.max(1, slotWidth * (1 - gapRatio))
  return {
    count: safeCount,
    slotWidth,
    barWidth,
    center: (index) => slotWidth * (index + 0.5),
    left: (index) => slotWidth * index + (slotWidth - barWidth) / 2,
  }
}

/**
 * 折线路径，遇到缺失值（null）就断开。
 *
 * 返回若干段而不是一条路径 —— 缺口图上「那天没有数据」和「那天刚好持平」
 * 必须长得不一样，否则会读出一个完全错误的结论。
 */
export function buildSegments(values, { x, y }) {
  const segments = []
  let current = []

  ;(values || []).forEach((value, index) => {
    if (typeof value === 'number' && isFinite(value)) {
      current.push({ x: x(index), y: y(value), index, value })
    } else if (current.length > 0) {
      segments.push(current)
      current = []
    }
  })
  if (current.length > 0) segments.push(current)

  return segments
}

/** 把点串成 SVG 的 path d 属性 */
export function toPathData(points) {
  if (!points || points.length === 0) return ''
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${round(p.x)},${round(p.y)}`)
    .join(' ')
}

/** 折线下方的填充区域：从折线两端垂到基线再闭合 */
export function toAreaData(points, baselineY) {
  if (!points || points.length === 0) return ''
  const line = toPathData(points)
  const first = points[0]
  const last = points[points.length - 1]
  return `${line} L${round(last.x)},${round(baselineY)} L${round(first.x)},${round(baselineY)} Z`
}

/**
 * 选择要显示日期标签的下标。
 * 30 天全标会糊成一团，90 天更是；但只标首尾又难以定位中间。
 */
export function labelIndices(count, maxLabels = 7) {
  if (count <= 0) return []
  if (count <= maxLabels) return [...Array(count).keys()]

  const step = Math.ceil(count / maxLabels)
  const out = []
  for (let i = 0; i < count; i += step) out.push(i)
  // 保证最后一个点一定带标签，否则看不出区间到哪天为止
  if (out[out.length - 1] !== count - 1) out.push(count - 1)
  return out
}

/** 缺口的正负决定颜色：缺口向上、盈余向下 */
export function balanceClass(value) {
  if (typeof value !== 'number' || !isFinite(value)) return 'missing'
  const rounded = Math.round(value)
  if (rounded > 0) return 'deficit'
  if (rounded < 0) return 'surplus'
  return 'even'
}

function round(n) {
  return Math.round(n * 100) / 100
}
