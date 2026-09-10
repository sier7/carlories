/**
 * 应用外壳：状态、数据加载、事件接线。
 *
 * 视图模块（dayView / libraryView）是**纯函数**：拿到 state 和 handlers，
 * 吐出 DOM。它们不碰存储、不改全局状态。这样做的原因是这一层最容易长出
 * 「同一个数字在两处各算一遍」的毛病，而那种 bug 不会报错，只会让总数对不上。
 *
 * 录入有三个来源，优先级依次是：历史记录 → 食物库 → 手动填写。
 * 食物库是**可选的便利**，不是记录的前提 —— 见 core/history.js 的说明。
 */

import { h, mount } from './dom.js'
import { dateKey, addDays, timeKey } from '../core/date.js'
import { createLogEntry, snapshotFromFood, isFreeEntry, entryNutrients } from '../core/log.js'
import { buildHistoryIndex, resolveHistory } from '../core/history.js'
import { buildDailyBalances, dailyNutrients, burnByDate, summarizeRange } from '../core/balance.js'
import { BASIS_PER_SERVING } from '../core/food.js'
import {
  listFoods,
  saveFood,
  deleteFood,
  exportAll,
  exportToJson,
  parseImport,
  importFoods,
} from '../storage/foodRepo.js'
import {
  listEntriesForDate,
  listEntriesInRange,
  listRecentEntries,
  saveEntry,
  deleteEntry,
} from '../storage/logRepo.js'
import { getSettings, saveTargets, saveSyncConfig } from '../storage/settingsRepo.js'
import {
  getDayHealth,
  setDayHealth,
  clearDayHealth,
  importHealthRecords,
  listDayHealthInRange,
  SOURCE_MAILBOX,
} from '../storage/dayRepo.js'
import {
  parseHealthPayload,
  recordForDate,
  describeRecords,
  buildGistApiUrl,
  extractGistContent,
} from '../core/healthSync.js'
import { dayView } from './dayView.js'
import { trendView } from './trendView.js'
import { libraryView } from './libraryView.js'
import { createFoodForm } from './foodForm.js'
import { openFoodPicker } from './foodPicker.js'
import { openFreeEntryForm } from './freeEntryForm.js'
import { openEntrySheet, openTargetsSheet, openBurnSheet, openSyncSheet } from './sheets.js'
import { openOverlay, toast, closeOverlay } from './widgets.js'

const root = document.getElementById('app')

const state = {
  tab: 'day',
  date: dateKey(),
  today: dateKey(),
  loading: true,
  error: null,
  foods: [],
  entries: [],
  health: null,
  targets: null,
  query: '',
  rangeDays: 7,
  summary: null,
  sync: null,
}

init()

async function init() {
  await refresh()
}

async function refresh() {
  state.today = dateKey()
  try {
    const settings = await getSettings()
    state.targets = settings.targets
    state.sync = settings.sync
    state.foods = await listFoods()

    if (state.tab === 'day') {
      state.entries = await listEntriesForDate(state.date)
      state.health = await getDayHealth(state.date)
    }
    if (state.tab === 'trend') {
      await loadRange()
    }
    state.error = null
  } catch (error) {
    state.error = error.message || String(error)
  }
  state.loading = false
  render()
  maybeAutoSync()
}

// ── 自动同步尝试 ────────────────────────────────────────────────────────

let autoSyncAttempted = false

/**
 * 打开应用时自己同步一次。
 *
 * 配了信箱就直接从 Gist 拉 —— 那不需要用户手势，可以安静地完成。
 * 没配信箱才退回读剪贴板，而那一步**很可能失败**（iOS 要求用户手势，
 * 页面加载本身不算），所以是尽力而为：成功就静默导入，失败就什么都不做，
 * 把按钮留给用户。
 */
async function maybeAutoSync() {
  if (autoSyncAttempted) return
  autoSyncAttempted = true

  if (state.tab !== 'day') return

  const importedAt = state.health && state.health.importedAt
  const age = importedAt ? Date.now() - new Date(importedAt).getTime() : Infinity

  if (gistConfigured()) {
    // 走了 ETag，内容没变时 GitHub 返回 304 且不消耗配额，所以可以勤快一点
    if (age < 2 * 60 * 1000) return
    await pullFromGist({ silent: true })
    return
  }

  if (typeof navigator === 'undefined' || !navigator.clipboard) return
  if (age < 30 * 60 * 1000) return
  await syncHealthFromClipboard({ silent: true })
}

function gistConfigured() {
  return Boolean(state.sync && state.sync.gistId)
}

/** 配了信箱就走信箱（不需要用户手势），否则退回剪贴板 */
async function smartSync(options = {}) {
  if (gistConfigured()) return pullFromGist(options)
  return syncHealthFromClipboard(options)
}

/**
 * ETag 缓存。
 *
 * GitHub 对「内容没变」的请求返回 304，而 **304 不计入**每小时 60 次的
 * 匿名配额。所以反复打开应用几乎不消耗配额，也就没必要限流了。
 */
let gistEtag = null

/**
 * 从 Gist 信箱拉取。
 *
 * 读一个公开 Gist **不需要任何凭据** —— 写入用的 token 只存在于快捷指令里，
 * 不进这个应用。这也是选 Gist 而不是普通仓库文件的原因之一。
 */
async function pullFromGist({ silent = false, force = false } = {}) {
  if (!gistConfigured()) {
    if (!silent) toast('还没有配置信箱。点「同步设置」粘贴 Gist 地址。', 'error')
    return { ok: false, reason: 'not-configured' }
  }

  const headers = { accept: 'application/vnd.github+json' }
  if (!force && gistEtag) headers['if-none-match'] = gistEtag

  let response
  try {
    response = await fetch(buildGistApiUrl(state.sync.gistId), { headers, cache: 'no-store' })
  } catch (error) {
    if (!silent) toast(`连不上 GitHub：${error.message}`, 'error')
    return { ok: false, reason: 'network' }
  }

  if (response.status === 304) return { ok: true, unchanged: true }

  if (response.status === 404) {
    if (!silent) toast('找不到这个 Gist。检查地址里那串 ID 对不对。', 'error')
    return { ok: false, reason: 'not-found' }
  }
  if (response.status === 403 || response.status === 429) {
    if (!silent) toast('GitHub 接口限流了。等几分钟再试。', 'error')
    return { ok: false, reason: 'rate-limited' }
  }
  if (!response.ok) {
    if (!silent) toast(`GitHub 返回 ${response.status}`, 'error')
    return { ok: false, reason: 'http', status: response.status }
  }

  const etag = response.headers.get('etag')
  if (etag) gistEtag = etag

  let body = null
  try {
    body = await response.json()
  } catch {
    if (!silent) toast('信箱返回的不是 JSON', 'error')
    return { ok: false, reason: 'bad-body' }
  }

  const content = extractGistContent(body)
  if (!content) {
    if (!silent) {
      toast('信箱里还没有数据 —— 快捷指令还没写进去过。先在快捷指令里手动运行一次。')
    }
    return { ok: false, reason: 'empty' }
  }

  const { records, problems } = parseHealthPayload(content, { today: dateKey() })
  if (records.length === 0) {
    if (!silent) {
      // 把信箱里**实际的内容**报出来。排查这类问题时，这一句比任何猜测都有用 ——
      // 「CAL/TODAY ACT=」这种半成品一眼就能看出来是快捷指令少插了变量。
      toast(
        `信箱里的内容解析不出数据。\n实际内容：「${String(content).slice(0, 80)}」\n`
        + (problems[0] || ''),
        'error',
      )
    }
    return { ok: false, reason: 'unparsable', problems, content }
  }

  try {
    await importHealthRecords(records.map((record) => ({ ...record, source: SOURCE_MAILBOX })))
    await refresh()
  } catch (error) {
    if (!silent) toast(`写入失败：${error.message}`, 'error')
    return { ok: false, reason: 'write-failed' }
  }

  const mine = recordForDate(records, state.date)
  toast(mine ? `已同步 ${describeRecords([mine])}` : `已同步 ${describeRecords(records)}`)
  return { ok: true, count: records.length }
}

/**
 * 加载多日区间。
 *
 * 一次查回整段区间的记录，而不是逐天查 —— 90 天逐天查就是 90 次事务，
 * 而每次切换区间都要重来一遍。
 */
async function loadRange() {
  const to = dateKey()
  const from = addDays(to, -(state.rangeDays - 1))

  const [entries, healthRecords] = await Promise.all([
    listEntriesInRange(from, to),
    listDayHealthInRange(from, to),
  ])

  const days = buildDailyBalances({
    from,
    to,
    totalsByDate: dailyNutrients(entries, entryNutrients),
    burnByDate: burnByDate(healthRecords),
  })
  state.summary = summarizeRange(days)
}

function render() {
  mount(root, h('div', { class: 'app' },
    state.error ? h('p', { class: 'msg error' }, `出错了：${state.error}`) : null,
    state.tab === 'day'
      ? dayView(state, handlers)
      : state.tab === 'trend'
        ? trendView(state, handlers)
        : libraryView(state, handlers),
    tabBar(),
  ))
}

function tabBar() {
  const tabs = [
    { id: 'day', label: '今日', icon: '◉' },
    { id: 'trend', label: '多日', icon: '◫' },
    { id: 'library', label: '食物库', icon: '☰' },
  ]
  return h('nav', { class: 'tabbar' },
    ...tabs.map((tab) =>
      h('button', {
        class: `tab${state.tab === tab.id ? ' active' : ''}`,
        type: 'button',
        onClick: () => handlers.setTab(tab.id),
      },
        h('span', { class: 'tab-icon' }, tab.icon),
        h('span', { class: 'tab-label' }, tab.label),
      ),
    ),
  )
}

// ── 事件接线 ────────────────────────────────────────────────────────────

const handlers = {
  setTab(tab) {
    if (state.tab === tab) return
    state.tab = tab
    if (tab === 'trend') state.summary = null
    refresh()
  },

  setRange(days) {
    if (state.rangeDays === days) return
    state.rangeDays = days
    state.summary = null
    refresh()
  },

  goDay(delta) {
    state.date = addDays(state.date, delta)
    refresh()
  },

  goToday() {
    if (state.date === dateKey()) return
    state.date = dateKey()
    refresh()
  },

  setQuery(value) {
    state.query = value
    render()
    // 整树重绘会丢掉输入焦点，这里恢复回去，否则每敲一个字就断一次
    const input = document.getElementById('library-search')
    if (input && typeof input.focus === 'function') {
      input.focus()
      if (typeof input.setSelectionRange === 'function') {
        try {
          input.setSelectionRange(value.length, value.length)
        } catch {
          /* 某些输入类型不支持，忽略 */
        }
      }
    }
  },

  openPicker: openPickerForDate,
  openEntry: openEntryEditor,
  openTargets: openTargetsEditor,
  openBurn: openBurnEditor,
  openSync: openSyncEditor,
  syncHealth: () => smartSync(),
  newFood: () => openFoodForm(null),
  editFood: (food) => openFoodForm(food),
  exportData,
  importData,
}

// ── 健康数据同步 ────────────────────────────────────────────────────────

/**
 * 从剪贴板读入快捷指令放进去的健康数据。
 *
 * 为什么是剪贴板而不是自动：iOS 上网页应用读不到 HealthKit，这是硬边界
 * （见 docs/M0-健康桥验证.md 的查证过程）。快捷指令是 Apple 官方给健康
 * 数据的出口，它负责取数，这里负责落地。
 *
 * 剪贴板 API 需要 HTTPS 安全上下文，且 iOS 会弹一次粘贴确认 ——
 * 所以这里必须准备好失败路径，而不是假设它总能成功。
 */
async function syncHealthFromClipboard({ silent = false } = {}) {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null
  if (!clipboard || typeof clipboard.readText !== 'function') {
    if (!silent) toast('这台设备不能读剪贴板，请点「消耗」那一行手动填', 'error')
    return { ok: false, reason: 'unsupported' }
  }

  let text = ''
  try {
    text = await clipboard.readText()
  } catch {
    // 自动尝试时这里失败是正常的（没有用户手势）。不打扰用户，
    // 界面上的按钮会兜住。
    if (!silent) {
      toast(
        '读不到剪贴板。可能是粘贴权限被拒，或者页面不在 HTTPS 下。'
        + '也可以点「消耗」那一行手动填。',
        'error',
      )
    }
    return { ok: false, reason: 'denied' }
  }

  const { records, problems } = parseHealthPayload(text, { today: dateKey() })
  if (records.length === 0) {
    if (!silent) {
      toast(
        problems[0] || '剪贴板里没有健康数据。先在「快捷指令」里运行「同步到 Carlories」。',
        'error',
      )
    }
    return { ok: false, reason: 'no-data', problems }
  }

  try {
    await importHealthRecords(records)
    await refresh()
  } catch (error) {
    if (!silent) toast(`写入失败：${error.message}`, 'error')
    return { ok: false, reason: 'write-failed' }
  }

  const mine = recordForDate(records, state.date)
  if (mine) {
    toast(`已同步 ${describeRecords([mine])}`)
  } else {
    toast(`已同步 ${describeRecords(records)}（都不是 ${state.date}，已按各自日期存入）`)
  }
  return { ok: true, records }
}

// ── 记录：三个来源 ──────────────────────────────────────────────────────

async function openPickerForDate() {
  // 历史索引按需构建：它要扫全表，没必要每次切标签都算一遍
  let historyItems = []
  try {
    const recent = await listRecentEntries(1000)
    historyItems = resolveHistory(buildHistoryIndex(recent, { limit: 80 }), state.foods)
  } catch {
    /* 历史只是录入的加速手段，取不到不影响功能 */
  }

  openFoodPicker({
    historyItems,
    foods: state.foods,
    today: dateKey(),
    defaultTime: state.date === dateKey() ? timeKey() : '12:00',

    // 再记一次历史上出现过的东西
    onRepeat: async ({ source, refId, amount, unit, time }) => {
      // source 是条目的**当前**值（食物还在就是食物，食物被删了才是旧快照）
      const snapshot = source.id ? snapshotFromFood(source) : { ...source }
      await saveEntry(createLogEntry({
        date: state.date,
        time: time || timeKey(),
        refId: source.id || refId || null,
        amount,
        unit,
        snapshot,
      }))
      await refresh()
      toast(`已记录 ${snapshot.name}`)
    },

    // 手动填写：外食、临时吃的
    onFreeEntry: (prefill) => openFreeEntry(prefill),
  })
}

function openEntryEditor(entry) {
  // 没有对应食物条目的记录，编辑的是它自己的数值；有对应条目的，编辑的是份量
  if (isFreeEntry(entry)) {
    openFreeEntryForm({
      entry,
      defaultDate: entry.date,
      defaultTime: entry.time,
      onSave: async (updated) => {
        await saveEntry(updated)
        await refresh()
      },
      onDelete: async (id) => {
        await deleteEntry(id)
        await refresh()
        toast('已删除')
      },
      onSaveToLibrary: promoteToLibrary,
    })
    return
  }

  const food = state.foods.find((f) => f.id === entry.refId) || null
  openEntrySheet({
    entry,
    food,
    onSave: async (updated) => {
      await saveEntry(updated)
      await refresh()
    },
    onDelete: async (id) => {
      await deleteEntry(id)
      await refresh()
      toast('已删除')
    },
  })
}

/** 手动填写一条新记录。prefill 非空时是「照着历史里的某一条再填一次」 */
function openFreeEntry(prefill = null) {
  openFreeEntryForm({
    prefill,
    defaultDate: state.date,
    defaultTime: state.date === dateKey() ? timeKey() : '12:00',
    onSave: async (entry) => {
      await saveEntry(entry)
      await refresh()
      toast(`已记录 ${entry.snapshot.name}`)
    },
  })
}

/**
 * 把一条手填记录的数值存进食物库。
 *
 * 这是食物库**自然地长出来**的方式：你吃了几次之后发现某样东西会反复出现，
 * 存一次就好，而不是一开始就要求你把所有吃食都建好档。
 */
function promoteToLibrary(values) {
  openFoodForm(null, {
    name: values.name,
    basis: { type: BASIS_PER_SERVING, servingGrams: null, servingLabel: '1 份' },
    state: 'na',
    energyKcal: values.energyKcal,
    proteinG: values.proteinG,
    fatG: values.fatG,
    carbG: values.carbG,
    fiberG: values.fiberG,
    sodiumMg: values.sodiumMg,
    source: '来自饮食记录',
  })
}

// ── 目标与消耗 ──────────────────────────────────────────────────────────

function openTargetsEditor() {
  openTargetsSheet({
    targets: state.targets,
    onSave: async (next) => {
      await saveTargets(next)
      await refresh()
      toast('目标已保存')
    },
  })
}

function openBurnEditor() {
  openBurnSheet({
    date: state.date,
    health: state.health,
    onSave: async ({ activeKcal, restingKcal }) => {
      await setDayHealth(state.date, { activeKcal, restingKcal })
      await refresh()
    },
    onClear: async () => {
      await clearDayHealth(state.date)
      await refresh()
      toast('已清除')
    },
  })
}

function openSyncEditor() {
  openSyncSheet({
    sync: state.sync,
    health: state.health,
    onSaveConfig: async (config) => {
      await saveSyncConfig(config)
      await refresh()
      if (!config.gistId) {
        toast('自动同步已关闭')
        return
      }
      toast('信箱已配置，正在试拉一次…')
      // 立刻拉一次：让「到底通没通」当场有个结论，而不是等下次打开应用
      await pullFromGist({ force: true })
    },
    onPullGist: (options) => pullFromGist(options || {}),
    onPullClipboard: () => syncHealthFromClipboard({}),
    onClear: async () => {
      await clearDayHealth(state.date)
      await refresh()
      toast('已清除')
    },
  })
}

// ── 食物表单 ────────────────────────────────────────────────────────────

function openFoodForm(food, prefill = null) {
  openOverlay(createFoodForm({
    food,
    prefill,
    onCancel: closeOverlay,
    onDelete: async (id) => {
      await deleteFood(id)
      closeOverlay()
      await refresh()
      toast('已删除。已记录的日子不受影响，因为每条记录都存有自己的快照。')
    },
    onSave: async (draft) => {
      try {
        const { warnings } = await saveFood(draft)
        closeOverlay()
        await refresh()
        toast(warnings.length > 0 ? `已保存 · ${warnings.length} 条提示` : '已保存')
      } catch (error) {
        toast(error.message, 'error')
      }
    },
  }))
}

// ── 导入导出 ────────────────────────────────────────────────────────────

async function exportData() {
  if (state.foods.length === 0) {
    toast('食物库是空的，没有可导出的条目')
    return
  }
  const payload = await exportAll()
  const stamp = dateKey()
  const blob = new Blob([exportToJson(payload)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = h('a', { href: url, download: `carlories-食物表-${stamp}.json` })
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
  toast(`已导出 ${payload.counts.foods} 条`)
}

function importData() {
  const fileInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    class: 'hidden',
  })
  const textarea = h('textarea', {
    class: 'paste-area',
    rows: 6,
    placeholder: '也可以直接把 JSON 内容粘贴到这里',
  })
  const mode = h('select', { class: 'unit-select wide' },
    h('option', { value: 'merge' }, '合并（同 id 覆盖）'),
    h('option', { value: 'replace' }, '替换（先清空现有条目）'),
  )

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0]
    if (!file) return
    textarea.value = await file.text()
    toast(`已读入 ${file.name}，确认后点导入`)
  })

  const overlay = h('div', { class: 'overlay' },
    h('div', { class: 'sheet' },
      h('header', { class: 'sheet-head' },
        h('h2', null, '导入食物表'),
        h('button', {
          class: 'icon-btn', type: 'button', onClick: () => overlay.remove(),
        }, '取消'),
      ),
      h('div', { class: 'sheet-body' },
        h('p', { class: 'hint' },
          '导入前会整体校验，任何一条不合法就整体拒绝 —— 半个导入比不导入更糟，'
          + '因为你无法判断库里现在是什么状态。'),
        h('div', { class: 'field' },
          h('span', { class: 'field-label' }, '选择文件'),
          fileInput,
          h('button', {
            class: 'btn', type: 'button', onClick: () => fileInput.click(),
          }, '从「文件」选取'),
        ),
        h('div', { class: 'field' },
          h('span', { class: 'field-label' }, '或粘贴内容'),
          textarea,
        ),
        h('div', { class: 'field' },
          h('span', { class: 'field-label' }, '导入方式'),
          mode,
        ),
      ),
      h('footer', { class: 'sheet-foot' },
        h('div', { class: 'spacer' }),
        h('button', {
          class: 'btn primary',
          type: 'button',
          onClick: async () => {
            try {
              const parsed = parseImport(textarea.value)
              const result = await importFoods(parsed, { mode: mode.value })
              overlay.remove()
              await refresh()
              toast(`已导入 ${result.imported} 条`)
            } catch (error) {
              toast(error.message, 'error')
            }
          },
        }, '导入'),
      ),
    ),
  )

  document.body.appendChild(overlay)
}
