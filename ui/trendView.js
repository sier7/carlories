/**
 * 多日视图：一段日期的摄入、消耗、缺口走势。
 *
 * 设计取向：**只呈现数据，不做判断。**
 *
 * 这里刻意没有「健康分」「日均缺口偏大」「蛋白质未达标」这类东西。
 * 使用者和自己的目标之间的关系，比任何规则都清楚 —— 应用的工作是把数字
 * 摆清楚、把走势画出来，而不是替他下结论。
 *
 * 唯一保留的提示是**数据完整度**，但那不是建议：不完整的日子不能计入累计
 * （否则「忘了记晚饭」那天会凭空贡献两千多 kcal 的假缺口），
 * 所以必须告诉你累计到底由哪几天构成。
 */

import { h, s } from './dom.js'
import { shortDateLabel } from '../core/date.js'
import { cumulativeSeries } from '../core/balance.js'
import {
  computeYScale,
  buildSegments,
  toPathData,
  toAreaData,
  labelIndices,
  balanceClass,
} from './chart.js'
import { fmtKcal, fmtGram, fmtBalance } from './format.js'

const W = 340
const DAILY_H = 128
const CUM_H = 116
const PAD = 8

export const RANGE_OPTIONS = [7, 14, 30, 90]

export function trendView(state, handlers) {
  const { rangeDays, summary, targets } = state

  if (!summary) {
    return h('div', { class: 'view view-trend' },
      rangeTabs(rangeDays, handlers),
      h('p', { class: 'muted pad' }, '载入中…'),
    )
  }

  const days = summary.days

  return h('div', { class: 'view view-trend' },
    h('header', { class: 'app-head' },
      h('h1', null, '多日数据'),
      h('p', { class: 'sub' },
        `${shortDateLabel(days[0].date)} – ${shortDateLabel(days[days.length - 1].date)}`
        + ` · ${summary.totalDays} 天`),
    ),

    rangeTabs(rangeDays, handlers),
    summaryCard(summary),
    completenessNote(summary),

    days.length > 0
      ? h('section', { class: 'chart-card' },
          h('div', { class: 'chart-head' },
            h('h3', null, '每日摄入与消耗'),
            h('div', { class: 'legend' },
              h('span', { class: 'legend-item' }, h('i', { class: 'swatch intake' }), '摄入'),
              h('span', { class: 'legend-item' }, h('i', { class: 'swatch burn' }), '消耗'),
            ),
          ),
          dailyChart(days),
          axisLabels(days),
        )
      : null,

    days.length > 0
      ? h('section', { class: 'chart-card' },
          h('div', { class: 'chart-head' },
            h('h3', null, '累计缺口走势'),
            h('span', { class: 'chart-hint' }, summary.totalBalance >= 0 ? '向下 = 持续缺口' : '向上 = 持续盈余'),
          ),
          cumulativeChart(days),
          axisLabels(days),
        )
      : null,

    dayList(days),
  )
}

// ── 区间选择 ────────────────────────────────────────────────────────────

function rangeTabs(rangeDays, handlers) {
  return h('div', { class: 'range-tabs' },
    ...RANGE_OPTIONS.map((days) =>
      h('button', {
        class: `range-tab${days === rangeDays ? ' active' : ''}`,
        type: 'button',
        onClick: () => handlers.setRange(days),
      }, `${days} 天`),
    ),
  )
}

// ── 概要 ────────────────────────────────────────────────────────────────

function summaryCard(summary) {
  const balance = summary.totalBalance
  const kind = balanceClass(balance)
  const label = kind === 'deficit' ? '累计缺口' : kind === 'surplus' ? '累计盈余' : '累计持平'
  const avg = summary.averageBalance

  return h('section', { class: 'summary-card' },
    h('div', { class: 'summary-label' }, label),
    h('div', { class: `summary-value ${kind}` },
      fmtKcal(Math.abs(balance)),
      h('span', { class: 'summary-unit' }, 'kcal'),
    ),
    kind !== 'even'
      ? h('div', { class: 'summary-equivalent' },
          `≈ ${Math.abs(summary.fatKg).toFixed(2)} kg 脂肪`)
      : null,

    h('div', { class: 'summary-grid' },
      statCell(
        avg !== null && avg < 0 ? '日均盈余' : '日均缺口',
        avg === null ? '—' : fmtKcal(Math.abs(avg)),
      ),
      statCell('日均摄入', summary.averageIntake === null ? '—' : fmtKcal(summary.averageIntake)),
      statCell('日均消耗', summary.averageBurn === null ? '—' : fmtKcal(summary.averageBurn)),
      statCell('日均蛋白', summary.averageProtein === null ? '—' : `${fmtGram(summary.averageProtein)} g`),
    ),
  )
}

function statCell(label, value) {
  return h('div', { class: 'stat-cell' },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'stat-value' }, value),
  )
}

/**
 * 数据完整度。
 * 这不是建议，是读图的前提 —— 累计缺口由哪几天构成，必须说清楚。
 */
function completenessNote(summary) {
  if (summary.completeDays === summary.totalDays) {
    return h('p', { class: 'data-note ok' }, `${summary.totalDays} 天数据全部完整。`)
  }

  const missing = []
  if (summary.missingBurnDays > 0) missing.push(`${summary.missingBurnDays} 天缺消耗`)
  if (summary.missingIntakeDays > 0) missing.push(`${summary.missingIntakeDays} 天缺饮食`)
  if (summary.emptyDays > 0) missing.push(`${summary.emptyDays} 天两者都缺`)

  return h('p', { class: 'data-note' },
    `完整 ${summary.completeDays} / ${summary.totalDays} 天 —— 累计缺口只统计完整的天。`,
    h('span', { class: 'data-note-detail' }, `未计入：${missing.join('、')}`),
  )
}

// ── 每日摄入与消耗 ──────────────────────────────────────────────────────

function dailyChart(days) {
  const values = []
  for (const day of days) {
    if (day.intake > 0) values.push(day.intake)
    if (day.burn > 0) values.push(day.burn)
  }
  const scale = computeYScale(values, { height: DAILY_H, padding: PAD, minSpan: 100 })
  const slot = W / Math.max(1, days.length)
  const inner = slot * 0.74
  const barW = Math.max(1.2, (inner - 1.5) / 2)
  const baseY = scale.y(0)
  const slots = []

  days.forEach((day, index) => {
    const left = index * slot + (slot - inner) / 2
    if (day.intake > 0) {
      slots.push(s('rect', {
        class: 'bar intake',
        x: round(left), y: round(scale.y(day.intake)),
        width: round(barW), height: round(Math.max(0.5, baseY - scale.y(day.intake))),
        rx: 1,
      }))
    }
    if (day.burn > 0) {
      slots.push(s('rect', {
        class: 'bar burn',
        x: round(left + barW + 1.5), y: round(scale.y(day.burn)),
        width: round(barW), height: round(Math.max(0.5, baseY - scale.y(day.burn))),
        rx: 1,
      }))
    }
    // 完全没数据的那天画一条极淡的底座，让「这里有天但没数据」可见
    if (day.intake <= 0 && day.burn <= 0) {
      slots.push(s('rect', {
        class: 'bar empty',
        x: round(left), y: round(baseY - 1),
        width: round(inner), height: 1, rx: 0.5,
      }))
    }
  })

  return s('svg', {
    class: 'chart',
    viewBox: `0 0 ${W} ${DAILY_H}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': '每日摄入与消耗柱状图',
  },
    s('line', { class: 'axis-line', x1: 0, y1: round(baseY), x2: W, y2: round(baseY) }),
    ...slots,
  )
}

// ── 累计缺口 ────────────────────────────────────────────────────────────

function cumulativeChart(days) {
  const series = cumulativeSeries(days)
  const scale = computeYScale(series, { height: CUM_H, padding: PAD, minSpan: 200 })
  const slot = W / Math.max(1, days.length)
  const x = (index) => slot * (index + 0.5)
  const zeroY = scale.y(0)

  const segments = buildSegments(series, { x, y: scale.y })
  const paths = []

  for (const segment of segments) {
    if (segment.length > 1) {
      paths.push(s('path', {
        class: 'area',
        d: toAreaData(segment, zeroY),
      }))
    }
    paths.push(s('path', {
      class: 'line',
      d: toPathData(segment),
    }))
    // 孤立的点（前后都是缺口）用圆点标出来，否则它完全不可见
    if (segment.length === 1) {
      paths.push(s('circle', {
        class: 'dot', cx: round(segment[0].x), cy: round(segment[0].y), r: 2,
      }))
    }
  }

  return s('svg', {
    class: 'chart',
    viewBox: `0 0 ${W} ${CUM_H}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': '累计缺口走势图',
  },
    s('line', { class: 'axis-line', x1: 0, y1: round(zeroY), x2: W, y2: round(zeroY) }),
    ...paths,
  )
}

// ── 横轴日期 ────────────────────────────────────────────────────────────

function axisLabels(days) {
  const indices = labelIndices(days.length, 6)
  return h('div', { class: 'axis-labels' },
    ...indices.map((index) =>
      h('span', {
        class: 'axis-label',
        style: { left: `${((index + 0.5) / days.length) * 100}%` },
      }, shortDateLabel(days[index].date)),
    ),
  )
}

// ── 逐日明细 ────────────────────────────────────────────────────────────

function dayList(days) {
  const rows = [...days].reverse()

  return h('section', { class: 'day-table' },
    h('div', { class: 'day-row head' },
      h('span', null, '日期'),
      h('span', { class: 'num' }, '摄入'),
      h('span', { class: 'num' }, '消耗'),
      h('span', { class: 'num' }, '蛋白'),
      h('span', { class: 'num' }, '缺口'),
    ),
    ...rows.map((day) => {
      const kind = balanceClass(day.complete ? day.balance : null)
      return h('div', {
        class: `day-row${day.complete ? '' : ' incomplete'}`,
      },
        h('span', { class: 'day-date' }, shortDateLabel(day.date)),
        h('span', { class: 'num' }, day.intake > 0 ? fmtKcal(day.intake) : '—'),
        h('span', { class: 'num' }, day.burn > 0 ? fmtKcal(day.burn) : '—'),
        h('span', { class: 'num' }, day.proteinG > 0 ? fmtGram(day.proteinG) : '—'),
        h('span', { class: `num balance ${kind}` },
          day.complete ? fmtBalance(day.balance) : '数据不全'),
      )
    }),
  )
}

function round(n) {
  return Math.round(n * 100) / 100
}
