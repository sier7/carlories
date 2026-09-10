/** 各类编辑浮层：改记录份量、设目标、填消耗。 */

import { h } from './dom.js'
import { sheet, sheetButton, field, numberInput, timeInput, openOverlay } from './widgets.js'
import {
  FIELD_LABEL,
  FIELD_UNIT,
  FIELD_DECIMALS,
  availableUnits,
  basisLabel,
  nutritionForAmount,
  round,
  toNumberOrNull,
} from '../core/food.js'
import { withAmount, refreshEntrySnapshot, isEntryStale } from '../core/log.js'
import * as healthSync from '../core/healthSync.js'
import { freshness } from '../storage/dayRepo.js'
import { fmtKcal, fmtGram, fmtAmount } from './format.js'
import { dateLabel } from '../core/date.js'

/** 编辑一条记录：改份量、改时间、删除、或把快照更新到食物的当前值 */
export function openEntrySheet({ entry, food, onSave, onDelete }) {
  const units = availableUnits(entry.snapshot)
  const canUseServing = units.includes('serving')

  const amountInput = numberInput(entry.amount, '', 1)
  const unitSelect = h('select', { class: 'unit-select' },
    h('option', { value: 'g' }, 'g'),
    ...(canUseServing ? [h('option', { value: 'serving' }, '份')] : []),
  )
  unitSelect.value = canUseServing ? entry.unit : 'g'
  const timeField = timeInput(entry.time)

  const previewOut = h('div', { class: 'preview-out' })
  const messages = h('div', { class: 'messages' })

  const stale = isEntryStale(entry, food)

  function readAmount() {
    return {
      amount: toNumberOrNull(amountInput.value),
      unit: unitSelect.value,
    }
  }

  function renderPreview() {
    const { amount, unit } = readAmount()
    const result = nutritionForAmount(entry.snapshot, amount, unit)
    if (!result || amount === null) {
      previewOut.replaceChildren(h('span', { class: 'muted' }, '输入份量后显示'))
      return
    }
    previewOut.replaceChildren(
      h('strong', null, `${round(result.energyKcal, 0) ?? '—'} kcal`),
      h('span', null, `蛋白 ${fmtGram(result.proteinG)}`),
      h('span', null, `脂肪 ${fmtGram(result.fatG)}`),
      h('span', null, `碳水 ${fmtGram(result.carbG)}`),
    )
  }

  function showError(message) {
    messages.replaceChildren(h('p', { class: 'msg error' }, `✕ ${message}`))
  }

  async function save() {
    const { amount, unit } = readAmount()
    if (amount === null || amount <= 0) {
      showError('份量必须大于 0')
      return
    }
    try {
      const updated = withAmount(entry, amount, unit)
      updated.time = timeField.value || entry.time
      await onSave(updated)
      overlay.remove()
    } catch (error) {
      showError(error.message || String(error))
    }
  }

  async function updateToCurrent() {
    try {
      await onSave(refreshEntrySnapshot(entry, food))
      overlay.remove()
    } catch (error) {
      showError(error.message || String(error))
    }
  }

  const footer = [
    sheetButton('删除', async () => {
      if (!confirm('删除这条记录？')) return
      await onDelete(entry.id)
      overlay.remove()
    }, { danger: true }),
    h('div', { class: 'spacer' }),
    sheetButton('保存', save, { primary: true }),
  ]

  const overlay = sheet({
    title: '编辑记录',
    body: [
      h('div', { class: 'readout' },
        h('div', { class: 'readout-name' }, entry.snapshot.name),
        h('div', { class: 'readout-sub' },
          `${basisLabel(entry.snapshot)} · ${dateLabel(entry.date)}`),
      ),

      stale
        ? h('div', { class: 'msg warn' },
            '这条记录依据的是旧版食物数据。你可以保持原样（历史不被改写），'
            + '也可以用食物库里现在的值更新它。',
            h('div', { style: { marginTop: '8px' } },
              sheetButton('按当前数据更新', updateToCurrent)),
          )
        : null,

      h('div', { class: 'field-row' },
        field('份量', amountInput, null, { wrapLabel: true }),
        field('单位', unitSelect),
      ),
      field('时间', timeField, null, { wrapLabel: true }),

      h('section', { class: 'preview' },
        h('h3', null, '这条记录贡献'),
        previewOut,
        h('p', { class: 'hint' },
          `记录当时的依据：${fmtAmount(entry.amount, entry.unit)} × ${basisLabel(entry.snapshot)}`),
      ),

      messages,
    ],
    footer,
  })

  amountInput.addEventListener('input', renderPreview)
  unitSelect.addEventListener('change', renderPreview)
  renderPreview()

  openOverlay(overlay)
  return overlay
}

/** 设定每日目标。留空表示不设该项，界面就不显示对应的进度。 */
export function openTargetsSheet({ targets, onSave }) {
  const inputs = {}
  for (const key of ['energyKcal', 'proteinG', 'fatG', 'carbG']) {
    inputs[key] = numberInput(targets ? targets[key] : null, '', key === 'energyKcal' ? 0 : 1)
  }

  const messages = h('div', { class: 'messages' })

  async function save() {
    const next = {}
    for (const [key, input] of Object.entries(inputs)) next[key] = toNumberOrNull(input.value)
    for (const [key, value] of Object.entries(next)) {
      if (value !== null && value < 0) {
        messages.replaceChildren(h('p', { class: 'msg error' }, `✕ ${FIELD_LABEL[key]}不能为负数`))
        return
      }
    }
    try {
      await onSave(next)
      overlay.remove()
    } catch (error) {
      messages.replaceChildren(h('p', { class: 'msg error' }, `✕ ${error.message}`))
    }
  }

  const overlay = sheet({
    title: '每日目标',
    body: [
      h('p', { class: 'hint' },
        '留空就是不设这一项，界面不会显示对应进度。'
        + '三大营养素用克数设而不是百分比 —— 蛋白需求通常按体重算，'
        + '用百分比设会让它在低热量日被压得过低。'),
      h('div', { class: 'nutrient-grid' },
        field(`热量（${FIELD_UNIT.energyKcal}）`, inputs.energyKcal, null, { wrapLabel: true }),
        field(`蛋白质（${FIELD_UNIT.proteinG}）`, inputs.proteinG, null, { wrapLabel: true }),
        field(`脂肪（${FIELD_UNIT.fatG}）`, inputs.fatG, null, { wrapLabel: true }),
        field(`碳水（${FIELD_UNIT.carbG}）`, inputs.carbG, null, { wrapLabel: true }),
      ),
      messages,
    ],
    footer: [
      h('div', { class: 'spacer' }),
      sheetButton('保存', save, { primary: true }),
    ],
  })

  openOverlay(overlay)
  return overlay
}

/** 健康数据同步设置与手动触发 */
export function openSyncSheet({
  sync,
  health,
  onSaveConfig,
  onPullRelay,
  onPullClipboard,
  onClear,
}) {
  const { parseRelayConfig, formatRelayConfig } = healthSync
  const configured = Boolean(sync && sync.endpoint && sync.token)
  const configInput = h('textarea', {
    class: 'paste-area',
    rows: 3,
    placeholder: '把部署脚本打印的那一整行粘到这里',
    value: configured ? formatRelayConfig(sync) : '',
  })

  const statusLines = []
  if (health && health.importedAt) {
    const sourceLabel =
      health.source === 'relay' ? '中继' : health.source === 'shortcut' ? '快捷指令（剪贴板）' : '手动填写'
    statusLines.push(`上次同步：${freshness(health) || '刚刚'} · 来源：${sourceLabel}`)
  } else {
    statusLines.push('今天还没有消耗数据')
  }
  statusLines.push(
    configured ? `中继已配置：${sync.endpoint}` : '中继未配置 —— 每次需要手动点一下读剪贴板',
  )

  const messages = h('div', { class: 'messages' })

  function showError(message) {
    messages.replaceChildren(h('p', { class: 'msg error' }, `✕ ${message}`))
  }

  async function save() {
    const raw = configInput.value.trim()
    if (raw === '') {
      try {
        await onSaveConfig({ endpoint: null, token: null })
        overlay.remove()
      } catch (error) {
        showError(error.message)
      }
      return
    }
    const parsed = parseRelayConfig(raw)
    if (!parsed || parsed.incomplete) {
      showError('这行配置看不懂。应当是部署脚本打印的 carlories-relay:v1|…|… 那一整行。')
      return
    }
    try {
      await onSaveConfig({ endpoint: parsed.endpoint, token: parsed.token })
      overlay.remove()
    } catch (error) {
      showError(error.message)
    }
  }

  const overlay = sheet({
    title: '健康数据同步',
    body: [
      h('div', { class: 'readout' },
        h('div', { class: 'readout-name' }, configured ? '中继同步已开启' : '中继同步未开启'),
        ...statusLines.map((line) => h('div', { class: 'readout-sub' }, line)),
      ),

      h('p', { class: 'hint' },
        configured
          ? '打开应用时会自动从中继拉取，不需要任何点击。中继上的数据保留 400 天，'
            + '所以本地数据丢了也能补回来。'
          : 'iOS 上网页读剪贴板必须由你点一下（系统限制），所以没有中继时每次都要手动同步。'
            + '配好中继之后就不需要了。'),

      configured
        ? sheetButton('立即从服务器拉取', async () => {
            await onPullRelay()
            overlay.remove()
          }, { primary: true })
        : null,

      configured
        ? sheetButton('从剪贴板读取（兜底）', async () => {
            await onPullClipboard()
            overlay.remove()
          })
        : sheetButton('从剪贴板读取一次', async () => {
            await onPullClipboard()
            overlay.remove()
          }, { primary: true }),

      field('中继配置', configInput, null, { wrapLabel: true }),
      sheetButton('保存配置', save, { primary: !configured }),
      h('p', { class: 'hint' },
        '清空这里并保存即可关闭中继。中继上存的是每天两个整数（活动能量、静息能量），'
        + '口令在你自己的手机上。'),

      health
        ? sheetButton('清除今天的消耗数据', async () => {
            await onClear()
            overlay.remove()
          }, { danger: true })
        : null,

      messages,
    ],
  })

  openOverlay(overlay)
  return overlay
}

/** 填写当日消耗。中继或剪贴板同步写入的就是同一条记录。 */
export function openBurnSheet({ date, health, onSave, onClear }) {
  const activeInput = numberInput(health ? health.activeKcal : null, '健康 App 里的活动能量', 0)
  const restingInput = numberInput(health ? health.restingKcal : null, '健康 App 里的静息能量', 0)
  const messages = h('div', { class: 'messages' })

  async function save() {
    const activeKcal = toNumberOrNull(activeInput.value)
    const restingKcal = toNumberOrNull(restingInput.value)
    if (activeKcal === null && restingKcal === null) {
      messages.replaceChildren(
        h('p', { class: 'msg error' }, '✕ 两项都空着，先填一个，或者用「清除」'),
      )
      return
    }
    try {
      await onSave({ activeKcal, restingKcal })
      overlay.remove()
    } catch (error) {
      messages.replaceChildren(h('p', { class: 'msg error' }, `✕ ${error.message}`))
    }
  }

  const overlay = sheet({
    title: `${dateLabel(date)}的消耗`,
    body: [
      h('p', { class: 'hint' },
        '打开健康 App → 浏览 → 活动，把「活动能量」和「静息能量」今天的数字抄过来。'
        + '快捷指令自动同步还在验证中（见 docs/M0-健康桥验证.md），'
        + '在它跑通之前，这里是唯一的数据来源。'),
      h('div', { class: 'nutrient-grid' },
        field('活动能量（kcal）', activeInput, null, { wrapLabel: true }),
        field('静息能量（kcal）', restingInput, null, { wrapLabel: true }),
      ),
      messages,
    ],
    footer: [
      health ? sheetButton('清除', async () => { await onClear(); overlay.remove() }, { danger: true }) : null,
      h('div', { class: 'spacer' }),
      sheetButton('保存', save, { primary: true }),
    ],
  })

  openOverlay(overlay)
  return overlay
}
