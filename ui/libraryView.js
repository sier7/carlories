/** 食物库页：列表、搜索、导出导入。 */

import { h } from './dom.js'
import { filterFoods } from '../storage/foodRepo.js'
import { basisLabel, STATE_LABEL, STATE_NA, FIELD_LABEL, FIELD_DECIMALS, round } from '../core/food.js'

export function libraryView(state, handlers) {
  const matched = filterFoods(state.foods, state.query)

  return h('div', { class: 'view view-library' },
    h('header', { class: 'app-head' },
      h('h1', null, '食物热量表'),
      h('p', { class: 'sub' }, summaryLine(state.foods)),
    ),

    h('div', { class: 'toolbar' },
      h('input', {
        type: 'search',
        id: 'library-search',
        class: 'search',
        placeholder: '搜索名称、备注、来源',
        value: state.query,
        onInput: (e) => handlers.setQuery(e.target.value),
      }),
      h('button', {
        class: 'btn primary', type: 'button', onClick: () => handlers.newFood(),
      }, '+ 新增'),
    ),

    listContent(state, matched, handlers),

    h('footer', { class: 'app-foot' },
      h('button', { class: 'btn', type: 'button', onClick: handlers.exportData }, '导出备份'),
      h('button', { class: 'btn', type: 'button', onClick: handlers.importData }, '导入还原'),
      h('p', { class: 'hint foot-hint' },
        '数据只存在这台设备上。导出文件请存到「文件」或 iCloud，'
        + '它是这张表唯一的保险。'),
    ),
  )
}

function summaryLine(foods) {
  if (foods.length === 0) return '还没有任何条目'
  const unverified = foods.filter((f) => !f.verified).length
  return `共 ${foods.length} 条` + (unverified > 0 ? ` · ${unverified} 条未核对` : ' · 全部已核对')
}

function listContent(state, matched, handlers) {
  if (state.foods.length === 0) {
    return h('div', { class: 'empty' },
      h('p', null, '这张表就是这个应用的核心资产。'),
      h('p', { class: 'muted' },
        '每一条都按你手上真实的数据填一次、核对一次，之后每天的记录就退化成'
        + '「份量 × 这个值」的一次乘法 —— 不再有估算。'),
      h('p', { class: 'muted' }, '建议从你最常吃的那样东西开始。'),
    )
  }

  if (matched.length === 0) {
    return h('p', { class: 'muted pad' }, `没有匹配「${state.query}」的条目`)
  }

  return h('ul', { class: 'food-list' }, ...matched.map((food) => foodRow(food, handlers)))
}

function foodRow(food, handlers) {
  const badges = []
  if (food.state !== STATE_NA) {
    badges.push(h('span', { class: `badge state-${food.state}` }, STATE_LABEL[food.state]))
  }
  if (!food.verified) badges.push(h('span', { class: 'badge unverified' }, '待核对'))

  const macros = ['proteinG', 'fatG', 'carbG']
    .map((f) => `${FIELD_LABEL[f]} ${round(food[f], FIELD_DECIMALS[f]) ?? '—'}`)
    .join(' · ')

  return h('li', {
    class: 'food-item',
    onClick: () => handlers.editFood(food),
  },
    h('div', { class: 'food-main' },
      h('div', { class: 'food-name' }, food.name),
      h('div', { class: 'food-basis' }, basisLabel(food)),
      h('div', { class: 'food-nutrients' },
        h('strong', null, `${round(food.energyKcal, 0) ?? '—'} kcal`),
        ` · ${macros}`,
      ),
    ),
    h('div', { class: 'food-badges' }, ...badges),
  )
}
