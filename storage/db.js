/**
 * IndexedDB 封装。
 *
 * 为什么用 IndexedDB 而不是 localStorage：容量（localStorage 约 5 MB，
 * 且存字符串）、结构化数据、索引、异步不阻塞界面。食物表是这个应用
 * 唯一的长期资产，不能拿一个会被撑爆的容器装它。
 *
 * 这里一次性把全部计划中的 store 都建在 version 1，即使当前只用到 foods。
 * 目的是让后续加入记录、消耗、设置时**不需要**数据库迁移 —— 迁移是
 * 数据丢失的高发区，能免则免。
 */

const DB_NAME = 'carlories'
const DB_VERSION = 1

const STORES = [
  {
    name: 'foods',
    keyPath: 'id',
    indexes: [
      { name: 'byName', keyPath: 'name' },
      { name: 'byUpdatedAt', keyPath: 'updatedAt' },
    ],
  },
  { name: 'dishes', keyPath: 'id', indexes: [{ name: 'byName', keyPath: 'name' }] },
  {
    name: 'logs',
    keyPath: 'id',
    indexes: [
      { name: 'byDate', keyPath: 'date' },
      { name: 'byDateAndTime', keyPath: ['date', 'time'] },
    ],
  },
  { name: 'dayHealth', keyPath: 'date', indexes: [] },
  { name: 'dayPlan', keyPath: 'date', indexes: [] },
  { name: 'settings', keyPath: 'key', indexes: [] },
  { name: 'meta', keyPath: 'key', indexes: [] },
]

export const STORE_NAMES = STORES.map((s) => s.name)

let dbPromise = null

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export function openDb() {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'))
      return
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      const tx = request.transaction
      for (const spec of STORES) {
        let store
        if (!db.objectStoreNames.contains(spec.name)) {
          store = db.createObjectStore(spec.name, { keyPath: spec.keyPath })
        } else {
          store = tx.objectStore(spec.name)
        }
        for (const index of spec.indexes || []) {
          if (!store.indexNames.contains(index.name)) {
            store.createIndex(index.name, index.keyPath)
          }
        }
      }
    }

    request.onsuccess = () => {
      const db = request.result
      // 另一个标签页要求升级时主动让路，避免卡住
      db.onversionchange = () => db.close()
      resolve(db)
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () =>
      reject(new Error('数据库被其他标签页占用，请关闭本应用的其他页面后重试'))
  })

  return dbPromise
}

export async function getAll(storeName) {
  const db = await openDb()
  const tx = db.transaction(storeName, 'readonly')
  return requestToPromise(tx.objectStore(storeName).getAll())
}

export async function get(storeName, key) {
  const db = await openDb()
  const tx = db.transaction(storeName, 'readonly')
  return requestToPromise(tx.objectStore(storeName).get(key))
}

/** 按索引查全部匹配项，例如按日期取当天的记录 */
export async function getAllByIndex(storeName, indexName, value) {
  const db = await openDb()
  const tx = db.transaction(storeName, 'readonly')
  return requestToPromise(tx.objectStore(storeName).index(indexName).getAll(value))
}

/** 按主键区间取（含两端）。dayHealth 的主键就是日期，正好用来取一段日期 */
export async function getAllByKeyRange(storeName, lower, upper) {
  const db = await openDb()
  const tx = db.transaction(storeName, 'readonly')
  return requestToPromise(tx.objectStore(storeName).getAll(IDBKeyRange.bound(lower, upper)))
}

/** 按索引区间取（含两端）。用于一次取回一段日期内的全部记录，而不是逐天查 */
export async function getAllByIndexRange(storeName, indexName, lower, upper) {
  const db = await openDb()
  const tx = db.transaction(storeName, 'readonly')
  return requestToPromise(
    tx.objectStore(storeName).index(indexName).getAll(IDBKeyRange.bound(lower, upper)),
  )
}

export async function put(storeName, value) {
  const db = await openDb()
  const tx = db.transaction(storeName, 'readwrite')
  const result = await requestToPromise(tx.objectStore(storeName).put(value))
  await transactionDone(tx)
  return result
}

export async function putMany(storeName, values) {
  const db = await openDb()
  const tx = db.transaction(storeName, 'readwrite')
  const store = tx.objectStore(storeName)
  for (const value of values) store.put(value)
  await transactionDone(tx)
  return values.length
}

export async function remove(storeName, key) {
  const db = await openDb()
  const tx = db.transaction(storeName, 'readwrite')
  await requestToPromise(tx.objectStore(storeName).delete(key))
  await transactionDone(tx)
}

export async function clear(storeName) {
  const db = await openDb()
  const tx = db.transaction(storeName, 'readwrite')
  await requestToPromise(tx.objectStore(storeName).clear())
  await transactionDone(tx)
}

export async function count(storeName) {
  const db = await openDb()
  const tx = db.transaction(storeName, 'readonly')
  return requestToPromise(tx.objectStore(storeName).count())
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('事务被中止'))
  })
}
