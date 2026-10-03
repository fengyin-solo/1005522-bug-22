<template>
  <section class="page change-detail" data-module="changecontrol">
    <header class="page-head">
      <div>
        <h2>变更申请详情</h2>
        <p class="page-desc">
          <RouterLink class="link" to="/changecontrol">← 返回变更控制列表</RouterLink>
          详情与列表、落库共用同一份台账结论。
        </p>
      </div>
      <div class="page-actions" v-if="row">
        <button v-for="action in actionsFor(row)" :key="action" class="btn" :class="{ primary: action === '批准变更' }" type="button" @click="runAction(action)">
          {{ action }}
        </button>
      </div>
    </header>

    <div v-if="!row" class="empty-state detail-missing">
      没有找到该变更申请，<RouterLink class="link" to="/changecontrol">返回列表</RouterLink>。
    </div>

    <template v-else>
      <article class="detail-card">
        <h3>基本信息</h3>
        <dl class="detail-grid">
          <template v-for="field in fields" :key="field">
            <dt>{{ field }}</dt>
            <dd :class="detailClass(field)">
              <template v-if="field === '风险评估'">{{ riskText }}</template>
              <template v-else-if="field === '变更类别'">
                {{ row[field] || '待补类别（不合规，禁止批准）' }}
              </template>
              <template v-else>{{ row[field] || '—' }}</template>
            </dd>
          </template>
          <dt>当前状态</dt>
          <dd><strong>{{ row.status }}</strong></dd>
        </dl>
        <p v-if="row.备注" class="remark">⚠ {{ row.备注 }}</p>
      </article>

      <article class="detail-card">
        <h3>台账口径（单一规则）</h3>
        <p class="ledger-text">{{ ledgerText }}</p>
        <ul class="check-list">
          <li :class="compliance.categoryOk ? 'pass' : 'fail'">
            变更类别与风险评估现行阈值结论{{ compliance.categoryOk ? '一致' : '不一致' }}
          </li>
          <li :class="compliance.dateOk ? 'pass' : 'fail'">
            生效日期满足该等级提前量{{ compliance.dateOk ? `（最早 ${compliance.earliest ?? '—'}）` : '（未满足/日期未填）' }}
          </li>
          <li :class="compliance.approvedOk ? 'pass' : 'fail'">
            已批准记录台账合规{{ compliance.approvedOk ? '（计入本月批准数）' : '（不计入批准数）' }}
          </li>
        </ul>
      </article>

      <article class="detail-card" v-if="supplierTodo">
        <h3>供应商审计待办同步</h3>
        <p class="ledger-text">
          审计编号 {{ supplierTodo.审计编号 }} · 供应商 {{ supplierTodo.供应商名称 }} · 状态「{{ supplierTodo.status }}」
        </p>
        <RouterLink class="link" to="/supplieraudit">前往供应商审计处理 →</RouterLink>
      </article>
    </template>

    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

    <ChangeDialogs :mode="dialogMode" :target="dialogTarget" @close="closeDialog" @done="onDone" />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import {
  getChange,
} from '@/api/change-service'
import {
  LEDGER_RULE_TEXT,
  SUPPLIER_KEY,
  categoryOfScore,
  earliestEffectiveDate,
  formatDate,
  parseRiskScore,
  type ChangeCategory,
} from '@/data/change-rules'
import { listRows } from '@/data/local-store'
import { isCompliantApproved } from '@/data/normalize-store'
import type { EntryRow } from '@/data/types'
import ChangeDialogs from './ChangeDialogs.vue'

const route = useRoute()
const router = useRouter()

const fields = ['变更编号', '变更类别', '涉及工序', '涉及供应商', '变更内容', '风险评估', '审批人', '登记日期', '生效日期', '批准日期']
const ledgerText = LEDGER_RULE_TEXT

const row = ref<EntryRow | undefined>(undefined)
const errorMessage = ref('')
const dialogMode = ref<null | 'assess' | 'approve' | 'reject'>(null)
const dialogTarget = ref<EntryRow | undefined>(undefined)

function reload() {
  row.value = getChange(Number(route.params.id))
}

onMounted(reload)

const riskText = computed(() => {
  if (!row.value) {
    return ''
  }
  const score = parseRiskScore(row.value.风险评估)
  if (score === null) {
    return '未按现行口径填写，需重评（RPN 1-1000 整数）'
  }
  return `RPN ${score} → ${categoryOfScore(score)}（只保留最新一版评估）`
})

const compliance = computed(() => {
  if (!row.value) {
    return { categoryOk: false, dateOk: false, approvedOk: false, earliest: '' }
  }
  const score = parseRiskScore(row.value.风险评估)
  const categoryOk = score !== null && categoryOfScore(score) === row.value.变更类别
  let dateOk = false
  let earliest = ''
  if (categoryOk && row.value.变更类别) {
    const date = earliestEffectiveDate(String(row.value.登记日期 ?? ''), row.value.变更类别 as ChangeCategory)
    if (date) {
      earliest = formatDate(date)
      const effective = new Date(`${String(row.value.生效日期 ?? '')}T00:00:00`)
      dateOk = !Number.isNaN(effective.getTime()) && effective.getTime() >= date.getTime()
    }
  }
  return { categoryOk, dateOk, approvedOk: isCompliantApproved(row.value), earliest }
})

const supplierTodo = computed(() => {
  if (!row.value) {
    return undefined
  }
  const changeNo = String(row.value.变更编号 ?? '')
  return listRows(SUPPLIER_KEY).find((item) => String(item.来源变更 ?? '') === changeNo)
})

function detailClass(field: string): string {
  if (field === '变更类别' && row.value && !row.value.变更类别) {
    return 'bad'
  }
  return ''
}

function actionsFor(current: EntryRow): string[] {
  switch (String(current.status)) {
    case '待评估':
      return ['提交评估', '退回变更']
    case '评估中':
      return ['重新评估', '批准变更', '退回变更']
    default:
      return []
  }
}

function runAction(action: string) {
  if (!row.value) {
    return
  }
  dialogTarget.value = row.value
  if (action === '提交评估' || action === '重新评估') {
    dialogMode.value = 'assess'
  } else if (action === '批准变更') {
    dialogMode.value = 'approve'
  } else if (action === '退回变更') {
    dialogMode.value = 'reject'
  }
}

function closeDialog() {
  dialogMode.value = null
  dialogTarget.value = undefined
}

function onDone(message: string) {
  closeDialog()
  errorMessage.value = message
  reload()
  // 稍作停留展示结果后回列表，保证「详情再返回」看到的就是最新结论。
  window.setTimeout(() => {
    router.push('/changecontrol')
  }, 1200)
}
</script>

<style scoped>
.detail-missing { padding: 24px; }
.detail-card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 18px;
  margin-bottom: 14px;
}
.detail-card h3 { margin: 0 0 10px; font-size: 15px; }
.detail-grid {
  display: grid;
  grid-template-columns: 120px 1fr 120px 1fr;
  gap: 8px 14px;
  margin: 0;
  font-size: 13px;
}
.detail-grid dt { color: var(--muted); }
.detail-grid dd { margin: 0; }
.detail-grid dd.bad { color: #b42318; font-weight: 600; }
.remark { margin: 10px 0 0; color: #b54708; font-size: 13px; }
.ledger-text { font-size: 13px; color: #1e3a5f; margin: 0 0 8px; }
.check-list { margin: 0; padding-left: 18px; font-size: 13px; }
.check-list .pass { color: #14532d; }
.check-list .fail { color: #b42318; }
</style>
