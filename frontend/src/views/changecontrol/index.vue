<template>
  <section class="page" data-module="changecontrol">
    <header class="page-head">
      <div>
        <h2>变更控制管理</h2>
        <p class="page-desc">维护变更申请，围绕变更编号、变更类别、涉及工序、变更内容做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记变更申请</button>
        <button class="btn" type="button" @click="exportRows">导出变更控制清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

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
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无变更控制数据，可先登记变更申请</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条变更控制记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="showCreate" class="modal-mask" @click.self="closeCreate">
      <div class="modal">
        <h3>登记变更申请</h3>
        <form @submit.prevent="submitCreate">
          <label v-for="field in createFields" :key="field.key" class="form-item">
            <span>{{ field.label }}</span>
            <input
              v-model="draft[field.key]"
              :type="field.type"
              :placeholder="field.placeholder"
            />
          </label>
          <p class="form-hint">变更类别按台账现行阈值自动判定：{{ derivedCategoryPreview }}</p>
          <p v-if="createError" class="error-text">{{ createError }}</p>
          <div class="modal-actions">
            <button class="btn primary" type="submit">保存</button>
            <button class="btn ghost" type="button" @click="closeCreate">取消</button>
          </div>
        </form>
      </div>
    </div>

    <div v-if="detail" class="modal-mask" @click.self="closeDetail">
      <div class="modal">
        <h3>变更详情 · {{ detail.row['变更编号'] }}</h3>
        <table class="data-table">
          <tbody>
            <tr v-for="column in columns" :key="column">
              <th>{{ column }}</th>
              <td>{{ detail.row[column] ?? '—' }}</td>
            </tr>
            <tr>
              <th>当前状态</th>
              <td>{{ detail.row.status }}</td>
            </tr>
          </tbody>
        </table>
        <h4>风险评估（同一份变更只留最新一版）</h4>
        <p v-if="detail.assessment" class="detail-line">
          第 {{ detail.assessment['评估版本'] }} 版 · 风险评分 {{ detail.assessment['风险评分'] }} ·
          判定类别 {{ detail.assessment['变更类别'] }} · {{ detail.assessment['评估时间'] }}
        </p>
        <p v-else class="detail-line">尚未提交评估。</p>
        <p class="form-hint">{{ thresholdText }}</p>
        <h4>供应商审计待办</h4>
        <p v-if="detail.supplierTodo" class="detail-line">
          {{ detail.supplierTodo['审计编号'] }} · 当前状态 {{ detail.supplierTodo.status }}
        </p>
        <p v-else class="detail-line">无（变更批准后自动同步）。</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeDetail">返回列表</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  changeControlDetail,
  changeControlStats,
  createChangeEntry,
  downloadEntries,
  listEntries,
  moduleMeta,
  nextChangeNo,
  runAction as applyAction,
} from '@/api/local-service'
import { deriveCategory, parseRiskScore, thresholdSummary } from '@/data/change-rules'
import type { ChangeControlDetail, EntryRow } from '@/data/types'

const meta = moduleMeta('changecontrol')
const columns = ["变更编号", "变更类别", "涉及工序", "变更内容", "风险评估", "审批人", "生效日期", "变更状态"]
const actions = ["提交评估", "批准变更", "退回变更"]
const statuses = ["待评估", "评估中", "已批准", "已拒绝"]

const rows = ref<EntryRow[]>([])
const stats = ref<{ label: string; value: number }[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const detail = ref<ChangeControlDetail | null>(null)
const showCreate = ref(false)
const draft = ref<Record<string, string>>({})
const createError = ref('')
const thresholdText = thresholdSummary()

const createFields = [
  { key: '变更编号', label: '变更编号', placeholder: 'CHAN-0004', type: 'text' },
  { key: '涉及工序', label: '涉及工序', placeholder: '如：配液工序', type: 'text' },
  { key: '变更内容', label: '变更内容', placeholder: '变更涉及的具体内容', type: 'text' },
  { key: '风险评估', label: '风险评估（0–100 评分）', placeholder: '0–100 的数字评分', type: 'number' },
  { key: '审批人', label: '审批人', placeholder: '审批人姓名', type: 'text' },
  { key: '生效日期', label: '生效日期', placeholder: 'YYYY-MM-DD', type: 'date' },
]

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const derivedCategoryPreview = computed(() => {
  const score = parseRiskScore(draft.value['风险评估'])
  return score === null ? '待填 0–100 的风险评分' : deriveCategory(score)
})

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  draft.value = {
    变更编号: nextChangeNo(),
    涉及工序: '',
    变更内容: '',
    风险评估: '',
    审批人: '',
    生效日期: '',
  }
  createError.value = ''
  showCreate.value = true
}

function closeCreate() {
  showCreate.value = false
}

function submitCreate() {
  const result = createChangeEntry(draft.value)
  if (!result.ok) {
    createError.value = result.message
    return
  }
  showCreate.value = false
  noticeMessage.value = result.message
  errorMessage.value = ''
  reload()
}

function openDetail(row: EntryRow) {
  detail.value = changeControlDetail(Number(row.id))
}

function closeDetail() {
  detail.value = null
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats.value = changeControlStats()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '变更控制列表读取失败'
  }
}

onMounted(reload)
</script>
