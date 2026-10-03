import {
  deriveCategory,
  isChangeCategory,
  parseRiskScore,
  validateChangeDraft,
} from '@/data/change-rules'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  ChangeControlDetail,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '退回', '停用', '忽略', '下线', '回滚']

// 变更控制相关的三个数据集合：申请本体、风险评估台账、联动的供应商审计待办。
const CHANGE_KEY = 'changecontrol'
const ASSESSMENT_KEY = 'changeassessments'
const SUPPLIER_AUDIT_KEY = 'supplieraudit'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nowLabel(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

// 变更控制：每次读写前按台账里的现行阈值重判，写库结论和页面标注保持一份口径。
// 历史数据里没按标准填却批了的，标成异常在看板上挡出来，不悄悄留在已批准里。
function normalizeChangeRows(): void {
  const meta = moduleMeta(CHANGE_KEY)
  const finals = meta.finalStatuses ?? [meta.statuses[meta.statuses.length - 1]]
  const rows = listRows(CHANGE_KEY)
  let dirty = false
  const next = rows.map((row) => {
    let updated = row
    const patch = (part: Record<string, string | number | boolean>) => {
      updated = { ...updated, ...part }
      dirty = true
    }
    const score = parseRiskScore(updated['风险评估'])
    if (score !== null) {
      const category = deriveCategory(score)
      if (updated['变更类别'] !== category) {
        patch({ 变更类别: category })
      }
    }
    const status = String(updated.status)
    if (updated['变更状态'] !== status) {
      patch({ 变更状态: status })
    }
    const shouldPending = !finals.includes(status)
    if (Boolean(updated.pending) !== shouldPending) {
      patch({ pending: shouldPending })
    }
    if (status === '已批准') {
      const abnormal = score === null || !isChangeCategory(updated['变更类别'])
      if (Boolean(updated.abnormal) !== abnormal) {
        patch({ abnormal })
      }
    }
    return updated
  })
  if (dirty) {
    saveRows(CHANGE_KEY, next)
  }
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  if (key === CHANGE_KEY) {
    normalizeChangeRows()
  }
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 变更控制动作前的业务校验：没按标准填的、口径对不上的，一律挡回不写库。
function beforeChangeAction(action: string, row: EntryRow): ActionResult {
  if (action === '提交评估') {
    if (parseRiskScore(row['风险评估']) === null) {
      return {
        ok: false,
        message: `风险评估没按标准填（要 0–100 的数字评分，当前是「${row['风险评估'] ?? '空'}」），不允许提交评估`,
      }
    }
  }
  if (action === '批准变更') {
    const score = parseRiskScore(row['风险评估'])
    if (score === null || !isChangeCategory(row['变更类别'])) {
      return { ok: false, message: '变更类别还没按现行阈值判定，不能批准变更' }
    }
    if (deriveCategory(score) !== row['变更类别']) {
      return { ok: false, message: '变更类别与风险评估结论不一致，先重新提交评估' }
    }
    if (!String(row['生效日期'] ?? '').trim()) {
      return { ok: false, message: '生效日期未填，不能批准变更' }
    }
  }
  return { ok: true, message: '' }
}

// 风险评估台账：同一份变更只留一条记录，重复评估覆盖成最新一版，只算一次。
function recordChangeAssessment(row: EntryRow): number {
  const changeNo = String(row['变更编号'])
  const items = listRows(ASSESSMENT_KEY)
  const found = items.findIndex((item) => String(item['变更编号']) === changeNo)
  const version = found >= 0 ? Number(items[found]['评估版本']) + 1 : 1
  const record: EntryRow = {
    id: found >= 0 ? items[found].id : nextId(items),
    status: '已评估',
    pending: false,
    abnormal: false,
    变更编号: changeNo,
    风险评分: Number(row['风险评估']),
    变更类别: String(row['变更类别']),
    评估版本: version,
    评估时间: nowLabel(),
  }
  const next = found >= 0 ? items.map((item, index) => (index === found ? record : item)) : [...items, record]
  saveRows(ASSESSMENT_KEY, next)
  return version
}

function supplierAuditNo(changeNo: string): string {
  return `SUPP-${changeNo}`
}

// 变更批准后，同步一条供应商审计待办；再批一次也只更新，不重复建档。
function syncSupplierAuditTodo(change: EntryRow): void {
  const rows = listRows(SUPPLIER_AUDIT_KEY)
  const auditNo = supplierAuditNo(String(change['变更编号']))
  const index = rows.findIndex((row) => String(row['审计编号']) === auditNo)
  const todo: EntryRow = {
    id: index >= 0 ? rows[index].id : nextId(rows),
    status: '待审计',
    pending: true,
    abnormal: false,
    审计编号: auditNo,
    供应商名称: `变更${change['变更编号']}关联供应商`,
    物料类别: String(change['变更类别']),
    审计方式: '变更触发审计',
    缺陷项数: 0,
    审计结论: '待审计',
    整改期限: String(change['生效日期']),
    审计状态: '待审计',
    变更编号: String(change['变更编号']),
  }
  const next = index >= 0 ? rows.map((row, i) => (i === index ? todo : row)) : [...rows, todo]
  saveRows(SUPPLIER_AUDIT_KEY, next)
}

// 变更被退回时，还没动起来的审计待办一并撤掉，两边状态保持一致。
function removeSupplierAuditTodo(change: EntryRow): void {
  const rows = listRows(SUPPLIER_AUDIT_KEY)
  const auditNo = supplierAuditNo(String(change['变更编号']))
  const next = rows.filter(
    (row) => !(String(row['审计编号']) === auditNo && String(row.status) === '待审计'),
  )
  if (next.length !== rows.length) {
    saveRows(SUPPLIER_AUDIT_KEY, next)
  }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  if (key === CHANGE_KEY) {
    normalizeChangeRows()
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  // 变更控制的重复评估：状态不后退，只把风险评估覆盖成最新一版。
  const isReassess = key === CHANGE_KEY && action === '提交评估' && current === target
  if (current === target && !isReassess) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const sources = meta.actionSources?.[action]
  if (sources && !sources.includes(current)) {
    return {
      ok: false,
      message: `${meta.entity}当前是「${current}」，不能越级执行「${action}」，状态要顺着往下推进`,
    }
  }
  if (key === CHANGE_KEY) {
    const check = beforeChangeAction(action, rows[index])
    if (!check.ok) {
      return check
    }
  }
  const finals = meta.finalStatuses ?? [meta.statuses[meta.statuses.length - 1]]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: !finals.includes(target),
    abnormal:
      current === target
        ? Boolean(rows[index].abnormal)
        : NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  if (key === CHANGE_KEY) {
    updated['变更状态'] = target
    const score = parseRiskScore(updated['风险评估'])
    if (score !== null) {
      updated['变更类别'] = deriveCategory(score)
    }
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  if (key === CHANGE_KEY) {
    if (action === '提交评估') {
      const version = recordChangeAssessment(updated)
      if (isReassess) {
        return {
          ok: true,
          message: `${meta.entity}已重新评估，只保留最新一版（第 ${version} 版），变更类别「${updated['变更类别']}」`,
        }
      }
    }
    if (action === '批准变更') {
      syncSupplierAuditTodo(updated)
      return {
        ok: true,
        message: `${meta.entity}已${action}，当前状态「${target}」，供应商审计待办已同步`,
      }
    }
    if (action === '退回变更') {
      removeSupplierAuditTodo(updated)
    }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 登记变更申请：先按台账校验，没按标准填的不允许保存。
export function createChangeEntry(draft: Record<string, string>): ActionResult {
  const rows = listRows(CHANGE_KEY)
  const check = validateChangeDraft(
    draft,
    rows.map((row) => String(row['变更编号'])),
  )
  if (!check.ok) {
    return check
  }
  const score = parseRiskScore(draft['风险评估']) as number
  const category = deriveCategory(score)
  const row: EntryRow = {
    id: nextId(rows),
    status: '待评估',
    pending: true,
    abnormal: false,
    变更编号: draft['变更编号'].trim(),
    变更类别: category,
    涉及工序: draft['涉及工序'].trim(),
    变更内容: draft['变更内容'].trim(),
    风险评估: score,
    审批人: draft['审批人'].trim(),
    生效日期: draft['生效日期'].trim(),
    变更状态: '待评估',
  }
  saveRows(CHANGE_KEY, [...rows, row])
  return { ok: true, message: `变更申请已登记，变更类别按现行阈值判为「${category}」` }
}

export function nextChangeNo(): string {
  const max = listRows(CHANGE_KEY).reduce((acc, row) => {
    const match = /^CHAN-(\d+)$/.exec(String(row['变更编号'] ?? ''))
    return match ? Math.max(acc, Number(match[1])) : acc
  }, 0)
  return `CHAN-${String(max + 1).padStart(4, '0')}`
}

// 变更控制统计：三个指标都按当前明细现算，明细和本月批准数不会两岔。
export function changeControlStats(): { label: string; value: number }[] {
  normalizeChangeRows()
  const meta = moduleMeta(CHANGE_KEY)
  const rows = listRows(CHANGE_KEY)
  const now = new Date()
  const inCurrentMonth = (raw: unknown): boolean => {
    const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(raw ?? ''))
    return match !== null && Number(match[1]) === now.getFullYear() && Number(match[2]) === now.getMonth() + 1
  }
  return meta.metrics.map((label) => {
    if (label === '待评估变更') {
      return { label, value: rows.filter((row) => row.status === '待评估').length }
    }
    if (label === '评估中变更') {
      return { label, value: rows.filter((row) => row.status === '评估中').length }
    }
    if (label === '本月批准数') {
      return {
        label,
        value: rows.filter((row) => row.status === '已批准' && inCurrentMonth(row['生效日期'])).length,
      }
    }
    return { label, value: 0 }
  })
}

// 变更详情：申请、最新一版评估、供应商审计待办从一个口径取数，两处查到的对得上。
export function changeControlDetail(id: number): ChangeControlDetail | null {
  normalizeChangeRows()
  const row = listRows(CHANGE_KEY).find((item) => Number(item.id) === id)
  if (!row) {
    return null
  }
  const changeNo = String(row['变更编号'])
  const assessment =
    listRows(ASSESSMENT_KEY).find((item) => String(item['变更编号']) === changeNo) ?? null
  const supplierTodo =
    listRows(SUPPLIER_AUDIT_KEY).find((item) => String(item['审计编号']) === supplierAuditNo(changeNo)) ??
    null
  return { row, assessment, supplierTodo }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  if (key === CHANGE_KEY) {
    normalizeChangeRows()
  }
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
