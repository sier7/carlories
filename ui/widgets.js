/** 共享界面构件：浮层、提示条、表单字段。抽出来是为了让食物表单和记录表单长得一样。 */

import { h } from './dom.js'

// ── 浮层 ────────────────────────────────────────────────────────────────

export function openOverlay(node) {
  document.body.appendChild(node)
  return node
}

export function closeOverlay() {
  const node = document.querySelector('.overlay')
  if (node) node.remove()
}

/** 标准浮层骨架：吸顶标题栏 + 可滚动内容 + 吸底操作栏 */
export function sheet({ title, body, footer = null, cancelLabel = '取消' }) {
  const overlay = h('div', { class: 'overlay' },
    h('div', { class: 'sheet' },
      h('header', { class: 'sheet-head' },
        h('h2', null, title),
        h('button', {
          class: 'icon-btn',
          type: 'button',
          onClick: () => overlay.remove(),
        }, cancelLabel),
      ),
      h('div', { class: 'sheet-body' }, body),
      footer ? h('footer', { class: 'sheet-foot' }, footer) : null,
    ),
  )
  return overlay
}

export function sheetButton(label, onClick, { primary = false, danger = false } = {}) {
  return h('button', {
    class: `btn${primary ? ' primary' : ''}${danger ? ' danger' : ''}`,
    type: 'button',
    onClick,
  }, label)
}

// ── 表单字段 ────────────────────────────────────────────────────────────

/**
 * 单输入字段用 <label> 包裹，点标题即可聚焦（手机上很实用）。
 * 含多个控件的字段（分段控件、勾选行）必须用 <div>，否则会产生嵌套
 * <label>，既非法又会让点击落到不确定的目标上。
 */
export function field(label, control, extra = null, { wrapLabel = false } = {}) {
  return h(wrapLabel ? 'label' : 'div', { class: 'field' },
    h('span', { class: 'field-label' }, label),
    control,
    extra,
  )
}

export function textInput(value, placeholder) {
  return h('input', {
    type: 'text',
    class: 'text-input',
    value: value ?? '',
    placeholder: placeholder || '',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
  })
}

/**
 * 用 type="text" + inputmode="decimal" 而不是 type="number"：
 * 手机上同样弹数字键盘，但不会出现 iOS 上 number 输入框难以清空的问题，
 * 也不会放行 "e"、"+" 这类字符。
 */
export function numberInput(value, placeholder, decimals = 1) {
  return h('input', {
    type: 'text',
    class: 'text-input num',
    inputmode: 'decimal',
    value: value === null || value === undefined ? '' : String(value),
    placeholder: placeholder || '',
    autocomplete: 'off',
    dataset: { decimals: String(decimals) },
  })
}

export function timeInput(value) {
  return h('input', {
    type: 'time',
    class: 'text-input num',
    value: value || '',
  })
}

export function segmented(name, options, current, onChange) {
  const wrap = h('div', { class: 'segmented', dataset: { group: name } })
  for (const option of options) {
    const id = `${name}-${option.value}`
    wrap.appendChild(
      h('input', {
        type: 'radio',
        name: `seg-${name}`,
        id,
        value: option.value,
        checked: option.value === current,
        onChange: () => onChange(option.value),
      }),
    )
    wrap.appendChild(h('label', { for: id }, option.label))
  }
  return wrap
}

export function selectedValue(container) {
  const checked = container.querySelector('input:checked')
  return checked ? checked.value : null
}

// ── 提示条 ──────────────────────────────────────────────────────────────

let toastTimer = null

export function toast(message, kind = 'ok') {
  let node = document.getElementById('toast')
  if (!node) {
    node = h('div', { id: 'toast', class: 'toast' })
    document.body.appendChild(node)
  }
  node.className = `toast ${kind}`
  node.textContent = message
  node.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(
    () => node.classList.remove('show'),
    kind === 'error' ? 6000 : 2600,
  )
}
