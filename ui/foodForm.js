/**
 * 食物录入 / 编辑表单。
 *
 * 表单的设计目标：字段要能完整承载「你知道的那份量化数据」，否则你脑子里的
 * 数字无处可放，只能四舍五入成别人的近似值 —— 那样这个应用就退化成了
 * 又一个估算器。
 */

import {
  BASIS_PER_100G,
  BASIS_PER_SERVING,
  STATES,
  STATE_LABEL,
  FIELD_LABEL,
  FIELD_UNIT,
  FIELD_DECIMALS,
  PRIMARY_NUTRIENTS,
  EXTRA_NUTRIENTS,
  createFood,
  validateFood,
  nutritionForAmount,
  availableUnits,
  round,
  toNumberOrNull,
} from '../core/food.js'
import { h } from './dom.js'
import {
  field,
  textInput,
  numberInput,
  segmented,
  selectedValue,
} from './widgets.js'

export function createFoodForm({ food = null, prefill = null, onSave, onDelete, onCancel }) {
  const isEdit = Boolean(food)
  const source = food || createFood(prefill || { state: 'na', basis: { type: BASIS_PER_100G } })

  // ── 字段引用 ──────────────────────────────────────────────────────────
  const nameInput = textInput(source.name, '例如：鸡蛋（全蛋）')

  const stateRadios = segmented(
    'state',
    STATES.map((v) => ({ value: v, label: STATE_LABEL[v] })),
    source.state,
    () => refresh(),
  )

  const basisRadios = segmented(
    'basis',
    [
      { value: BASIS_PER_100G, label: '每 100 g' },
      { value: BASIS_PER_SERVING, label: '每份' },
    ],
    source.basis.type,
    () => refresh(),
  )

  const servingLabelInput = textInput(source.basis.servingLabel || '', '例如：1 个')
  const servingGramsInput = numberInput(source.basis.servingGrams, '例如：50')

  const nutrientInputs = {}
  for (const f of [...PRIMARY_NUTRIENTS, ...EXTRA_NUTRIENTS]) {
    nutrientInputs[f] = numberInput(source[f], '', FIELD_DECIMALS[f])
  }

  const sourceInput = textInput(source.source, '例如：包装标签 / 自测 / 参考值待核对')
  const noteInput = textInput(source.note, '')
  const verifiedInput = h('input', {
    type: 'checkbox',
    id: 'food-verified',
    checked: source.verified,
  })

  // ── 试算 ──────────────────────────────────────────────────────────────
  // 默认份量随基准量走：每 100 g 的条目默认 100 g，每份的条目默认 1 份。
  // 否则打开一个「每份 60 g」的条目，试算却默认按 100 g 算，首屏就是错的。
  const previewIsServing = source.basis.type === BASIS_PER_SERVING
  const previewAmount = numberInput(previewIsServing ? 1 : 100, '', 1)
  const previewUnit = h('select', { class: 'unit-select' },
    h('option', { value: 'g' }, 'g'),
    h('option', { value: 'serving' }, '份'),
  )
  previewUnit.value = previewIsServing ? 'serving' : 'g'
  const previewOut = h('div', { class: 'preview-out' })

  const messages = h('div', { class: 'messages' })

  // ── 结构 ──────────────────────────────────────────────────────────────
  const servingFields = h('div', { class: 'field-row serving-only' },
    field('每份的称呼', servingLabelInput, null, { wrapLabel: true }),
    field('每份多少 g', servingGramsInput, null, { wrapLabel: true }),
  )

  const overlay = h('div', { class: 'overlay' },
    h('div', { class: 'sheet' },
      h('header', { class: 'sheet-head' },
        h('h2', null, isEdit ? '编辑食物' : '新增食物'),
        h('button', { class: 'icon-btn', type: 'button', onClick: () => onCancel() }, '取消'),
      ),

      h('div', { class: 'sheet-body' },
        field('名称', nameInput, null, { wrapLabel: true }),

        field('状态', stateRadios,
          h('p', { class: 'hint' },
            '100 g 生米约 346 kcal，100 g 熟米饭约 130 kcal。'
            + '这一步填错会让整条数据差 2.7 倍，且数字看起来很合理。')),

        field('基准量', basisRadios,
          h('p', { class: 'hint' },
            '下面所有营养值都按这个基准填写。食品标签两种都有，照抄标签上印的那个。'),
        ),
        servingFields,

        h('div', { class: 'nutrient-grid' },
          ...PRIMARY_NUTRIENTS.map((f) =>
            field(`${FIELD_LABEL[f]}（${FIELD_UNIT[f]}）`, nutrientInputs[f], null, {
              wrapLabel: true,
            }),
          ),
        ),
        h('p', { class: 'hint' },
          '只有热量是必填。三大营养素不知道就留空 —— 编一个数字进去比留空更糟。'),

        h('details', { class: 'optional-block' },
          h('summary', null, '选填：纤维、钠'),
          h('div', { class: 'nutrient-grid' },
            ...EXTRA_NUTRIENTS.map((f) =>
              field(`${FIELD_LABEL[f]}（${FIELD_UNIT[f]}）`, nutrientInputs[f], null, {
                wrapLabel: true,
              }),
            ),
          ),
        ),

        field('数据来源', sourceInput, null, { wrapLabel: true }),
        field('备注', noteInput, null, { wrapLabel: true }),

        h('label', { class: 'check-row', for: 'food-verified' },
          verifiedInput,
          h('span', null, '我已核对过这份数据'),
        ),

        h('section', { class: 'preview' },
          h('h3', null, '试算'),
          h('div', { class: 'preview-row' },
            previewAmount,
            previewUnit,
            h('span', { class: 'preview-arrow' }, '→'),
          ),
          previewOut,
          h('p', { class: 'hint' },
            '这一行就是这个应用的全部运算：库里的值 × 份量。没有系数，没有修正。'),
        ),

        messages,
      ),

      h('footer', { class: 'sheet-foot' },
        isEdit
          ? h('button', {
              class: 'btn danger',
              type: 'button',
              onClick: () => {
                if (confirm(`删除「${source.name}」？已经记录过的日子不会受影响，`
                  + `因为每条记录都存有自己的数据快照。`)) onDelete(source.id)
              },
            }, '删除')
          : null,
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn primary', type: 'button', onClick: submit }, '保存'),
      ),
    ),
  )

  // ── 行为 ──────────────────────────────────────────────────────────────

  function readDraft() {
    const basisType = selectedValue(basisRadios)
    const basis =
      basisType === BASIS_PER_SERVING
        ? {
            type: BASIS_PER_SERVING,
            servingGrams: toNumberOrNull(servingGramsInput.value),
            servingLabel: servingLabelInput.value.trim(),
          }
        : { type: BASIS_PER_100G }

    const draft = {
      id: source.id,
      createdAt: source.createdAt,
      name: nameInput.value.trim(),
      basis,
      state: selectedValue(stateRadios),
      source: sourceInput.value.trim(),
      note: noteInput.value.trim(),
      verified: verifiedInput.checked,
    }
    for (const f of [...PRIMARY_NUTRIENTS, ...EXTRA_NUTRIENTS]) {
      draft[f] = toNumberOrNull(nutrientInputs[f].value)
    }
    return draft
  }

  function refresh() {
    const isServing = selectedValue(basisRadios) === BASIS_PER_SERVING
    servingFields.classList.toggle('hidden', !isServing)

    const draft = readDraft()
    const units = availableUnits(draft)
    const canUseG = units.includes('g')
    const canUseServing = units.includes('serving')

    previewUnit.querySelector('option[value="g"]').disabled = !canUseG
    previewUnit.querySelector('option[value="serving"]').disabled = !canUseServing
    if (previewUnit.value === 'g' && !canUseG) previewUnit.value = 'serving'
    if (previewUnit.value === 'serving' && !canUseServing) previewUnit.value = 'g'

    renderMessages(draft)
    renderPreview(draft)
  }

  function renderMessages(draft) {
    const { errors, warnings } = validateFood(draft)
    messages.replaceChildren(
      ...errors.map((e) => h('p', { class: 'msg error' }, `✕ ${e}`)),
      ...warnings.map((w) => h('p', { class: 'msg warn' }, `! ${w}`)),
    )
  }

  function renderPreview(draft) {
    const amount = toNumberOrNull(previewAmount.value)
    const unit = previewUnit.value
    const result = nutritionForAmount(draft, amount, unit)

    if (!result || amount === null) {
      previewOut.replaceChildren(h('span', { class: 'muted' }, '输入份量后显示'))
      return
    }

    const parts = [
      h('strong', null, `${round(result.energyKcal, 0) ?? '—'} ${FIELD_UNIT.energyKcal}`),
    ]
    for (const f of ['proteinG', 'fatG', 'carbG']) {
      parts.push(
        h('span', null,
          `${FIELD_LABEL[f]} ${round(result[f], FIELD_DECIMALS[f]) ?? '—'} ${FIELD_UNIT[f]}`),
      )
    }
    previewOut.replaceChildren(...parts)
  }

  function submit() {
    const draft = readDraft()
    const { errors } = validateFood(draft)
    if (errors.length > 0) {
      renderMessages(draft)
      messages.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      return
    }
    onSave(draft)
  }

  for (const node of [nameInput, servingLabelInput, servingGramsInput, sourceInput, noteInput]) {
    node.addEventListener('input', refresh)
  }
  for (const node of Object.values(nutrientInputs)) node.addEventListener('input', refresh)
  previewAmount.addEventListener('input', refresh)
  previewUnit.addEventListener('change', refresh)

  refresh()
  return overlay
}
