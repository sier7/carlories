/**
 * 自由填写表单：外食、临时吃的东西、菜单上印着热量的套餐。
 *
 * 这是本应用对「不要强行把热量表绑定到热量记录」的实现。
 * 你不需要先建档案，敲一个名称和一个热量就能记下来。
 *
 * 三大营养素全部选填。外食时你常常只知道热量，逼你编一个蛋白值
 * 比留空更糟 —— 编出来的数字看起来和真的一样，但它会污染当天的合计。
 */

import { EXTRA_NUTRIENTS, FIELD_LABEL, FIELD_UNIT, toNumberOrNull } from '../core/food.js'
import { buildFreeEntry, withFreeValues } from '../core/log.js'
import { h } from './dom.js'
import { sheet, sheetButton, field, textInput, numberInput, timeInput, openOverlay } from './widgets.js'
import { round } from '../core/food.js'

export function openFreeEntryForm({
  entry = null,
  prefill = null,
  defaultDate,
  defaultTime,
  onSave,
  onDelete = null,
  onSaveToLibrary = null,
}) {
  const isEdit = Boolean(entry)
  const source = entry ? entry.snapshot : prefill || null

  const nameInput = textInput(source ? source.name : '', '例如：楼下牛肉面')
  const kcalInput = numberInput(source ? source.energyKcal : null, '例如：800', 0)
  const macroInputs = {
    proteinG: numberInput(source ? source.proteinG : null, '', 1),
    fatG: numberInput(source ? source.fatG : null, '', 1),
    carbG: numberInput(source ? source.carbG : null, '', 1),
  }
  const extraInputs = {}
  for (const f of EXTRA_NUTRIENTS) {
    extraInputs[f] = numberInput(source ? source[f] : null, '', 0)
  }
  // 注意这里判断的是 isEdit 而不是 source：用 prefill 新建时 entry 是 null，
  // 读 entry.time 会直接抛错。这条路径就是「从历史里再记一次牛肉面」。
  const timeField = timeInput(isEdit ? entry.time : defaultTime)

  const messages = h('div', { class: 'messages' })

  function readDraft() {
    const values = { name: nameInput.value.trim(), energyKcal: toNumberOrNull(kcalInput.value) }
    for (const [key, input] of Object.entries(macroInputs)) {
      values[key] = toNumberOrNull(input.value)
    }
    for (const [key, input] of Object.entries(extraInputs)) {
      values[key] = toNumberOrNull(input.value)
    }
    return values
  }

  function showMessages() {
    const errors = []
    const warnings = []
    const draft = readDraft()

    if (!draft.name) errors.push('名称为必填')
    if (draft.energyKcal === null) errors.push('热量为必填')
    else if (draft.energyKcal < 0) errors.push('热量不能为负数')

    if (draft.energyKcal !== null && draft.energyKcal > 5000) {
      warnings.push(`${round(draft.energyKcal, 0)} kcal 相当大，确认一下是不是多打了一位。`)
    }

    const macrosKnown = ['proteinG', 'fatG', 'carbG'].every(
      (f) => draft[f] !== null,
    )
    if (!macrosKnown && draft.energyKcal !== null) {
      warnings.push('没填营养素。可以留空 —— 当天的营养素合计会标明缺了几条。')
    }

    messages.replaceChildren(
      ...errors.map((e) => h('p', { class: 'msg error' }, `✕ ${e}`)),
      ...warnings.map((w) => h('p', { class: 'msg warn' }, `! ${w}`)),
    )
    return errors
  }

  async function save() {
    const errors = showMessages()
    if (errors.length > 0) {
      messages.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      return
    }
    const draft = readDraft()
    try {
      if (isEdit) {
        const updated = withFreeValues(entry, draft)
        updated.time = timeField.value || entry.time
        await onSave(updated)
      } else {
        await onSave(buildFreeEntry({
          ...draft,
          date: defaultDate,
          time: timeField.value || defaultTime,
        }))
      }
      overlay.remove()
    } catch (error) {
      messages.replaceChildren(h('p', { class: 'msg error' }, `✕ ${error.message}`))
    }
  }

  const footer = [
    isEdit && onDelete
      ? sheetButton('删除', async () => {
          if (!confirm('删除这条记录？')) return
          await onDelete(entry.id)
          overlay.remove()
        }, { danger: true })
      : null,
    h('div', { class: 'spacer' }),
    isEdit && onSaveToLibrary
      ? sheetButton('存进食物库', async () => {
          const errors = showMessages()
          if (errors.length > 0) return
          onSaveToLibrary(readDraft())
          overlay.remove()
        })
      : null,
    sheetButton('保存', save, { primary: true }),
  ]

  const overlay = sheet({
    title: isEdit ? '编辑这一条' : '手动填写',
    body: [
      h('p', { class: 'hint' },
        '不需要先在食物库里建档案。记过之后它会自己出现在历史里，'
        + '以后一次点击就能再记一次。'),

      field('名称', nameInput, null, { wrapLabel: true }),

      h('div', { class: 'nutrient-grid' },
        field(`热量（${FIELD_UNIT.energyKcal}）`, kcalInput, null, { wrapLabel: true }),
        field('时间', timeField, null, { wrapLabel: true }),
      ),

      h('details', { class: 'optional-block' },
        h('summary', null, '选填：蛋白质、脂肪、碳水'),
        h('p', { class: 'hint' },
          '不知道就留空。留空的话当天的营养素合计会明确标出缺了几条、'
          + '所以偏低 —— 这比编一个数字进去诚实。'),
        h('div', { class: 'nutrient-grid' },
          ...['proteinG', 'fatG', 'carbG'].map((f) =>
            field(`${FIELD_LABEL[f]}（${FIELD_UNIT[f]}）`, macroInputs[f], null, { wrapLabel: true }),
          ),
        ),
        h('div', { class: 'nutrient-grid' },
          ...EXTRA_NUTRIENTS.map((f) =>
            field(`${FIELD_LABEL[f]}（${FIELD_UNIT[f]}）`, extraInputs[f], null, { wrapLabel: true }),
          ),
        ),
      ),

      messages,
    ],
    footer,
  })

  for (const input of [nameInput, kcalInput, ...Object.values(macroInputs)]) {
    input.addEventListener('input', showMessages)
  }

  openOverlay(overlay)
  return overlay
}
