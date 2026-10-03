import { listRows, saveRows } from '@/data/local-store'
import {
  CHANGE_KEY,
  CHANGE_STATUSES,
  TRANSITIONS,
  categoryOfScore,
  countApprovedThisMonth,
  formatDate,
  isKnownCategory,
  validateDraft,
  type ChangeCategory,
  type ChangeStatus,
  type DraftInput,
} from '@/data/change-rules'
import { defaultEffectiveDate, nextChangeNo } from '@/data/normalize-store'
import type { ActionResult, EntryRow } from '@/data/types'

export type { DraftInput }

export function getChanges(): EntryRow[] {
  return listRows(CHANGE_KEY)
}

export function getChange(id: number): EntryRow | undefined {
  return getChanges().find((row) => Number(row.id) === id)
}

export function suggestedChangeNo(): string {
  return nextChangeNo(getChanges())
}

export function suggestedEffectiveDate(registerDate: string, category: ChangeCategory): string {
  return defaultEffectiveDate(registerDate, category)
}

export function categoryForRisk(value: unknown): ChangeCategory | null {
  const score = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(score)) {
    return null
  }
  return categoryOfScore(score)
}

export type ChangeStats = {
  pendingCount: number
  reviewingCount: number
  approvedThisMonth: number
}

export function changeStats(now = new Date()): ChangeStats {
  const rows = getChanges()
  return {
    pendingCount: rows.filter((row) => String(row.status) === '待评估').length,
    reviewingCount: rows.filter((row) => String(row.status) === '评估中').length,
    approvedThisMonth: countApprovedThisMonth(rows, now),
  }
}

function persist(rows: EntryRow[]): void {
  // saveRows 内部按现行台账归一化并同步供应商审计待办。
  saveRows(CHANGE_KEY, rows)
}

// 登记新申请：没按标准填的不允许保存（类别须等于风险评估按现行阈值得出的结论）。
export function createChange(input: DraftInput): ActionResult & { id?: number } {
  const result = validateDraft(input)
  if (!result.ok) {
    return result
  }
  const rows = getChanges()
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const row: EntryRow = {
    id,
    status: '待评估',
    pending: true,
    abnormal: false,
    变更编号: String(input.变更编号).trim(),
    变更类别: input.变更类别 as ChangeCategory,
    涉及工序: String(input.涉及工序).trim(),
    涉及供应商: String(input.涉及供应商 ?? '').trim(),
    变更内容: String(input.变更内容).trim(),
    风险评估: Number(input.风险评估),
    审批人: '',
    登记日期: String(input.登记日期),
    生效日期: String(input.生效日期),
    批准日期: '',
    备注: '',
  }
  persist([...rows, row])
  return { ok: true, message: `变更申请 ${row.变更编号} 已登记，当前状态「待评估」`, id }
}

// 同一份变更重复评估只算一次：
//  - 提交评估只允许 待评估 -> 评估中；
//  - 评估中再次提交按「重新评估」处理，覆盖为最新一版风险评估，状态与计数都不变。
export function submitAssessment(
  id: number,
  payload: { risk: number; category: ChangeCategory; effectiveDate: string; supplier?: string },
): ActionResult {
  const rows = getChanges()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的变更申请` }
  }
  const current = rows[index]
  const status = String(current.status) as ChangeStatus

  if (status === '已批准' || status === '已拒绝') {
    return { ok: false, message: `变更申请已终态「${status}」，不能再评估` }
  }

  const derived = categoryOfScore(payload.risk)
  if (derived === null) {
    return { ok: false, message: '风险评估落在极值范围外，已挡回' }
  }
  if (payload.category !== derived) {
    return {
      ok: false,
      message: `变更类别与风险评估不一致：RPN=${payload.risk} 按现行阈值应判为「${derived}」`,
    }
  }
  const check = validateDraft({
    ...current,
    风险评估: payload.risk,
    变更类别: payload.category,
    生效日期: payload.effectiveDate,
    涉及供应商: payload.supplier ?? String(current.涉及供应商 ?? ''),
  })
  if (!check.ok) {
    return check
  }

  const reassess = status === '评估中'
  const updated: EntryRow = {
    ...current,
    status: '评估中',
    pending: true,
    abnormal: false,
    风险评估: payload.risk,
    // 风险评估口径统一成只留最新一版：新结论直接覆盖，不追加历史版本。
    变更类别: derived,
    生效日期: payload.effectiveDate,
    涉及供应商: payload.supplier ?? String(current.涉及供应商 ?? ''),
    备注: reassess ? '已按最新风险评估覆盖，评估只计一次' : '',
  }
  const next = [...rows]
  next[index] = updated
  persist(next)
  return {
    ok: true,
    message: reassess
      ? `变更 ${String(updated.变更编号)} 重复评估已覆盖为最新一版（仍只计一次），状态保持「评估中」`
      : `变更 ${String(updated.变更编号)} 已提交评估，当前状态「评估中」`,
  }
}

function guardTransition(action: string, status: string): ActionResult & { to?: ChangeStatus } {
  const rule = TRANSITIONS[action]
  if (!rule) {
    return { ok: false, message: `没有登记「${action}」这个动作` }
  }
  if ((CHANGE_STATUSES as readonly string[]).includes(status) === false) {
    return { ok: false, message: `当前状态「${status}」不在台账内，禁止流转` }
  }
  if (!rule.from.includes(status as ChangeStatus)) {
    // 状态顺着往下推进，越级的拒收。
    return {
      ok: false,
      message: `越级流转已拒收：「${action}」只能从「${rule.from.join('、')}」发起，当前是「${status}」`,
    }
  }
  return { ok: true, message: '', to: rule.to }
}

// 批准：只允许 评估中 -> 已批准；批准前再按现行台账复核一遍，不达标拒收；
// 批准成功后状态同步成供应商审计待办（由存储层统一 upsert）。
export function approveChange(id: number, approver: string): ActionResult {
  const name = approver.trim()
  if (!name) {
    return { ok: false, message: '批准必须填写审批人' }
  }
  const rows = getChanges()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的变更申请` }
  }
  const current = rows[index]
  const guard = guardTransition('批准变更', String(current.status))
  if (!guard.ok) {
    return guard
  }

  const check = validateDraft({
    ...current,
    审批人: name,
  })
  if (!check.ok) {
    return { ok: false, message: `批准前复核未通过：${check.message}` }
  }

  const updated: EntryRow = {
    ...current,
    status: '已批准',
    pending: false,
    abnormal: false,
    审批人: name,
    批准日期: formatDate(new Date()),
    备注: '',
  }
  const next = [...rows]
  next[index] = updated
  persist(next)
  const supplierText = String(updated.涉及供应商 ?? '').trim()
  return {
    ok: true,
    message:
      `变更 ${String(updated.变更编号)} 已批准（类别「${String(updated.变更类别)}」，生效日期 ${String(updated.生效日期)}）` +
      (supplierText ? `，已同步生成供应商审计待办（${supplierText}）` : ''),
  }
}

// 退回：待评估/评估中 -> 已拒绝。
export function rejectChange(id: number, reason: string): ActionResult {
  const rows = getChanges()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的变更申请` }
  }
  const guard = guardTransition('退回变更', String(rows[index].status))
  if (!guard.ok) {
    return guard
  }
  if (!reason.trim()) {
    return { ok: false, message: '退回变更必须填写退回原因' }
  }
  const updated: EntryRow = {
    ...rows[index],
    status: '已拒绝',
    pending: false,
    abnormal: true,
    备注: `退回原因：${reason.trim()}`,
  }
  const next = [...rows]
  next[index] = updated
  persist(next)
  return { ok: true, message: `变更 ${String(updated.变更编号)} 已退回，当前状态「已拒绝」` }
}

export function knownCategory(value: unknown): value is ChangeCategory {
  return isKnownCategory(value)
}
