#!/usr/bin/env node
/**
 * 界面冒烟测试。
 *
 * 为什么需要它：`node --check` 只验语法，抓不到两类真实故障 ——
 *   1. 跨模块导入不存在的东西（如 import { foo } 但对面没导出 foo）
 *   2. 界面构建时的运行时崩溃（拼错属性名、对 null 取值）
 * 这两类都会让应用在手机上白屏，而你在 Windows 上是看不到的。
 *
 * 视图模块是纯函数（state + handlers → DOM），所以这里可以**直接**调用它们，
 * 而不必去启动整个应用再猜 DOM 里发生了什么。这一层验证的是
 * 「算出来的数字确实流到了它该去的位置」—— 数学本身由 test-core 精确验证。
 *
 * 用的是一个**最小 DOM 桩**（不是 DOM 实现，只覆盖本应用用到的 API）。
 * 它能证明「不崩、数字对」，**不能证明「好看」** —— 视觉效果仍然只能在
 * 真实浏览器或真机上看。
 *
 * 运行：node tools/test-ui-smoke.mjs
 */

import assert from 'node:assert/strict'

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.log(`  ✗ ${name}\n      ${error.message}`)
  }
}

function group(title) {
  console.log(`\n${title}`)
}

function tick() {
  return new Promise((r) => setTimeout(r, 5))
}

// ── 最小 DOM 桩 ─────────────────────────────────────────────────────────

class ClassList {
  constructor() {
    this.set = new Set()
  }
  add(...names) {
    names.forEach((n) => this.set.add(n))
  }
  remove(...names) {
    names.forEach((n) => this.set.delete(n))
  }
  contains(name) {
    return this.set.has(name)
  }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force)
    if (on) this.set.add(name)
    else this.set.delete(name)
    return on
  }
  toString() {
    return [...this.set].join(' ')
  }
}

class Node {
  constructor(tagName) {
    this.nodeType = 1
    this.tagName = String(tagName).toUpperCase()
    this.childNodes = []
    this.attributes = {}
    this.dataset = {}
    this.style = {}
    this.parentNode = null
    this.eventListeners = {}
    this._classList = new ClassList()
    this._value = ''
    this._checked = false
    this._disabled = false
  }

  get classList() {
    return this._classList
  }
  get className() {
    return this._classList.toString()
  }
  set className(value) {
    this._classList = new ClassList()
    String(value)
      .split(/\s+/)
      .filter(Boolean)
      .forEach((c) => this._classList.add(c))
  }

  get firstChild() {
    return this.childNodes[0] || null
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1)
  }

  get value() {
    // 真实 DOM 中 <select> 的 value 是「当前选中项」的值，未显式选中时
    // 默认取第一项。桩必须照做，否则读 select.value 永远得到空串。
    if (this.tagName === 'SELECT') {
      const options = this.childNodes.filter((n) => n.nodeType === 1 && n.tagName === 'OPTION')
      const chosen = options.find((o) => o._selected) || options[0]
      return chosen ? chosen._value : ''
    }
    return this._value
  }
  set value(v) {
    const s = v === null || v === undefined ? '' : String(v)
    this._value = s
    // 真实 DOM 里 input/option 的 value 是反射属性，这里照做，
    // 否则 querySelector('option[value="serving"]') 找不到元素
    this.attributes.value = s
    if (this.tagName === 'SELECT') {
      for (const o of this.childNodes) {
        if (o.nodeType === 1 && o.tagName === 'OPTION') o._selected = o._value === s
      }
    }
  }

  get checked() {
    return this._checked
  }
  set checked(v) {
    this._checked = Boolean(v)
  }
  get disabled() {
    return this._disabled
  }
  set disabled(v) {
    this._disabled = Boolean(v)
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
    if (name === 'value') this._value = String(value)
  }
  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null
  }

  appendChild(child) {
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child)
    if (i >= 0) this.childNodes.splice(i, 1)
    return child
  }
  replaceChildren(...nodes) {
    this.childNodes = []
    for (const n of nodes) if (n) this.appendChild(n)
  }

  addEventListener(type, fn) {
    ;(this.eventListeners[type] ||= []).push(fn)
  }
  removeEventListener() {}
  dispatch(type, event = {}) {
    for (const fn of this.eventListeners[type] || []) fn({ target: this, ...event })
  }
  /** 按可见文本找按钮，模拟用户点它 */
  clickByText(text) {
    const target = this.querySelectorAll('button').find((b) => b.textContent === text)
    if (!target) throw new Error(`找不到文本为「${text}」的按钮`)
    target.dispatch('click')
    return target
  }

  focus() {}
  blur() {}
  scrollIntoView() {}
  click() {}
  setSelectionRange() {}
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null
  }
  querySelectorAll(selector) {
    const out = []
    walk(this, (node) => {
      if (matches(node, selector)) out.push(node)
    })
    return out
  }

  get textContent() {
    if (this.nodeType === 3) return this._value
    return this.childNodes.map((n) => n.textContent ?? '').join('')
  }
  set textContent(value) {
    this.childNodes = [textNode(String(value))]
  }
}

function textNode(text) {
  const node = new Node('#text')
  node.nodeType = 3
  node._value = text
  return node
}

function walk(node, visit) {
  for (const child of node.childNodes) {
    visit(child)
    walk(child, visit)
  }
}

/** 只支持本应用用到的一小撮选择器：tag、.class、.a.b、tag:checked、tag[attr="v"] */
function matches(node, selector) {
  if (node.nodeType !== 1) return false

  let sel = selector
  let checkedOnly = false
  if (sel.endsWith(':checked')) {
    checkedOnly = true
    sel = sel.slice(0, -':checked'.length)
  }

  let attrName = null
  let attrValue = null
  const attrMatch = sel.match(/\[([\w-]+)="([^"]*)"\]$/)
  if (attrMatch) {
    attrName = attrMatch[1]
    attrValue = attrMatch[2]
    sel = sel.slice(0, attrMatch.index)
  }

  // 前导点表示没有标签名部分，否则第一段是标签名。
  // 不区分这一点的话，'.macro-bar.over' 会被当成「标签 macro-bar」而永远匹配不上。
  const leadingDot = sel.startsWith('.')
  const parts = sel.split('.').filter(Boolean)
  const tag = leadingDot ? '' : parts.shift() || ''
  const classes = parts

  if (tag && node.tagName !== tag.toUpperCase()) return false
  for (const cls of classes) {
    if (!node.classList.contains(cls)) return false
  }
  if (checkedOnly && !node.checked) return false
  if (attrName && node.getAttribute(attrName) !== attrValue) return false
  return true
}

const documentRoot = new Node('#document')

const documentStub = {
  createElement: (tag) => new Node(tag),
  createTextNode: (text) => textNode(text),
  getElementById: (id) => documentRoot.querySelector(`[id="${id}"]`),
  querySelector: (sel) => documentRoot.querySelector(sel),
  body: new Node('body'),
  addEventListener() {},
}

globalThis.Node = Node
globalThis.document = documentStub
globalThis.window = globalThis
// 刻意不提供 indexedDB：用来验证「存储不可用」时应用仍能渲染出可读的错误，
// 而不是白屏。这是手机上最糟的失败模式。

const appRoot = new Node('div')
appRoot.setAttribute('id', 'app')
documentRoot.appendChild(appRoot)

// ── A. 模块链接检查 ─────────────────────────────────────────────────────

group('模块链接：每个模块都能被解析并加载')
{
  const modules = [
    '../app/core/food.js',
    '../app/core/log.js',
    '../app/core/date.js',
    '../app/core/history.js',
    '../app/storage/db.js',
    '../app/storage/foodRepo.js',
    '../app/storage/logRepo.js',
    '../app/storage/settingsRepo.js',
    '../app/storage/dayRepo.js',
    '../app/ui/dom.js',
    '../app/ui/widgets.js',
    '../app/ui/format.js',
    '../app/ui/foodForm.js',
    '../app/ui/freeEntryForm.js',
    '../app/ui/sheets.js',
    '../app/ui/foodPicker.js',
    '../app/ui/dayView.js',
    '../app/ui/libraryView.js',
    '../app/ui/main.js',
  ]
  for (const path of modules) {
    try {
      await import(path)
      passed++
      console.log(`  ✓ 可加载 ${path}`)
    } catch (error) {
      failed++
      console.log(`  ✗ 无法加载 ${path}\n      ${error.message}`)
    }
  }
}

// ── B. 应用外壳在存储不可用时仍能渲染 ───────────────────────────────────

group('应用外壳：IndexedDB 不可用时不能白屏')
{
  await tick()
  await tick()

  const text = appRoot.textContent

  check('默认落在「今日」页', () => {
    assert.ok(text.includes('今日摄入'), `实际：${text.slice(0, 200)}`)
  })
  check('有「记录一条」入口', () => {
    assert.ok(text.includes('+ 记录一条'))
  })
  check('渲染出空状态说明，而不是白屏', () => {
    assert.ok(text.includes('这一天还没有记录'), `实际：${text.slice(0, 300)}`)
  })
  check('明确报出了失败原因', () => {
    assert.ok(text.includes('IndexedDB'), `实际：${text.slice(0, 300)}`)
  })
  check('底部标签栏有今日与食物库两个入口', () => {
    assert.ok(text.includes('今日') && text.includes('食物库'))
  })
}

// ── C. 今日页：数字确实流到了它该去的位置 ───────────────────────────────

group('今日页')
{
  const { dayView } = await import('../app/ui/dayView.js')
  const { createFood, STATE_RAW, STATE_COOKED } = await import('../app/core/food.js')
  const { buildEntryFromFood, buildFreeEntry, entryNutrients, validateEntry } = await import(
    '../app/core/log.js'
  )
  const { fmtKcal, fmtGram, fmtDelta } = await import('../app/ui/format.js')

  const egg = createFood({
    name: '鸡蛋（全蛋）',
    basis: { type: 'per100g' },
    state: STATE_RAW,
    energyKcal: 143,
    proteinG: 13,
    fatG: 9,
    carbG: 1,
  })
  const rice = createFood({
    name: '米饭（熟）',
    basis: { type: 'per100g' },
    state: STATE_COOKED,
    energyKcal: 130,
    proteinG: 2.6,
    fatG: 0.3,
    carbG: 28.6,
  })

  const entries = [
    buildEntryFromFood({ food: egg, amount: 100, unit: 'g', date: '2026-10-03', time: '08:12' }),
    buildEntryFromFood({ food: rice, amount: 200, unit: 'g', date: '2026-10-03', time: '12:30' }),
  ]

  const calls = []
  const handlers = {
    goDay: (d) => calls.push(['goDay', d]),
    goToday: () => calls.push(['goToday']),
    openPicker: () => calls.push(['openPicker']),
    openEntry: (e) => calls.push(['openEntry', e.id]),
    openTargets: () => calls.push(['openTargets']),
    openBurn: () => calls.push(['openBurn']),
  }

  const baseState = {
    date: '2026-10-03',
    today: '2026-10-03',
    foods: [egg, rice],
    entries,
    health: null,
    targets: null,
  }

  const withoutHealth = dayView(baseState, handlers)
  const textNoHealth = withoutHealth.textContent

  check('主角数字 = 143 + 260 = 403 kcal', () => {
    assert.ok(textNoHealth.includes(fmtKcal(403)), `实际：${textNoHealth.slice(0, 300)}`)
  })
  check('蛋白质合计 13 + 5.2 = 18.2 g', () => {
    assert.ok(textNoHealth.includes(fmtGram(18.2)), `实际：${textNoHealth.slice(0, 400)}`)
  })
  check('列出了两条记录，含名称与份量', () => {
    assert.ok(textNoHealth.includes('鸡蛋（全蛋）'))
    assert.ok(textNoHealth.includes('米饭（熟）'))
    assert.ok(textNoHealth.includes('100 g'))
  })
  check('没有消耗数据时显示「未填写」并给出说明', () => {
    assert.ok(textNoHealth.includes('未填写'))
    assert.ok(textNoHealth.includes('净差'))
  })
  check('没设目标时不渲染进度条', () => {
    assert.equal(withoutHealth.querySelectorAll('.macro-bar').length, 0)
  })
  check('记录条数与主角数字一起显示', () => {
    assert.ok(textNoHealth.includes('共 2 条记录'))
  })

  // 加上消耗与目标
  const health = {
    date: '2026-10-03',
    activeKcal: 800,
    restingKcal: 1650,
    source: 'manual',
    importedAt: new Date().toISOString(),
  }
  const targets = { energyKcal: 2000, proteinG: 140, fatG: 60, carbG: 250 }
  const full = dayView({ ...baseState, health, targets }, handlers)
  const textFull = full.textContent

  check('消耗 = 800 + 1650 = 2450 kcal', () => {
    assert.ok(textFull.includes(fmtKcal(2450)), `实际：${textFull.slice(0, 400)}`)
  })
  check('净差 = 403 − 2450 = −2047', () => {
    assert.ok(textFull.includes(fmtDelta(-2047)), `实际：${textFull.slice(0, 400)}`)
  })
  check('净差为负时标注为赤字', () => {
    assert.ok(textFull.includes('赤字'))
  })
  check('设了目标就渲染三条进度条', () => {
    assert.equal(full.querySelectorAll('.macro-bar').length, 3)
  })
  check('目标值显示在营养素旁边', () => {
    assert.ok(textFull.includes(`/ ${fmtGram(140)} g`), `实际：${textFull.slice(0, 400)}`)
  })
  check('热量目标与剩余额度显示在主角数字下方', () => {
    // 403 摄入 vs 2000 目标 → 还剩 1597
    assert.ok(textFull.includes(`目标 ${fmtKcal(2000)} kcal`), `实际：${textFull.slice(0, 300)}`)
    assert.ok(textFull.includes(`还剩 ${fmtKcal(1597)}`), `实际：${textFull.slice(0, 300)}`)
  })
  check('没设热量目标时不显示这一行', () => {
    const noKcalTarget = dayView(
      { ...baseState, targets: { energyKcal: null, proteinG: 140, fatG: null, carbG: null } },
      handlers,
    )
    assert.ok(!noKcalTarget.textContent.includes('还剩'))
  })
  check('超出热量目标时显示超出的量', () => {
    const overKcal = dayView(
      { ...baseState, targets: { energyKcal: 300, proteinG: null, fatG: null, carbG: null } },
      handlers,
    )
    assert.ok(overKcal.textContent.includes(`超出 ${fmtKcal(103)}`),
      `实际：${overKcal.textContent.slice(0, 300)}`)
  })
  check('目标已达成时进度条标记 over', () => {
    // 蛋白只吃了 18.2/140，不该 over；脂肪 9.3/60 也不该
    assert.equal(full.querySelectorAll('.macro-bar.over').length, 0)
  })

  const overTarget = dayView(
    { ...baseState, health, targets: { ...targets, proteinG: 10 } },
    handlers,
  )
  check('超标时那条进度条标记 over', () => {
    assert.equal(overTarget.querySelectorAll('.macro-bar.over').length, 1)
  })

  group('今日页：过期数据标记')
  const staleFood = { ...egg, energyKcal: 200, updatedAt: new Date(Date.now() + 5000).toISOString() }
  const staleView = dayView({ ...baseState, foods: [staleFood, rice] }, handlers)
  check('食物被改过之后，受影响的记录被标为「旧数据」', () => {
    assert.ok(staleView.textContent.includes('旧数据'))
  })
  check('同时给出可操作的提示', () => {
    assert.ok(staleView.textContent.includes('旧版食物数据'))
  })
  check('记录本身的数值没有被追改（仍是 143）', () => {
    assert.ok(staleView.textContent.includes(fmtKcal(403)))
  })

  group('今日页：跨日期')
  const yesterday = dayView(
    { ...baseState, date: '2026-10-02', today: '2026-10-03' },
    handlers,
  )
  check('非今天的日期不再叫「今日摄入」', () => {
    assert.ok(!yesterday.textContent.includes('今日摄入'))
    assert.ok(yesterday.textContent.includes('当日摄入'))
  })
  check('日期标签显示为「昨天」', () => {
    assert.ok(yesterday.textContent.includes('昨天'))
  })

  group('今日页：点击接到了正确的处理函数')
  const pickBtn = withoutHealth.querySelectorAll('button').find((b) => b.textContent === '+ 记录一条')
  check('点「记录一条」调用 openPicker', () => {
    const before = calls.length
    pickBtn.dispatch('click')
    assert.ok(calls.slice(before).some((c) => c[0] === 'openPicker'))
  })
  check('点某条记录调用 openEntry 并带上它的 id', () => {
    const before = calls.length
    withoutHealth.querySelectorAll('.entry-item')[0].dispatch('click')
    assert.ok(calls.slice(before).some((c) => c[0] === 'openEntry' && c[1] === entries[0].id))
  })
  check('点消耗行调用 openBurn', () => {
    const before = calls.length
    withoutHealth.querySelectorAll('.balance-row')[0].dispatch('click')
    assert.ok(calls.slice(before).some((c) => c[0] === 'openBurn'))
  })

  group('今日页：外食那种「只填了热量」的记录')
  const beef = buildFreeEntry({
    name: '楼下牛肉面',
    energyKcal: 800,
    date: '2026-10-03',
    time: '12:30',
  })
  const mixed = dayView({ ...baseState, entries: [entries[0], beef] }, handlers)
  const mixedText = mixed.textContent

  check('热量合计包含它（143 + 800 = 943）', () => {
    assert.ok(mixedText.includes(fmtKcal(943)), `实际：${mixedText.slice(0, 300)}`)
  })
  check('手填条目在列表里标为「手动填写」，不假装有份量', () => {
    assert.ok(mixedText.includes('手动填写'))
  })
  check('明确说出有几条没填营养素、合计因此偏低', () => {
    assert.ok(mixedText.includes('1 条记录没填营养素'), `实际：${mixedText.slice(0, 500)}`)
  })
  check('营养素合计只包含有数据的那条，没有被当 0 蒙混', () => {
    // 鸡蛋 100 g → 蛋白 13；牛肉面没填 → 合计仍是 13
    assert.ok(mixedText.includes(fmtGram(13)), `实际：${mixedText.slice(0, 500)}`)
  })
  check('全部记录都有营养素时不出现这个提示', () => {
    assert.ok(!withoutHealth.textContent.includes('没填营养素'))
  })
}

// ── D. 食物库页 ─────────────────────────────────────────────────────────

group('食物库页')
{
  const { libraryView } = await import('../app/ui/libraryView.js')
  const { createFood, STATE_RAW } = await import('../app/core/food.js')

  const egg = createFood({
    name: '鸡蛋（全蛋）',
    basis: { type: 'per100g' },
    state: STATE_RAW,
    energyKcal: 143,
    proteinG: 13,
    fatG: 9,
    carbG: 1,
    verified: true,
  })
  const bar = createFood({
    name: '蛋白棒',
    basis: { type: 'perServing', servingGrams: 60, servingLabel: '1 根' },
    energyKcal: 220,
    proteinG: 20,
    fatG: 7,
    carbG: 22,
    source: '包装标签',
  })

  const handlers = { setQuery: () => {}, newFood: () => {}, editFood: () => {}, exportData: () => {}, importData: () => {} }

  check('空库时给出建库引导', () => {
    const node = libraryView({ foods: [], query: '' }, handlers)
    assert.ok(node.textContent.includes('核心资产'))
  })

  check('列出条目并标注基准量', () => {
    const node = libraryView({ foods: [egg, bar], query: '' }, handlers)
    assert.ok(node.textContent.includes('鸡蛋（全蛋）'))
    assert.ok(node.textContent.includes('每 100 g'))
    assert.ok(node.textContent.includes('每 1 根（60 g）'))
  })

  check('未核对的条目带「待核对」标记，已核对的不带', () => {
    const node = libraryView({ foods: [egg, bar], query: '' }, handlers)
    assert.equal(node.querySelectorAll('.badge.unverified').length, 1)
  })

  check('状态标记只在非「不适用」时出现', () => {
    const node = libraryView({ foods: [egg, bar], query: '' }, handlers)
    assert.equal(node.querySelectorAll('.badge.state-raw').length, 1)
  })

  check('搜索命中过滤', () => {
    const node = libraryView({ foods: [egg, bar], query: '蛋白' }, handlers)
    assert.ok(node.textContent.includes('蛋白棒'))
    assert.ok(!node.textContent.includes('鸡蛋'))
  })

  check('搜索无结果时给出提示', () => {
    const node = libraryView({ foods: [egg, bar], query: '不存在' }, handlers)
    assert.ok(node.textContent.includes('没有匹配'))
  })

  check('统计行汇总已核对情况', () => {
    const node = libraryView({ foods: [egg, bar], query: '' }, handlers)
    assert.ok(node.textContent.includes('共 2 条'))
    assert.ok(node.textContent.includes('1 条未核对'))
  })
}

// ── E. 食物表单 ─────────────────────────────────────────────────────────

group('食物表单：构建不崩，且试算结果正确')
{
  const { createFoodForm } = await import('../app/ui/foodForm.js')
  const { createFood } = await import('../app/core/food.js')

  const food = createFood({
    name: '鸡蛋（全蛋）',
    basis: { type: 'per100g' },
    state: 'raw',
    energyKcal: 143,
    proteinG: 13,
    fatG: 9,
    carbG: 1,
  })

  let saved = null
  let overlay = null

  check('构建表单不抛错', () => {
    overlay = createFoodForm({
      food,
      onSave: (draft) => (saved = draft),
      onDelete: () => {},
      onCancel: () => {},
    })
    assert.ok(overlay)
  })

  check('默认 100 g 的试算等于库中原值', () => {
    const text = overlay.querySelector('.preview-out').textContent
    assert.ok(text.includes('143'), `实际：${text}`)
  })

  check('无校验错误时消息区为空', () => {
    assert.equal(overlay.querySelector('.messages').textContent, '')
  })

  check('基准量段控件的默认选中项与条目一致', () => {
    const basisGroup = overlay
      .querySelectorAll('.segmented')
      .find((g) => g.dataset.group === 'basis')
    assert.equal(basisGroup.querySelector('input:checked').value, 'per100g')
  })

  check('状态段控件同样正确回填', () => {
    const stateGroup = overlay
      .querySelectorAll('.segmented')
      .find((g) => g.dataset.group === 'state')
    assert.equal(stateGroup.querySelector('input:checked').value, 'raw')
  })

  check('每 100 g 的条目禁用「份」这个单位', () => {
    const row = overlay.querySelector('.preview-row')
    const servingOption = row.querySelector('option[value="serving"]')
    assert.equal(servingOption.disabled, true)
  })

  check('点保存能收出完整的草稿对象', () => {
    overlay.clickByText('保存')
    assert.ok(saved, 'onSave 未被调用')
    assert.equal(saved.name, '鸡蛋（全蛋）')
    assert.equal(saved.energyKcal, 143)
    assert.equal(saved.state, 'raw')
  })
}

group('食物表单：必填项缺失时阻断保存并给出原因')
{
  const { createFoodForm } = await import('../app/ui/foodForm.js')
  const { createFood } = await import('../app/core/food.js')

  const blank = createFood({ state: 'na', basis: { type: 'per100g' } })
  let saved = null
  const overlay = createFoodForm({
    food: blank,
    onSave: (draft) => (saved = draft),
    onDelete: () => {},
    onCancel: () => {},
  })

  overlay.clickByText('保存')

  check('空表单点保存被拦截', () => {
    assert.equal(saved, null)
  })
  check('给出了阻断原因（名称与热量）', () => {
    const text = overlay.querySelector('.messages').textContent
    assert.ok(text.includes('名称'), `实际：${text}`)
    assert.ok(text.includes('热量'), `实际：${text}`)
  })
}

group('食物表单：每份条目的试算默认按「份」而不是按 100 g')
{
  const { createFoodForm } = await import('../app/ui/foodForm.js')
  const { createFood } = await import('../app/core/food.js')

  const bar = createFood({
    name: '蛋白棒',
    basis: { type: 'perServing', servingGrams: 60, servingLabel: '1 根' },
    energyKcal: 220,
    proteinG: 20,
    fatG: 7,
    carbG: 22,
  })

  const overlay = createFoodForm({ food: bar, onSave: () => {}, onDelete: () => {}, onCancel: () => {} })

  check('默认试算 1 份 = 220 kcal（而不是按 100 g 算成 366）', () => {
    const text = overlay.querySelector('.preview-out').textContent
    assert.ok(text.includes('220'), `实际：${text}`)
    assert.ok(!text.includes('366'), `实际：${text}`)
  })

  check('默认选中「份」这个单位', () => {
    assert.equal(overlay.querySelector('.preview-row').querySelector('select').value, 'serving')
  })

  check('每份的克重与称呼已回填', () => {
    const values = overlay.querySelectorAll('input').map((i) => i.value)
    assert.ok(values.includes('60'), `实际：${values.join(',')}`)
    assert.ok(values.includes('1 根'), `实际：${values.join(',')}`)
  })
}

// ── F. 选食物并记录 ─────────────────────────────────────────────────────

group('记录一条：历史优先，食物库其次，手动填写兜底')
{
  const { openFoodPicker } = await import('../app/ui/foodPicker.js')
  const { createFood } = await import('../app/core/food.js')
  const { buildEntryFromFood, buildFreeEntry } = await import('../app/core/log.js')
  const { buildHistoryIndex, resolveHistory } = await import('../app/core/history.js')
  const { fmtKcal } = await import('../app/ui/format.js')

  const egg = createFood({
    name: '鸡蛋（全蛋）', basis: { type: 'per100g' }, state: 'raw',
    energyKcal: 143, proteinG: 13, fatG: 9, carbG: 1,
  })
  const rice = createFood({
    name: '米饭（熟）', basis: { type: 'per100g' }, state: 'cooked',
    energyKcal: 130, proteinG: 2.6, fatG: 0.3, carbG: 28.6,
  })
  const bar = createFood({
    name: '蛋白棒', basis: { type: 'perServing', servingGrams: 60, servingLabel: '1 根' },
    energyKcal: 220, proteinG: 20, fatG: 7, carbG: 22,
  })

  const historyItems = resolveHistory(
    buildHistoryIndex([
      buildFreeEntry({ name: '楼下牛肉面', energyKcal: 650, date: '2026-10-03', time: '12:30' }),
      buildEntryFromFood({ food: egg, amount: 150, unit: 'g', date: '2026-10-03', time: '08:00' }),
    ]),
    [egg, rice, bar],
  )

  function open(handlers = {}) {
    return openFoodPicker({
      historyItems,
      foods: [egg, rice, bar],
      today: '2026-10-03',
      defaultTime: '12:30',
      onRepeat: handlers.onRepeat || (async () => {}),
      onFreeEntry: handlers.onFreeEntry || (() => {}),
    })
  }

  const rowNamed = (overlay, name) =>
    overlay.querySelectorAll('.pick-item').find((i) => i.textContent.includes(name))

  check('历史记录排在食物库前面', () => {
    const overlay = open()
    const text = overlay.textContent
    assert.ok(text.includes('历史记录'), `实际：${text.slice(0, 200)}`)
    assert.ok(text.includes('食物库'))
    assert.ok(text.indexOf('历史记录') < text.indexOf('食物库'))
    overlay.remove()
  })

  check('历史里出现过的食物，不再重复出现在食物库分区', () => {
    const overlay = open()
    // 历史 2 条（牛肉面、鸡蛋）+ 食物库 2 条（米饭、蛋白棒）
    assert.equal(overlay.querySelectorAll('.pick-item').length, 4)
    overlay.remove()
  })

  check('历史条目显示「再记一次会加多少」', () => {
    const overlay = open()
    const beef = rowNamed(overlay, '楼下牛肉面')
    assert.ok(beef.textContent.includes(fmtKcal(650)), `实际：${beef.textContent}`)
    overlay.remove()
  })

  check('食物库条目显示基准量，而不是上次份量', () => {
    const overlay = open()
    assert.ok(rowNamed(overlay, '米饭（熟）').textContent.includes('每 100 g'))
    overlay.remove()
  })

  check('什么都没有时，引导去手动填写而不是说「食物库是空的」', () => {
    const overlay = openFoodPicker({
      historyItems: [], foods: [], today: '2026-10-03', defaultTime: '12:00',
      onRepeat: async () => {}, onFreeEntry: () => {},
    })
    assert.ok(overlay.textContent.includes('还没有任何可调取的东西'))
    assert.ok(overlay.textContent.includes('手动填写一条'))
    overlay.remove()
  })

  check('点历史里的食物 → 份量沿用上次的 150 g，而不是默认 100', () => {
    const overlay = open()
    rowNamed(overlay, '鸡蛋（全蛋）').dispatch('click')
    assert.ok(overlay.textContent.includes('这条会贡献'))
    const values = overlay.querySelectorAll('input').map((i) => i.value)
    assert.ok(values.includes('150'), `实际：${values.join(',')}`)
    overlay.remove()
  })

  let repeated = null
  {
    const overlay = open({ onRepeat: async (payload) => { repeated = payload } })
    rowNamed(overlay, '鸡蛋（全蛋）').dispatch('click')
    overlay.clickByText('记录')
    await tick()
    overlay.remove()
  }

  check('点「记录」把来源、引用、份量、单位、时间一起交出去', () => {
    assert.ok(repeated, 'onRepeat 未被调用')
    assert.equal(repeated.source.name, '鸡蛋（全蛋）')
    assert.equal(repeated.refId, egg.id)
    assert.equal(repeated.amount, 150)
    assert.equal(repeated.unit, 'g')
    assert.equal(repeated.time, '12:30')
  })

  check('点历史里的手填条目 → 打开手填表单并带上原值（而不是问份量）', () => {
    let prefill = 'not-called'
    const overlay = open({ onFreeEntry: (p) => { prefill = p } })
    rowNamed(overlay, '楼下牛肉面').dispatch('click')
    assert.notEqual(prefill, 'not-called', 'onFreeEntry 未被调用')
    assert.equal(prefill.name, '楼下牛肉面')
    assert.equal(prefill.energyKcal, 650)
  })

  check('点「手动填写一条」→ 打开空白手填表单', () => {
    let prefill = 'not-called'
    const overlay = open({ onFreeEntry: (p) => { prefill = p } })
    overlay.clickByText('手动填写一条（外食、临时吃的）')
    assert.equal(prefill, null)
  })
}

group('手动填写：外食不需要先建档案')
{
  const { openFreeEntryForm } = await import('../app/ui/freeEntryForm.js')
  const { buildFreeEntry, validateEntry, entryNutrients } = await import('../app/core/log.js')

  const byPlaceholder = (overlay, placeholder) =>
    overlay.querySelectorAll('input').find((i) => i.getAttribute('placeholder') === placeholder)

  check('空表单点保存被拦住，并说明缺什么', () => {
    let saved = null
    const overlay = openFreeEntryForm({
      defaultDate: '2026-10-03',
      defaultTime: '12:30',
      onSave: async (entry) => { saved = entry },
    })
    overlay.clickByText('保存')
    assert.equal(saved, null)
    const text = overlay.querySelector('.messages').textContent
    assert.ok(text.includes('名称'), `实际：${text}`)
    assert.ok(text.includes('热量'), `实际：${text}`)
    overlay.remove()
  })

  let saved = null
  {
    const overlay = openFreeEntryForm({
      defaultDate: '2026-10-03',
      defaultTime: '12:30',
      onSave: async (entry) => { saved = entry },
    })
    byPlaceholder(overlay, '例如：楼下牛肉面').value = '楼下牛肉面'
    byPlaceholder(overlay, '例如：800').value = '800'
    overlay.clickByText('保存')
    await tick()
    overlay.remove()
  }

  check('只填名称与热量就能保存', () => {
    assert.ok(saved, 'onSave 未被调用')
  })
  check('存下来的是一条不依赖食物库的记录', () => {
    assert.equal(saved.refId, null)
    assert.equal(saved.snapshot.name, '楼下牛肉面')
    assert.equal(saved.snapshot.energyKcal, 800)
  })
  check('归属到指定的日期与时间', () => {
    assert.equal(saved.date, '2026-10-03')
    assert.equal(saved.time, '12:30')
  })
  check('营养素留空，没有被编成 0', () => {
    assert.equal(saved.snapshot.proteinG, null)
    assert.equal(saved.snapshot.fatG, null)
    assert.equal(saved.snapshot.carbG, null)
  })
  check('能通过记录校验', () => {
    assert.equal(validateEntry(saved).errors.length, 0)
  })
  check('能进当天的汇总', () => {
    assert.equal(entryNutrients(saved).energyKcal, 800)
  })

  check('带历史值预填时，字段确实被填上了', () => {
    const overlay = openFreeEntryForm({
      prefill: {
        name: '楼下牛肉面',
        energyKcal: 650,
        basis: { type: 'perServing', servingGrams: null, servingLabel: '1 份' },
      },
      defaultDate: '2026-10-03',
      defaultTime: '12:30',
      onSave: async () => {},
    })
    assert.equal(byPlaceholder(overlay, '例如：楼下牛肉面').value, '楼下牛肉面')
    assert.equal(byPlaceholder(overlay, '例如：800').value, '650')
    overlay.remove()
  })

  check('编辑已有记录时提供删除与「存进食物库」', () => {
    const overlay = openFreeEntryForm({
      entry: buildFreeEntry({ name: '楼下牛肉面', energyKcal: 800, date: '2026-10-03', time: '12:30' }),
      defaultDate: '2026-10-03',
      defaultTime: '12:30',
      onSave: async () => {},
      onDelete: async () => {},
      onSaveToLibrary: () => {},
    })
    const labels = overlay.querySelectorAll('button').map((b) => b.textContent)
    assert.ok(labels.includes('删除'), `实际：${labels.join(',')}`)
    assert.ok(labels.includes('存进食物库'), `实际：${labels.join(',')}`)
    overlay.remove()
  })

  check('新建时不出现删除按钮', () => {
    const overlay = openFreeEntryForm({
      defaultDate: '2026-10-03',
      defaultTime: '12:30',
      onSave: async () => {},
    })
    const labels = overlay.querySelectorAll('button').map((b) => b.textContent)
    assert.ok(!labels.includes('删除'), `实际：${labels.join(',')}`)
    overlay.remove()
  })
}

// ── G. 仓储层的纯函数 ───────────────────────────────────────────────────

group('仓储纯函数：筛选、导出、导入校验')
{
  const { filterFoods, exportToJson, parseImport, EXPORT_FORMAT } = await import(
    '../app/storage/foodRepo.js'
  )
  const { createFood } = await import('../app/core/food.js')

  const foods = [
    createFood({
      name: '鸡蛋（全蛋）',
      basis: { type: 'per100g' },
      state: 'raw',
      energyKcal: 143,
      proteinG: 13,
      fatG: 9,
      carbG: 1,
    }),
    createFood({
      name: '米饭（熟）',
      basis: { type: 'per100g' },
      state: 'cooked',
      energyKcal: 130,
      proteinG: 2.6,
      fatG: 0.3,
      carbG: 28.6,
    }),
    createFood({
      name: '蛋白棒',
      basis: { type: 'perServing', servingGrams: 60, servingLabel: '1 根' },
      energyKcal: 220,
      proteinG: 20,
      fatG: 7,
      carbG: 22,
      source: '包装标签',
    }),
  ]

  check('空查询返回全部', () => assert.equal(filterFoods(foods, '').length, 3))
  check('按名称匹配', () => assert.equal(filterFoods(foods, '鸡蛋').length, 1))
  check('按来源匹配', () => assert.equal(filterFoods(foods, '包装').length, 1))
  check('无匹配返回空数组', () => assert.equal(filterFoods(foods, '不存在的东西').length, 0))

  const json = exportToJson({
    format: EXPORT_FORMAT,
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    counts: { foods: foods.length },
    foods,
  })

  check('导出的 JSON 可被解析回来', () => {
    assert.equal(parseImport(json).foods.length, 3)
  })
  check('往返后数值不丢失', () => {
    const egg = parseImport(json).foods.find((f) => f.name === '鸡蛋（全蛋）')
    assert.equal(egg.energyKcal, 143)
    assert.equal(egg.state, 'raw')
  })
  check('往返后 id 保持不变（合并导入才不会产生重复条目）', () => {
    assert.deepEqual(
      parseImport(json).foods.map((f) => f.id).sort(),
      foods.map((f) => f.id).sort(),
    )
  })
  check('往返后每份克重不丢失', () => {
    const bar = parseImport(json).foods.find((f) => f.name === '蛋白棒')
    assert.equal(bar.basis.servingGrams, 60)
  })
  check('非 JSON 文本被拒绝', () => assert.throws(() => parseImport('这不是 json'), /JSON/))
  check('格式标识不符被拒绝', () =>
    assert.throws(() => parseImport('{"format":"something-else"}'), /格式不匹配/))
  check('缺 foods 数组被拒绝', () =>
    assert.throws(() => parseImport(`{"format":"${EXPORT_FORMAT}"}`), /foods/))
  check('任一条目不合法则整体拒绝（不留半个导入）', () => {
    const bad = { format: EXPORT_FORMAT, foods: [foods[0], { name: '', energyKcal: null }] }
    assert.throws(() => parseImport(JSON.stringify(bad)), /整体取消导入/)
  })
}

// ── 结果 ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(52)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
console.log('注意：本测试使用 DOM 桩，只能证明「不崩、数字对」，不能证明视觉效果。')
process.exit(failed === 0 ? 0 : 1)
