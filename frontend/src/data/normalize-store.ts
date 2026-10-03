import {
  CHANGE_CATEGORIES,
  CHANGE_KEY,
  CHANGE_STATUSES,
  SUPPLIER_KEY,
  categoryOfScore,
  earliestEffectiveDate,
  formatDate,
  isKnownCategory,
  parseRiskScore,
} from './change-rules'
import type { EntryRow } from './types'

const SOURCE_FIELD = '来源变更'

function text(row: EntryRow, field: string): string {
  return String(row[field] ?? '').trim()
}

// 合规已批准：类别合法且与现行阈值结论一致、生效日期满足提前量、有审批人、有批准日期。
export function isCompliantApproved(row: EntryRow): boolean {
  if (String(row.status) !== '已批准') {
    return false
  }
  if (!isKnownCategory(row.变更类别)) {
    return false
  }
  const score = parseRiskScore(row.风险评估)
  if (score === null || categoryOfScore(score) !== row.变更类别) {
    return false
  }
  if (!text(row, '审批人')) {
    return false
  }
  if (!text(row, '批准日期')) {
    return false
  }
  const earliest = earliestEffectiveDate(text(row, '登记日期'), row.变更类别)
  if (!earliest || !text(row, '生效日期')) {
    return false
  }
  const effective = new Date(`${text(row, '生效日期')}T00:00:00`)
  if (Number.isNaN(effective.getTime()) || effective.getTime() < earliest.getTime()) {
    return false
  }
  return true
}

// 变更记录按现行台账重判：风险评估只认可整数 RPN，类别跟着现行阈值走，旧阈值结论自动纠正。
function normalizeChangeRow(row: EntryRow): EntryRow {
  const next: EntryRow = { ...row }

  // 已拒绝保持终态；其他状态非法时回到待评估。
  const rawStatus = String(next.status ?? '')
  if (rawStatus === '已拒绝') {
    next.status = '已拒绝'
  } else if ((CHANGE_STATUSES as readonly string[]).includes(rawStatus)) {
    next.status = rawStatus
  } else {
    next.status = '待评估'
  }

  const score = parseRiskScore(next.风险评估)
  const scoredCategory = score === null ? null : categoryOfScore(score)

  // 变更类别没按标准填的（空值、占位文本、枚举外极值）统一置空，交给页面重填。
  if (!isKnownCategory(next.变更类别)) {
    next.变更类别 = ''
  } else if (scoredCategory !== null && next.变更类别 !== scoredCategory) {
    // 落库类别与现行阈值不一致：以台账结论为准，页面标注与写库口径从此对齐。
    next.变更类别 = scoredCategory
  }

  const notes: string[] = []
  if (score === null) {
    next.风险评估 = ''
    notes.push('风险评估未按现行口径填写，需重评')
  } else {
    next.风险评估 = score
  }
  if (next.变更类别 === '') {
    notes.push('变更类别待补填')
  }
  if (!text(next, '登记日期')) {
    next.登记日期 = '2026-10-01'
  }
  if (!text(next, '生效日期') || Number.isNaN(new Date(`${text(next, '生效日期')}T00:00:00`).getTime())) {
    next.生效日期 = ''
    notes.push('生效日期待补填')
  }

  // 合规检查：不合规的已批准（类别没填、口径过期、无审批人/批准日期）一律退回评估中，不能再显示为已批准。
  let illegalApproved = false
  if (next.status === '已批准' && !isCompliantApproved(next)) {
    illegalApproved = true
    next.status = '评估中'
    notes.push('原已批准不合规（类别/风险评估/审批/生效日期缺项），已退回重审')
  }

  const status = String(next.status)
  next.pending = status !== '已批准' && status !== '已拒绝'
  next.abnormal = status === '已拒绝' || illegalApproved || notes.length > 0

  next.备注 = notes.join('；')
  return next
}

function todoAuditId(changeNo: string): string {
  return `SUPP-CHG-${changeNo.replace(/^CHAN-/, '')}`
}

function buildSupplierTodo(change: EntryRow, existing: EntryRow | undefined): EntryRow {
  const changeNo = text(change, '变更编号')
  const category = String(change.变更类别)
  const base: EntryRow = existing
    ? { ...existing }
    : {
        id: 0,
        status: '待审计',
        pending: true,
        abnormal: false,
      }
  return {
    ...base,
    审计编号: base.审计编号 && String(base.审计编号).startsWith('SUPP-CHG-') ? base.审计编号 : todoAuditId(changeNo),
    供应商名称: text(change, '涉及供应商'),
    物料类别: '变更触发审计',
    审计方式: '现场审计',
    缺陷项数: 0,
    审计结论: '',
    整改期限: text(change, '生效日期'),
    [SOURCE_FIELD]: changeNo,
    status: base.status === '已通过' || base.status === '需整改' ? base.status : '待审计',
    pending: !(base.status === '已通过' || base.status === '需整改'),
    abnormal: false,
  }
}

// 状态同步到供应商审计的待办：合规批准且涉及供应商的变更，每条对应一条待审计；
// 撤回批准（数据被打回）时同步删掉由该变更生成的待办，保持幂等。
function syncSupplierTodos(changes: EntryRow[], supplierRows: EntryRow[]): EntryRow[] {
  const approvedWithSupplier = new Map<string, EntryRow>()
  for (const change of changes) {
    if (!isCompliantApproved(change)) {
      continue
    }
    if (!text(change, '涉及供应商')) {
      continue
    }
    approvedWithSupplier.set(text(change, '变更编号'), change)
  }

  let next = supplierRows.filter((row) => {
    const source = text(row, SOURCE_FIELD)
    if (!source) {
      return true
    }
    return approvedWithSupplier.has(source)
  })

  for (const [changeNo, change] of approvedWithSupplier) {
    const index = next.findIndex((row) => text(row, SOURCE_FIELD) === changeNo)
    const todo = buildSupplierTodo(change, index >= 0 ? next[index] : undefined)
    if (index >= 0) {
      todo.id = next[index].id
      next[index] = todo
    } else {
      const maxId = next.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
      todo.id = maxId + 1
      next = [...next, todo]
    }
  }
  return next
}

// 全量归一化：落库数据按现行台账重判一遍，读出来的就是页面、详情、导出共用的同一份结论。
export function normalizeStore(data: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const changes = (data[CHANGE_KEY] ?? []).map(normalizeChangeRow)
  const suppliers = syncSupplierTodos(changes, data[SUPPLIER_KEY] ?? [])
  return { ...data, [CHANGE_KEY]: changes, [SUPPLIER_KEY]: suppliers }
}

export function nextChangeNo(changes: EntryRow[]): string {
  let max = 0
  for (const row of changes) {
    const match = /CHAN-(\d+)/.exec(String(row.变更编号 ?? ''))
    if (match) {
      max = Math.max(max, Number(match[1]))
    }
  }
  return `CHAN-${String(max + 1).padStart(4, '0')}`
}

export function defaultEffectiveDate(registerDate: string, category: (typeof CHANGE_CATEGORIES)[number]): string {
  const earliest = earliestEffectiveDate(registerDate, category)
  return earliest ? formatDate(earliest) : ''
}
