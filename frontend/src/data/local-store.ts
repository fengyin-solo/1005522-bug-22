import { SEED_ROWS } from './seed'
import { normalizeStore } from './normalize-store'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'pharma-cleanroom:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const seed = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return normalizeStore(seed)
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = normalizeStore(seed)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 无论首开还是读旧档，都按现行台账重判一遍再用，页面标注与落库结论保持同一份。
    return normalizeStore({ ...seed, ...parsed })
  } catch {
    const seeded = normalizeStore(clone(SEED_ROWS))
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  // 每次写库都过一遍台账：变更重判 + 供应商待办同步在写库时即完成，不存在「写库是老结论」。
  const next = normalizeStore({ ...allRows(), [key]: rows })
  saveAll(next)
}

export function resetRows(key: string): EntryRow[] {
  const normalized = normalizeStore({ [key]: clone(SEED_ROWS[key] ?? []) })
  const rows = normalized[key]
  // 变更重置会影响供应商待办，整份重存保证两边一致。
  const all = { ...allRows(), [key]: rows }
  saveAll(normalizeStore(all))
  return rows
}

function saveAll(next: Record<string, EntryRow[]>): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function storageKey(): string {
  return STORAGE_KEY
}
