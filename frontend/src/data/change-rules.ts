import type { EntryRow } from './types'

// 变更控制规则台账（单一事实来源）
// 风险评估口径、变更类别、生效日期、状态顺序全部以本台账为准，页面、落库、导出不允许各写一份。
//
// 台账版本：V2026.1（现行阈值）
// 业务当前日期（演示口径，本月批准数与登记默认日期都以它为准，避免本机时钟导致统计错位）
export const BUSINESS_TODAY = '2026-10-03'
// 旧阈值（已废止，仅留档用于核对历史数据重判差异）：
//   RPN < 150 次要 / 150-399 主要 / >= 400 重大
// 现行阈值：RPN < 100 次要 / 100-249 主要 / >= 250 重大
export const LEDGER_VERSION = 'V2026.1'

export const CHANGE_KEY = 'changecontrol'
export const SUPPLIER_KEY = 'supplieraudit'

// 风险评估 RPN 取值范围：严重度×发生度×可探测度，最小 1（1×1×1），最大 1000（10×10×10）
export const RISK_MIN = 1
export const RISK_MAX = 1000

// 现行阈值分档
export type ChangeCategory = '次要变更' | '主要变更' | '重大变更'

export const CHANGE_CATEGORIES: ChangeCategory[] = ['次要变更', '主要变更', '重大变更']

type RiskBand = { category: ChangeCategory; min: number; max: number }

export const RISK_BANDS: RiskBand[] = [
  { category: '次要变更', min: 1, max: 99 },
  { category: '主要变更', min: 100, max: 249 },
  { category: '重大变更', min: 250, max: 1000 },
]

// 各等级变更生效日期最早可提前的天数（生效日期不得早于登记日 + 提前量）
export const LEAD_DAYS: Record<ChangeCategory, number> = {
  次要变更: 7,
  主要变更: 15,
  重大变更: 30,
}

// 状态机：只允许顺着往下推进，禁止越级；终态（已批准/已拒绝）不可再操作。
export const CHANGE_STATUSES = ['待评估', '评估中', '已批准', '已拒绝'] as const
export type ChangeStatus = (typeof CHANGE_STATUSES)[number]

// 每条动作只允许从指定源状态发起
export const TRANSITIONS: Record<string, { from: ChangeStatus[]; to: ChangeStatus; label: string }> = {
  提交评估: { from: ['待评估'], to: '评估中', label: '提交评估' },
  重新评估: { from: ['评估中'], to: '评估中', label: '重新评估' },
  批准变更: { from: ['评估中'], to: '已批准', label: '批准变更' },
  退回变更: { from: ['待评估', '评估中'], to: '已拒绝', label: '退回变更' },
}

// 台账口径文字（页面展示与保存校验共用）
export const LEDGER_RULE_TEXT =
  `台账 ${LEDGER_VERSION}｜现行阈值：RPN<100 次要变更，100-249 主要变更，≥250 重大变更（取值 ${RISK_MIN}-${RISK_MAX}）；` +
  `生效日期至少晚于登记日：次要 7 天 / 主要 15 天 / 重大 30 天。`

export function parseRiskScore(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? value : null
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (!/^\d+$/.test(text)) {
      return null
    }
    const score = Number(text)
    return Number.isInteger(score) ? score : null
  }
  return null
}

// 风险评估口径统一入口：按现行阈值给出类别，超范围（极值）一律不给类别。
export function categoryOfScore(score: number): ChangeCategory | null {
  if (!Number.isInteger(score) || score < RISK_MIN || score > RISK_MAX) {
    return null
  }
  return RISK_BANDS.find((band) => score >= band.min && score <= band.max)?.category ?? null
}

// 变更类别给出极值（不在枚举内）时挡回。
export function isKnownCategory(value: unknown): value is ChangeCategory {
  return typeof value === 'string' && (CHANGE_CATEGORIES as string[]).includes(value)
}

export function earliestEffectiveDate(registerDate: string, category: ChangeCategory): Date | null {
  const base = new Date(`${registerDate}T00:00:00`)
  if (Number.isNaN(base.getTime())) {
    return null
  }
  const earliest = new Date(base)
  earliest.setDate(earliest.getDate() + LEAD_DAYS[category])
  return earliest
}

function dayStart(value: string): Date | null {
  const date = new Date(`${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? null : date
}

export type DraftInput = {
  变更编号?: unknown
  变更类别?: unknown
  涉及工序?: unknown
  涉及供应商?: unknown
  变更内容?: unknown
  风险评估?: unknown
  审批人?: unknown
  登记日期?: unknown
  生效日期?: unknown
}

export type ValidationResult = { ok: true } | { ok: false; message: string }

// 保存前校验：没按标准填的不允许保存；类别必须与风险评估现行阈值结论一致；生效日期满足提前量。
export function validateDraft(input: DraftInput): ValidationResult {
  if (!String(input.变更编号 ?? '').trim()) {
    return { ok: false, message: '变更编号必填' }
  }
  if (!isKnownCategory(input.变更类别)) {
    return { ok: false, message: `变更类别必须是台账内取值：${CHANGE_CATEGORIES.join('、')}，给出极值或留空一律挡回` }
  }
  if (!String(input.涉及工序 ?? '').trim()) {
    return { ok: false, message: '涉及工序必填' }
  }
  if (!String(input.变更内容 ?? '').trim()) {
    return { ok: false, message: '变更内容必填' }
  }

  const score = parseRiskScore(input.风险评估)
  if (score === null) {
    return { ok: false, message: `风险评估必须填 ${RISK_MIN}-${RISK_MAX} 的整数 RPN 值，旧版文字结论不再有效` }
  }
  const expected = categoryOfScore(score)
  if (expected === null) {
    return { ok: false, message: `风险评估 RPN=${score} 超出极值范围（${RISK_MIN}-${RISK_MAX}），挡回` }
  }
  if (input.变更类别 !== expected) {
    return {
      ok: false,
      message: `变更类别与风险评估不一致：RPN=${score} 按现行阈值应判为「${expected}」，不能按「${String(input.变更类别)}」保存`,
    }
  }

  const registerText = String(input.登记日期 ?? '').trim()
  const registerDate = dayStart(registerText)
  if (!registerDate) {
    return { ok: false, message: '登记日期必须是合法日期（YYYY-MM-DD）' }
  }
  const effectiveText = String(input.生效日期 ?? '').trim()
  const effectiveDate = dayStart(effectiveText)
  if (!effectiveDate) {
    return { ok: false, message: '生效日期必须是合法日期（YYYY-MM-DD）' }
  }
  const earliest = earliestEffectiveDate(registerText, input.变更类别)
  if (earliest && effectiveDate.getTime() < earliest.getTime()) {
    return {
      ok: false,
      message: `生效日期 ${effectiveText} 早于「${input.变更类别}」允许的最早生效日 ${formatDate(earliest)}（登记日 +${LEAD_DAYS[input.变更类别]} 天），不允许保存`,
    }
  }

  return { ok: true }
}

export function formatDate(date: Date): string {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export function isThisMonth(value: unknown, now = new Date()): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) {
    return false
  }
  const date = new Date(`${value.slice(0, 10)}T00:00:00`)
  if (Number.isNaN(date.getTime())) {
    return false
  }
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()
}

// 仅统计台账口径下合规的已批准记录；类别没填/不合规的申请不算已批准。
export function countApprovedThisMonth(rows: EntryRow[], now = new Date()): number {
  return rows.filter((row) => {
    if (String(row.status) !== '已批准') {
      return false
    }
    if (!isKnownCategory(row.变更类别) || parseRiskScore(row.风险评估) === null) {
      return false
    }
    if (categoryOfScore(parseRiskScore(row.风险评估) as number) !== row.变更类别) {
      return false
    }
    return isThisMonth(row.批准日期, now)
  }).length
}
