/** 今日页：自动汇总当日摄入、与消耗对比、列出每一条记录。 */

import { h } from './dom.js'
import { dateLabel, relativeLabel } from '../core/date.js'
import { summarizeEntries, isEntryStale, isFreeEntry, entryHasMacros } from '../core/log.js'
import { totalBurn, describeBalance } from '../core/balance.js'
import { round } from '../core/food.js'
import { freshness, SOURCE_SHORTCUT } from '../storage/dayRepo.js'
import { fmtKcal, fmtGram, fmtAmount, percent } from './format.js'

export function dayView(state, handlers) {
  const { date, today, entries, health, targets, foods } = state
  const { items, totals } = summarizeEntries(entries)
  const burn = totalBurn(health)
  // 缺口 = 消耗 − 摄入，正数是缺口。与多日视图用同一个函数，
  // 避免两处各写一套符号约定然后对不上。
  const dayBalance = burn === null ? null : burn - totals.energyKcal
  const foodsById = new Map(foods.map((f) => [f.id, f]))
  const staleCount = items.filter((i) => isEntryStale(i.entry, foodsById.get(i.entry.refId))).length
  const missingMacros = items.filter((i) => !entryHasMacros(i.entry)).length

  return h('div', { class: 'view view-day' },
    dateNav(date, today, handlers),
    hero(date, today, totals, entries.length, targets),
    macros(totals, targets, handlers, missingMacros),
    balance(health, burn, dayBalance, handlers),
    h('button', {
      class: 'btn primary wide record-btn',
      type: 'button',
      onClick: handlers.openPicker,
    }, '+ 记录一条'),

    staleCount > 0
      ? h('p', { class: 'msg warn' },
          `今天有 ${staleCount} 条记录依据的是旧版食物数据。点开那条记录可以按当前值更新。`)
      : null,

    entryList(items, foodsById, handlers),
  )
}

// ── 日期导航 ────────────────────────────────────────────────────────────

function dateNav(date, today, handlers) {
  const isToday = date === today
  return h('header', { class: 'day-head' },
    h('button', {
      class: 'nav-btn', type: 'button', onClick: () => handlers.goDay(-1),
    }, '‹'),
    h('button', {
      class: 'day-title', type: 'button', onClick: handlers.goToday,
      title: isToday ? '已经是今天' : '回到今天',
    },
      h('div', { class: 'day-label' }, dateLabel(date, today)),
      h('div', { class: 'day-sub' }, isToday ? date : relativeLabel(date, today)),
    ),
    h('button', {
      class: 'nav-btn', type: 'button', onClick: () => handlers.goDay(1),
    }, '›'),
  )
}

// ── 主角数字 ────────────────────────────────────────────────────────────

function hero(date, today, totals, count, targets) {
  const target =
    targets && typeof targets.energyKcal === 'number' && targets.energyKcal > 0
      ? targets.energyKcal
      : null
  const remaining = target === null ? null : target - totals.energyKcal

  return h('section', { class: 'hero' },
    h('div', { class: 'hero-label' }, date === today ? '今日摄入' : '当日摄入'),
    h('div', { class: 'hero-value' },
      fmtKcal(totals.energyKcal),
      h('span', { class: 'hero-unit' }, 'kcal'),
    ),
    target === null
      ? null
      : h('div', { class: 'hero-target' },
          `目标 ${fmtKcal(target)} kcal · `,
          h('span', { class: remaining < 0 ? 'over' : 'under' },
            remaining < 0
              ? `超出 ${fmtKcal(-remaining)}`
              : `还剩 ${fmtKcal(remaining)}`),
        ),
    h('div', { class: 'hero-sub' },
      count === 0 ? '还没有任何记录' : `共 ${count} 条记录`),
  )
}

// ── 三大营养素 ──────────────────────────────────────────────────────────

function macros(totals, targets, handlers, missingMacros = 0) {
  const hasTargets = Boolean(
    targets &&
      (targets.proteinG !== null ||
        targets.fatG !== null ||
        targets.carbG !== null),
  )

  return h('section', { class: 'macros' },
    h('div', { class: 'section-head' },
      h('h3', null, '三大营养素'),
      h('button', {
        class: 'icon-btn', type: 'button', onClick: handlers.openTargets,
      }, hasTargets ? '目标' : '设定目标'),
    ),
    macroRow('蛋白质', totals.proteinG, targets && targets.proteinG),
    macroRow('脂肪', totals.fatG, targets && targets.fatG),
    macroRow('碳水', totals.carbG, targets && targets.carbG),

    // 诚实：外食时你常常只填了热量没填营养素，那这三项的合计就是偏低的。
    // 与其让数字看起来完整，不如直说它缺了什么。
    missingMacros > 0
      ? h('p', { class: 'hint' },
          `有 ${missingMacros} 条记录没填营养素（外食很常见），`
          + '所以这三项的合计偏低，只有热量是完整的。')
      : null,
  )
}

function macroRow(label, value, target) {
  const hasTarget = typeof target === 'number' && target > 0
  const ratio = hasTarget ? percent(value, target) : null
  const over = hasTarget && value > target

  return h('div', { class: 'macro-row' },
    h('div', { class: 'macro-head' },
      h('span', { class: 'macro-name' }, label),
      h('span', { class: 'macro-value' },
        `${fmtGram(value)} g`,
        hasTarget ? h('span', { class: 'macro-target' }, ` / ${fmtGram(target)} g`) : null,
      ),
    ),
    hasTarget
      ? h('div', { class: `macro-bar${over ? ' over' : ''}` },
          h('div', { class: 'macro-fill', style: { width: `${(ratio || 0) * 100}%` } }),
        )
      : null,
  )
}

// ── 消耗与净差 ──────────────────────────────────────────────────────────

function balance(health, burn, dayBalance, handlers) {
  const sourceNote = health
    ? health.source === SOURCE_SHORTCUT
      ? `来自快捷指令 · ${freshness(health)}`
      : `手动填写 · ${freshness(health)}`
    : null

  const desc = describeBalance(dayBalance)

  return h('section', { class: 'balance' },
    h('div', { class: 'section-head' },
      h('h3', null, '消耗与缺口'),
      h('button', {
        class: 'icon-btn', type: 'button', onClick: handlers.syncHealth,
      }, '同步健康数据'),
    ),

    h('button', {
      class: 'balance-row', type: 'button', onClick: handlers.openBurn,
    },
      h('span', { class: 'balance-name' }, '消耗'),
      h('span', { class: 'balance-value' },
        burn === null ? '未填写' : `${fmtKcal(burn)} kcal`),
      h('span', { class: 'chevron' }, '›'),
    ),
    sourceNote ? h('div', { class: 'balance-note' }, sourceNote) : null,

    burn === null
      ? h('button', {
          class: 'sync-cta',
          type: 'button',
          onClick: handlers.syncHealth,
        },
          h('span', { class: 'sync-cta-title' }, '同步今天的消耗'),
          h('span', { class: 'sync-cta-sub' },
            '从剪贴板读入快捷指令取好的数据。也可以点上面那一行手动填。'),
        )
      : h('div', { class: 'balance-row net' },
          h('span', { class: 'balance-name' }, desc.label),
          h('span', { class: `balance-value ${desc.kind}` },
            desc.value === null ? '—' : `${fmtKcal(desc.value)} kcal`),
        ),
  )
}

// ── 记录列表 ────────────────────────────────────────────────────────────

function entryList(items, foodsById, handlers) {
  if (items.length === 0) {
    return h('div', { class: 'empty' },
      h('p', null, '这一天还没有记录'),
      h('p', { class: 'muted' },
        '点上面的「记录一条」，从食物库里选东西、输份量。'
        + '总量会自动累加，你不需要做任何计算。'),
    )
  }

  return h('ul', { class: 'entry-list' },
    ...items.map(({ entry, nutrients }) => {
      const stale = isEntryStale(entry, foodsById.get(entry.refId))
      return h('li', {
        class: 'entry-item',
        onClick: () => handlers.openEntry(entry),
      },
        h('div', { class: 'entry-time' }, entry.time),
        h('div', { class: 'entry-main' },
          h('div', { class: 'entry-name' },
            entry.snapshot.name,
            stale ? h('span', { class: 'badge stale' }, '旧数据') : null,
          ),
          h('div', { class: 'entry-sub' },
            isFreeEntry(entry) ? '手动填写' : fmtAmount(entry.amount, entry.unit)),
        ),
        h('div', { class: 'entry-right' },
          h('div', { class: 'entry-kcal' },
            round(nutrients ? nutrients.energyKcal : null, 0) ?? '—'),
          h('div', { class: 'entry-unit' }, 'kcal'),
        ),
      )
    }),
  )
}
