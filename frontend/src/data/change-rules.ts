// 变更控制台账：变更类别档位、风险阈值、状态流转只在这一份里定义。
// 列表、详情、导出、落库都从这儿取口径，谁也不再单写一份，避免两处查到的对不上。

// 变更类别只有这三档，除此之外的写法都算没按标准填。
export const CHANGE_CATEGORIES = ['微小变更', '一般变更', '重大变更'] as const
export type ChangeCategory = (typeof CHANGE_CATEGORIES)[number]

// 现行风险阈值：风险评估填 0–100 的评分，落到哪个区间就判哪档类别。
export const RISK_SCORE_MIN = 0
export const RISK_SCORE_MAX = 100
export const RISK_THRESHOLDS: { max: number; category: ChangeCategory }[] = [
  { max: 33, category: '微小变更' },
  { max: 66, category: '一般变更' },
  { max: 100, category: '重大变更' },
]

// 状态顺着往下推进：待评估 → 评估中 → 已批准 / 已拒绝，越级的一律拒收。
export const CHANGE_ACTION_SOURCES: Record<string, string[]> = {
  提交评估: ['待评估', '评估中'], // 评估中再交算重复评估，只留最新一版
  批准变更: ['评估中'],
  退回变更: ['待评估', '评估中'],
}
export const CHANGE_FINAL_STATUSES = ['已批准', '已拒绝']

// 登记变更申请时必填的字段，没按标准填的不允许保存。
export const CHANGE_REQUIRED_FIELDS = [
  '变更编号',
  '涉及工序',
  '变更内容',
  '风险评估',
  '审批人',
  '生效日期',
]

export const CHANGE_NO_PATTERN = /^CHAN-\d{4}$/
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

// 风险评估只认 0–100 的数字评分，缺项、非数字、极值都返回 null（挡回）。
export function parseRiskScore(raw: unknown): number | null {
  const text = String(raw ?? '').trim()
  if (text === '') {
    return null
  }
  const value = Number(text)
  if (!Number.isFinite(value) || value < RISK_SCORE_MIN || value > RISK_SCORE_MAX) {
    return null
  }
  return value
}

// 按现行阈值判定变更类别，页面标注和落库都用这一个函数。
export function deriveCategory(score: number): ChangeCategory {
  for (const rule of RISK_THRESHOLDS) {
    if (score <= rule.max) {
      return rule.category
    }
  }
  return '重大变更'
}

export function isChangeCategory(value: unknown): value is ChangeCategory {
  return (CHANGE_CATEGORIES as readonly string[]).includes(String(value))
}

export function thresholdSummary(): string {
  let from = RISK_SCORE_MIN
  const parts = RISK_THRESHOLDS.map((rule) => {
    const part = `${from}–${rule.max} 判${rule.category}`
    from = rule.max + 1
    return part
  })
  return `现行阈值：${parts.join('，')}`
}

// 保存前校验：没按标准填的不允许保存。
export function validateChangeDraft(
  draft: Record<string, string>,
  existingNos: string[],
): { ok: boolean; message: string } {
  for (const field of CHANGE_REQUIRED_FIELDS) {
    if (!String(draft[field] ?? '').trim()) {
      return { ok: false, message: `${field}没按标准填，不允许保存` }
    }
  }
  const changeNo = String(draft['变更编号']).trim()
  if (!CHANGE_NO_PATTERN.test(changeNo)) {
    return { ok: false, message: '变更编号要按 CHAN-0000 的格式填，不允许保存' }
  }
  if (existingNos.includes(changeNo)) {
    return { ok: false, message: `变更编号 ${changeNo} 已登记过，不允许重复保存` }
  }
  if (parseRiskScore(draft['风险评估']) === null) {
    return {
      ok: false,
      message: `风险评估要填 ${RISK_SCORE_MIN}–${RISK_SCORE_MAX} 的数字评分，缺项或极值一律挡回`,
    }
  }
  if (!DATE_PATTERN.test(String(draft['生效日期']).trim())) {
    return { ok: false, message: '生效日期要按 YYYY-MM-DD 填，不允许保存' }
  }
  return { ok: true, message: '' }
}
