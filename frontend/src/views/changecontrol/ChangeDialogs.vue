<template>
  <div v-if="mode" class="modal-mask" @click.self="close">
    <div class="modal-card">
      <header class="modal-head">
        <h3>{{ title }}</h3>
        <button class="link" type="button" @click="close">关闭</button>
      </header>

      <!-- 登记变更申请 -->
      <div v-if="mode === 'create'" class="modal-body">
        <label class="form-item">
          <span>变更编号 *</span>
          <input v-model="form.no" />
        </label>
        <label class="form-item">
          <span>涉及工序 *</span>
          <input v-model="form.process" placeholder="如：灌装 / 配液 / 灭菌" />
        </label>
        <label class="form-item">
          <span>涉及供应商（无则留空）</span>
          <input v-model="form.supplier" placeholder="批准后将同步供应商审计待办" />
        </label>
        <label class="form-item form-item-wide">
          <span>变更内容 *</span>
          <textarea v-model="form.content" rows="2" />
        </label>
        <label class="form-item">
          <span>风险评估 RPN *（1-1000 整数）</span>
          <input v-model.number="form.risk" type="number" min="1" max="1000" step="1" />
        </label>
        <label class="form-item">
          <span>变更类别 *</span>
          <select v-model="form.category">
            <option value="" disabled>请按 RPN 现行阈值选择</option>
            <option v-for="item in categories" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
        <label class="form-item">
          <span>登记日期 *</span>
          <input v-model="form.registerDate" type="date" />
        </label>
        <label class="form-item">
          <span>生效日期 *（{{ leadHint }}）</span>
          <input v-model="form.effectiveDate" type="date" />
        </label>
        <p class="ledger-hint">{{ riskHint || ledgerText }}</p>
      </div>

      <!-- 提交/重新评估 -->
      <div v-else-if="mode === 'assess'" class="modal-body">
        <p class="modal-readout">
          变更 {{ target?.变更编号 }} · 当前状态「{{ target?.status }}」
        </p>
        <label class="form-item">
          <span>风险评估 RPN *（只留最新一版，重复评估覆盖且只计一次）</span>
          <input v-model.number="form.risk" type="number" min="1" max="1000" step="1" />
        </label>
        <label class="form-item">
          <span>变更类别 *</span>
          <select v-model="form.category">
            <option value="" disabled>请按 RPN 现行阈值选择</option>
            <option v-for="item in categories" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
        <label class="form-item">
          <span>生效日期 *（{{ leadHint }}）</span>
          <input v-model="form.effectiveDate" type="date" />
        </label>
        <label class="form-item">
          <span>涉及供应商</span>
          <input v-model="form.supplier" />
        </label>
        <p class="ledger-hint">{{ riskHint || ledgerText }}</p>
      </div>

      <!-- 批准 -->
      <div v-else-if="mode === 'approve'" class="modal-body">
        <p class="modal-readout">
          变更 {{ target?.变更编号 }} · 类别「{{ target?.变更类别 }}」· RPN {{ target?.风险评估 }} ·
          生效日期 {{ target?.生效日期 }}
        </p>
        <p class="ledger-hint">批准前将按台账 {{ ledgerVersion }} 复核类别、生效日期提前量，越级或不合规一律拒收。</p>
        <label class="form-item">
          <span>审批人 *</span>
          <input v-model="form.approver" placeholder="批准人签名" />
        </label>
        <p v-if="String(target?.涉及供应商 ?? '').trim()" class="ledger-hint">
          涉及供应商「{{ target?.涉及供应商 }}」，批准后自动同步供应商审计待办。
        </p>
      </div>

      <!-- 退回 -->
      <div v-else-if="mode === 'reject'" class="modal-body">
        <p class="modal-readout">变更 {{ target?.变更编号 }} · 当前状态「{{ target?.status }}」</p>
        <label class="form-item form-item-wide">
          <span>退回原因 *</span>
          <textarea v-model="form.reason" rows="3" />
        </label>
      </div>

      <p v-if="error" class="error-text modal-error">{{ error }}</p>

      <footer class="modal-foot">
        <button class="btn" type="button" @click="close">取消</button>
        <button class="btn primary" type="button" @click="confirm">{{ confirmText }}</button>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'

import {
  approveChange,
  createChange,
  rejectChange,
  submitAssessment,
  suggestedEffectiveDate,
} from '@/api/change-service'
import {
  BUSINESS_TODAY,
  CHANGE_CATEGORIES,
  LEAD_DAYS,
  LEDGER_RULE_TEXT,
  LEDGER_VERSION,
  RISK_MAX,
  RISK_MIN,
  categoryOfScore,
  type ChangeCategory,
} from '@/data/change-rules'
import type { ActionResult, EntryRow } from '@/data/types'

type Mode = 'create' | 'assess' | 'approve' | 'reject'

const props = defineProps<{
  mode: Mode | null
  target?: EntryRow
  suggestedNo?: string
}>()

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'done', message: string): void
}>()

const categories = CHANGE_CATEGORIES
const ledgerText = LEDGER_RULE_TEXT
const ledgerVersion = LEDGER_VERSION

const emptyForm = () => ({
  no: props.suggestedNo ?? '',
  process: '',
  supplier: '',
  content: '',
  risk: null as number | null,
  category: '' as '' | ChangeCategory,
  registerDate: BUSINESS_TODAY,
  effectiveDate: '',
  approver: '',
  reason: '',
})

const form = reactive(emptyForm())
const error = ref('')

watch(
  () => props.mode,
  (mode) => {
    error.value = ''
    Object.assign(form, emptyForm())
    if (!mode) {
      return
    }
    if (mode === 'assess' && props.target) {
      form.risk = Number(props.target.风险评估) || null
      form.category = (props.target.变更类别 as ChangeCategory) ?? ''
      form.effectiveDate = String(props.target.生效日期 ?? '')
      form.supplier = String(props.target.涉及供应商 ?? '')
    }
    if ((mode === 'approve' || mode === 'reject') && props.target) {
      form.supplier = String(props.target.涉及供应商 ?? '')
    }
  },
)

watch(
  () => [form.risk, form.category, form.registerDate],
  () => {
    if (props.mode === 'create' || props.mode === 'assess') {
      const derived = typeof form.risk === 'number' ? categoryOfScore(form.risk) : null
      if (derived && form.category !== derived) {
        form.category = derived
      }
      if (form.category && form.registerDate) {
        form.effectiveDate = suggestedEffectiveDate(form.registerDate, form.category)
      }
    }
  },
)

const title = computed(() => {
  switch (props.mode) {
    case 'create':
      return '登记变更申请'
    case 'assess':
      return props.target && String(props.target.status) === '评估中' ? '重新评估（覆盖最新一版）' : '提交风险评估'
    case 'approve':
      return '批准变更'
    case 'reject':
      return '退回变更'
    default:
      return ''
  }
})

const confirmText = computed(() => {
  switch (props.mode) {
    case 'create':
      return '保存登记'
    case 'assess':
      return '提交评估'
    case 'approve':
      return '确认批准'
    case 'reject':
      return '确认退回'
    default:
      return '确定'
  }
})

const leadHint = computed(() => {
  if (!form.category) {
    return `次要 ≥7 天 / 主要 ≥15 天 / 重大 ≥30 天`
  }
  return `${form.category}至少晚于登记日 ${LEAD_DAYS[form.category]} 天`
})

const riskHint = computed(() => {
  if (form.risk === null || form.risk === undefined || Number.isNaN(form.risk)) {
    return ''
  }
  if (form.risk < RISK_MIN || form.risk > RISK_MAX) {
    return `RPN=${form.risk} 超出极值范围（${RISK_MIN}-${RISK_MAX}），保存将被挡回。`
  }
  const derived = categoryOfScore(form.risk)
  return `RPN=${form.risk} 按现行阈值判为「${derived}」，类别必须与之一致。`
})

function close() {
  emit('close')
}

function confirm() {
  error.value = ''
  let result: ActionResult & { id?: number }
  switch (props.mode) {
    case 'create':
      result = createChange({
        变更编号: form.no,
        变更类别: form.category,
        涉及工序: form.process,
        涉及供应商: form.supplier,
        变更内容: form.content,
        风险评估: form.risk,
        登记日期: form.registerDate,
        生效日期: form.effectiveDate,
      })
      break
    case 'assess':
      if (!props.target) {
        return
      }
      result = submitAssessment(Number(props.target.id), {
        risk: Number(form.risk),
        category: form.category as ChangeCategory,
        effectiveDate: form.effectiveDate,
        supplier: form.supplier,
      })
      break
    case 'approve':
      if (!props.target) {
        return
      }
      result = approveChange(Number(props.target.id), form.approver)
      break
    case 'reject':
      if (!props.target) {
        return
      }
      result = rejectChange(Number(props.target.id), form.reason)
      break
    default:
      return
  }
  if (!result.ok) {
    error.value = result.message
    return
  }
  emit('done', result.message)
}
</script>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal-card {
  width: 720px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 48px);
  overflow: auto;
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.2);
}
.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.modal-head h3 { margin: 0; font-size: 16px; }
.modal-body {
  padding: 16px 18px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 16px;
}
.form-item { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.form-item span { color: var(--muted); font-size: 12px; }
.form-item input,
.form-item select,
.form-item textarea {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 9px;
  font: inherit;
}
.form-item-wide { grid-column: 1 / -1; }
.ledger-hint {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 12px;
  color: var(--muted);
  background: #f1f5fb;
  border-radius: 6px;
  padding: 8px 10px;
}
.modal-readout {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.modal-error { grid-column: 1 / -1; margin: 0; }
.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
}
</style>
