/**
 * 记录一条：历史优先，食物库其次，手动填写兜底。
 *
 * 三个来源的优先级是有讲究的：
 *   1. **历史记录** —— 记过的东西。绝大多数日常输入都在这里，通常一眼命中
 *   2. **食物库** —— 你为精确换算专门建过档的东西（称重的生米之类）
 *   3. **手动填写** —— 第一次吃、外食、菜单上印着热量的套餐
 *
 * 食物库排在第二，是因为**它不该是记录的前提**。你应该能直接记下
 * 一碗牛肉面，而不必先为它建一条永远只用一次的档案。
 */

import { h, mount } from './dom.js'
import { sheet, openOverlay, numberInput, timeInput } from './widgets.js'
import {
  availableUnits,
  basisLabel,
  nutritionForAmount,
  round,
  toNumberOrNull,
  STATE_LABEL,
  STATE_NA,
} from '../core/food.js'
import { historyRefIds, filterHistory } from '../core/history.js'
import { fmtGram, fmtKcal } from './format.js'
import { dateLabel } from '../core/date.js'

export function openFoodPicker({
  historyItems = [],
  foods = [],
  defaultTime,
  today,
  onRepeat,
  onFreeEntry,
}) {
  let query = ''
  let selected = null

  const body = h('div', { class: 'picker-body' })
  const overlay = sheet({ title: '记录一条', body })

  // ── 第一步：选东西 ────────────────────────────────────────────────────

  function renderList() {
    const search = h('input', {
      type: 'search',
      class: 'search',
      placeholder: '搜索历史记录与食物库',
      value: query,
      onInput: (e) => {
        query = e.target.value
        mount(body, ...listContent(e.target.value))
      },
    })

    mount(body,
      search,
      ...listContent(query),
      h('div', { class: 'picker-actions' },
        h('button', {
          class: 'btn wide',
          type: 'button',
          onClick: () => {
            overlay.remove()
            onFreeEntry(null)
          },
        }, '手动填写一条（外食、临时吃的）'),
      ),
    )
    search.focus({ preventScroll: true })
  }

  function listContent(q) {
    const q2 = String(q || '').trim()
    const history = filterHistory(historyItems, q2)
    const usedIds = historyRefIds(historyItems)
    const libraryFoods = foods.filter((f) => {
      if (usedIds.has(f.id)) return false
      if (!q2) return true
      return [f.name, f.note, f.source].filter(Boolean).join(' ').toLowerCase().includes(q2.toLowerCase())
    })

    if (history.length === 0 && libraryFoods.length === 0) {
      return [
        h('p', { class: 'muted pad' },
          q2 ? `没有匹配「${q2}」的东西` : '还没有任何可调取的东西'),
        h('p', { class: 'hint pad' },
          '点下面的「手动填写一条」记第一次，之后它就会出现在这里。'),
      ]
    }

    const nodes = []

    if (history.length > 0) {
      nodes.push(h('h3', { class: 'picker-section' }, '历史记录'))
      nodes.push(h('ul', { class: 'pick-list' }, ...history.map(historyRow)))
    }

    if (libraryFoods.length > 0) {
      nodes.push(h('h3', { class: 'picker-section' }, '食物库'))
      nodes.push(h('ul', { class: 'pick-list' }, ...libraryFoods.map(libraryRow)))
    }

    return nodes
  }

  function historyRow(item) {
    const badges = []
    if (item.free) badges.push(h('span', { class: 'badge' }, '手动'))
    if (item.missingFromLibrary) {
      badges.push(h('span', { class: 'badge unverified' }, '食物已删'))
    }
    if (item.times > 1) badges.push(h('span', { class: 'badge count' }, `×${item.times}`))

    const sub = item.free
      ? `上次 ${dateLabel(item.lastDate, today)}`
      : `${basisLabel(item.source)} · 上次 ${fmtAmountText(item.lastAmount, item.lastUnit)}`

    return h('li', {
      class: 'pick-item',
      onClick: () => {
        if (item.free) {
          overlay.remove()
          onFreeEntry(item.snapshot)
        } else {
          select({ source: item.source, refId: item.repeatRefId, preset: item })
        }
      },
    },
      h('div', { class: 'pick-main' },
        h('div', { class: 'pick-name' }, item.snapshot.name),
        h('div', { class: 'pick-sub' }, sub),
      ),
      h('div', { class: 'pick-right' },
        h('div', { class: 'pick-kcal' }, fmtKcal(item.repeatKcal)),
        h('div', { class: 'pick-unit' }, 'kcal'),
        h('div', { class: 'food-badges' }, ...badges),
      ),
    )
  }

  function libraryRow(food) {
    const badges = []
    if (food.state !== STATE_NA) {
      badges.push(h('span', { class: `badge state-${food.state}` }, STATE_LABEL[food.state]))
    }
    if (!food.verified) badges.push(h('span', { class: 'badge unverified' }, '待核对'))

    return h('li', { class: 'pick-item', onClick: () => select({ source: food, refId: food.id, preset: null }) },
      h('div', { class: 'pick-main' },
        h('div', { class: 'pick-name' }, food.name),
        h('div', { class: 'pick-sub' }, basisLabel(food)),
      ),
      h('div', { class: 'pick-right' },
        h('div', { class: 'pick-kcal' }, fmtKcal(round(food.energyKcal, 0))),
        h('div', { class: 'pick-unit' }, `kcal / ${food.basis.type === 'per100g' ? '100 g' : '份'}`),
        h('div', { class: 'food-badges' }, ...badges),
      ),
    )
  }

  // ── 第二步：输份量 ────────────────────────────────────────────────────

  function select({ source, refId, preset }) {
    selected = { source, refId, preset }
    renderAmount()
  }

  function renderAmount() {
    const { source, refId, preset } = selected
    const units = availableUnits(source)
    const canUseServing = units.includes('serving')

    // 历史条目默认沿用上次的份量，这样「再记一次」几乎不用改任何东西
    const presetUnit = preset && units.includes(preset.lastUnit) ? preset.lastUnit : null
    const presetAmount = presetUnit ? preset.lastAmount : null

    const defaultUnit = presetUnit || (source.basis.type === 'perServing' && canUseServing ? 'serving' : 'g')
    const defaultAmount =
      presetAmount !== null && presetAmount !== undefined
        ? presetAmount
        : source.basis.type === 'perServing' && canUseServing
          ? 1
          : 100

    const amountInput = numberInput(defaultAmount, '', 1)
    const unitSelect = h('select', { class: 'unit-select' },
      h('option', { value: 'g' }, 'g'),
      ...(canUseServing ? [h('option', { value: 'serving' }, '份')] : []),
    )
    unitSelect.value = defaultUnit

    const timeField = timeInput(defaultTime)
    const previewOut = h('div', { class: 'preview-out' })
    const messages = h('div', { class: 'messages' })

    function renderPreview() {
      const amount = toNumberOrNull(amountInput.value)
      const unit = unitSelect.value
      const result = nutritionForAmount(source, amount, unit)
      if (!result || amount === null) {
        previewOut.replaceChildren(h('span', { class: 'muted' }, '输入份量后显示'))
        return
      }
      const parts = [h('strong', null, `${round(result.energyKcal, 0) ?? '—'} kcal`)]
      if (result.proteinG !== null) {
        parts.push(h('span', null, `蛋白 ${fmtGram(result.proteinG)}`))
        parts.push(h('span', null, `脂肪 ${fmtGram(result.fatG)}`))
        parts.push(h('span', null, `碳水 ${fmtGram(result.carbG)}`))
      }
      previewOut.replaceChildren(...parts)
    }

    async function commit() {
      const amount = toNumberOrNull(amountInput.value)
      const unit = unitSelect.value
      if (amount === null || amount <= 0) {
        messages.replaceChildren(h('p', { class: 'msg error' }, '✕ 份量必须大于 0'))
        return
      }
      try {
        await onRepeat({ source, refId, amount, unit, time: timeField.value })
        overlay.remove()
      } catch (error) {
        messages.replaceChildren(h('p', { class: 'msg error' }, `✕ ${error.message}`))
      }
    }

    amountInput.addEventListener('input', renderPreview)
    unitSelect.addEventListener('change', renderPreview)
    unitSelect.addEventListener('input', renderPreview)
    amountInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit()
    })
    renderPreview()

    mount(body,
      h('button', { class: 'link-back', type: 'button', onClick: renderList }, '‹ 重新选择'),
      h('div', { class: 'readout' },
        h('div', { class: 'readout-name' }, source.name),
        h('div', { class: 'readout-sub' }, basisLabel(source)),
      ),
      h('div', { class: 'field-row' },
        h('label', { class: 'field' },
          h('span', { class: 'field-label' }, '份量'), amountInput),
        h('div', { class: 'field' },
          h('span', { class: 'field-label' }, '单位'), unitSelect),
      ),
      h('label', { class: 'field' },
        h('span', { class: 'field-label' }, '时间'), timeField),
      h('section', { class: 'preview' },
        h('h3', null, '这条会贡献'),
        previewOut,
      ),
      messages,
      h('div', { class: 'picker-actions' },
        h('button', { class: 'btn primary wide', type: 'button', onClick: commit }, '记录'),
      ),
    )
    amountInput.focus({ preventScroll: true })
  }

  renderList()
  openOverlay(overlay)
  return overlay
}

function fmtAmountText(amount, unit) {
  const n = round(amount, 2)
  if (n === null) return '—'
  return `${n} ${unit === 'serving' ? '份' : 'g'}`
}
