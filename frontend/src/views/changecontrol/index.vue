<template>
  <section class="page" data-module="changecontrol">
    <header class="page-head">
      <div>
        <h2>变更控制管理</h2>
        <p class="page-desc">变更类别、风险评估与生效日期以同一份现行台账为准；状态只许顺序推进，越级拒收。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记变更申请</button>
        <button class="btn" type="button" @click="exportRows">导出变更控制清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="ledger-bar">台账 {{ ledgerVersion }}（现行）：RPN&lt;100 次要变更，100-249 主要变更，≥250 重大变更；生效日期 次要≥7天 / 主要≥15天 / 重大≥30天</p>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-abnormal': row.abnormal }">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '变更编号'">
              <RouterLink class="link" :to="`/changecontrol/${row.id}`">{{ row[column] ?? '—' }}</RouterLink>
            </template>
            <template v-else-if="column === '风险评估'">
              {{ formatRisk(row) }}
            </template>
            <template v-else-if="column === '变更类别'">
              <span :class="categoryClass(row)">{{ row[column] || '待补类别' }}</span>
            </template>
            <template v-else>{{ row[column] || '—' }}</template>
          </td>
          <td>
            {{ row.status }}
            <span v-if="row.备注" class="flag" :title="String(row.备注)">⚠</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <RouterLink class="link" :to="`/changecontrol/${row.id}`">详情</RouterLink>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无变更控制数据，可先登记变更申请</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条变更控制记录 · 本月批准数与已批准明细同口径，均为台账合规记录</span>
      <span v-if="flash" class="ok-text">{{ flash }}</span>
      <span v-else-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <ChangeDialogs :mode="dialogMode" :target="dialogTarget" :suggested-no="suggestedNo" @close="closeDialog" @done="onDone" />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries } from '@/api/local-service'
import {
  changeStats,
  getChanges,
  suggestedChangeNo,
} from '@/api/change-service'
import {
  BUSINESS_TODAY,
  LEDGER_VERSION,
  categoryOfScore,
  parseRiskScore,
} from '@/data/change-rules'
import type { EntryRow } from '@/data/types'
import ChangeDialogs from './ChangeDialogs.vue'

const ledgerVersion = LEDGER_VERSION
const columns = ['变更编号', '变更类别', '涉及工序', '涉及供应商', '风险评估', '审批人', '生效日期', '批准日期']
const filterFields = ['变更编号', '变更类别', '涉及工序']
const statuses = ['待评估', '评估中', '已批准', '已拒绝']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})

const dialogMode = ref<null | 'create' | 'assess' | 'approve' | 'reject'>(null)
const dialogTarget = ref<EntryRow | undefined>(undefined)
const suggestedNo = ref('')

const statCards = computed(() => {
  const stats = changeStats(new Date(`${BUSINESS_TODAY}T00:00:00`))
  return [
    { label: '待评估变更', value: stats.pendingCount },
    { label: '评估中变更', value: stats.reviewingCount },
    { label: '本月批准数', value: stats.approvedThisMonth },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 动作按当前状态给出，越级动作根本不渲染；即使被绕过，服务端也会拒收。
function actionsFor(row: EntryRow): string[] {
  switch (String(row.status)) {
    case '待评估':
      return ['提交评估', '退回变更']
    case '评估中':
      return ['重新评估', '批准变更', '退回变更']
    default:
      return []
  }
}

function formatRisk(row: EntryRow): string {
  const score = parseRiskScore(row.风险评估)
  if (score === null) {
    return '待重评'
  }
  return `RPN ${score}（${categoryOfScore(score)}）`
}

function categoryClass(row: EntryRow): string {
  if (!row.变更类别) {
    return 'cat-missing'
  }
  const score = parseRiskScore(row.风险评估)
  if (score === null || categoryOfScore(score) !== row.变更类别) {
    return 'cat-mismatch'
  }
  return 'cat-ok'
}

function reload() {
  errorMessage.value = ''
  const all = getChanges()
  const pairs = Object.entries(filters.value).filter(([, value]) => value.trim() !== '')
  rows.value = pairs.length
    ? all.filter((row) => pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())))
    : all
  total.value = rows.value.length
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries('changecontrol')
}

function openCreate() {
  suggestedNo.value = suggestedChangeNo()
  dialogTarget.value = undefined
  dialogMode.value = 'create'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  dialogTarget.value = row
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
  errorMessage.value = ''
  reload()
  // 成功提示暂挂在页脚旁的轻提示区：用 errorMessage 的成功样式承接。
  flashMessage(message)
}

const flash = ref('')
function flashMessage(message: string) {
  flash.value = message
  window.setTimeout(() => {
    flash.value = ''
  }, 4000)
}

onMounted(reload)
</script>

<style scoped>
.ledger-bar {
  margin: 0 0 10px;
  padding: 8px 12px;
  font-size: 12px;
  color: #1e3a5f;
  background: #eaf2ff;
  border: 1px solid #c7ddff;
  border-radius: 6px;
}
.row-abnormal { background: #fff7ed; }
.cat-ok { color: #14532d; font-weight: 600; }
.cat-missing { color: #b42318; font-weight: 600; }
.cat-mismatch { color: #b54708; font-weight: 600; }
.flag { margin-left: 4px; cursor: help; }
.ok-text { color: #14532d; }
</style>
