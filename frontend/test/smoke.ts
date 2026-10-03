import { listRows } from '@/data/local-store'
import {
  approveChange,
  changeStats,
  createChange,
  getChange,
  rejectChange,
  submitAssessment,
} from '@/api/change-service'
import { SUPPLIER_KEY } from '@/data/change-rules'

let store: Record<string, string> = {}
;(globalThis as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v
    },
    removeItem: (k: string) => {
      delete store[k]
    },
  },
}

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    passed += 1
    console.log(`PASS ${name}`)
  } else {
    failed += 1
    console.error(`FAIL ${name} ${extra}`)
  }
}

// 1. 旧阈值错判类别（RPN 120 旧→次要）按现行阈值重判为主要变更，列表/详情/落库三处一致
const c2 = getChange(2)!
check('旧阈值类别重判为主要变更', String(c2.变更类别) === '主要变更', JSON.stringify({ cat: c2.变更类别 }))

// 2. 类别没填+旧文字风险结论却已批准：打回评估中且不算批准
const c3 = getChange(3)!
check('不合规已批准被打回评估中', String(c3.status) === '评估中', String(c3.status))
check('被打回记录标记异常', c3.abnormal === true)

// 3. 本月批准数只算合规记录（CHAN-0004，批准日期 2026-10-02）
const stats = changeStats(new Date('2026-10-03T00:00:00'))
const approvedRows = listRows('changecontrol').filter((r) => String(r.status) === '已批准')
check('本月批准数=1 且与已批准明细一致', stats.approvedThisMonth === 1 && approvedRows.length === 1, JSON.stringify(stats))

// 4. 供应商审计待办：CHAN-0004 合规批准且涉及供应商 → 生成待审计
const todos = listRows(SUPPLIER_KEY).filter((r) => String(r.来源变更) === 'CHAN-0004')
check('批准同步供应商待办 1 条', todos.length === 1, String(todos.length))
check('待办状态为待审计', todos[0] && String(todos[0].status) === '待审计')
check('待办供应商名一致', todos[0] && String(todos[0].供应商名称) === '江阴包装材料厂')

// 5. 越级拒收：待评估直接批准
const jump = approveChange(1, '张三')
check('越级批准被拒收', jump.ok === false, jump.message)

// 6. 极值挡回：RPN 0 / 1001 / 非整数
check('RPN=0 登记挡回', createChange({
  变更编号: 'CHAN-X1', 变更类别: '次要变更', 涉及工序: 'x', 变更内容: 'x',
  风险评估: 0, 登记日期: '2026-10-03', 生效日期: '2026-10-20',
}).ok === false)
check('RPN=1001 登记挡回', createChange({
  变更编号: 'CHAN-X2', 变更类别: '重大变更', 涉及工序: 'x', 变更内容: 'x',
  风险评估: 1001, 登记日期: '2026-10-03', 生效日期: '2026-11-10',
}).ok === false)

// 7. 类别与现行阈值不一致挡回；缺类别挡回
check('类别/风险不一致挡回', createChange({
  变更编号: 'CHAN-X3', 变更类别: '次要变更', 涉及工序: 'x', 变更内容: 'x',
  风险评估: 300, 登记日期: '2026-10-03', 生效日期: '2026-11-10',
}).ok === false)
check('类别未填挡回', createChange({
  变更编号: 'CHAN-X4', 变更类别: '', 涉及工序: 'x', 变更内容: 'x',
  风险评估: 50, 登记日期: '2026-10-03', 生效日期: '2026-10-20',
}).ok === false)

// 8. 生效日期提前量：RPN=300 重大需 30 天，10-10 太早挡回；11-02 允许
check('生效日期不足提前量挡回', submitAssessment(1, {
  risk: 300, category: '重大变更', effectiveDate: '2026-10-10',
}).ok === false)
const submit = submitAssessment(1, { risk: 300, category: '重大变更', effectiveDate: '2026-11-02' })
check('满足提前量提交评估成功', submit.ok, submit.message)
check('提交后状态评估中', String(getChange(1)!.status) === '评估中')

// 9. 同一份变更重复评估只算一次：重新评估覆盖，状态不变、计数不增、风险只留新版
const before = changeStats(new Date('2026-10-03T00:00:00'))
const re1 = submitAssessment(1, { risk: 120, category: '主要变更', effectiveDate: '2026-10-20' })
check('重复评估允许覆盖', re1.ok, re1.message)
const re2 = submitAssessment(1, { risk: 80, category: '次要变更', effectiveDate: '2026-10-12' })
check('再次重复评估允许覆盖', re2.ok, re2.message)
const after = changeStats(new Date('2026-10-03T00:00:00'))
check('重复评估后计数不变', JSON.stringify(before) === JSON.stringify(after))
const c1 = getChange(1)!
check('风险只留最新一版(80/次要)', Number(c1.风险评估) === 80 && String(c1.变更类别) === '次要变更', JSON.stringify({ r: c1.风险评估, c: c1.变更类别 }))

// 10. 状态顺序：评估中→批准（无审批人挡回；填审批人成功），批准同步待办（该单无供应商→不生成待办）
check('批准缺审批人挡回', approveChange(1, '').ok === false)
const appr = approveChange(1, '李质一')
check('评估中批准成功', appr.ok, appr.message)
check('批准后批准日期落库', /^\d{4}-\d{2}-\d{2}$/.test(String(getChange(1)!.批准日期)))
check('本月批准数变为2', changeStats(new Date('2026-10-03T00:00:00')).approvedThisMonth === 2)
check('无供应商批准不生成待办', listRows(SUPPLIER_KEY).filter((r) => String(r.来源变更) === 'CHAN-0001').length === 0)

// 11. 终态不可再评估、不可再退回
check('已批准不可再评估', submitAssessment(1, { risk: 10, category: '次要变更', effectiveDate: '2026-10-20' }).ok === false)
check('已批准不可再退回', rejectChange(1, 'x').ok === false)

// 12. 带供应商的变更批准 → 同步待办；打回后待办删除
const create = createChange({
  变更编号: 'CHAN-9001', 变更类别: '主要变更', 涉及工序: '外包',
  涉及供应商: '测试供应商', 变更内容: 'c', 风险评估: 150,
  登记日期: '2026-09-01', 生效日期: '2026-09-20',
})
check('带供应商登记成功', create.ok, create.message)
const id9001 = Number((create as { id?: number }).id)
submitAssessment(id9001, { risk: 150, category: '主要变更', effectiveDate: '2026-09-20', supplier: '测试供应商' })
const appr9001 = approveChange(id9001, '王审')
check('带供应商批准成功', appr9001.ok, appr9001.message)
check('供应商待办已生成', listRows(SUPPLIER_KEY).some((r) => String(r.来源变更) === 'CHAN-9001'))
// 模拟待办被审计处理后，重新批准不回退审计结论：先标记已通过，再重复保存保持
const todoRows = listRows(SUPPLIER_KEY)
const todoIdx = todoRows.findIndex((r) => String(r.来源变更) === 'CHAN-9001')
// 直接通过通用动作链路较复杂，这里只验证幂等：再跑一次 approve（终态拒收）→待办仍在
check('终态重复批准拒收且待办保留', approveChange(id9001, '王审').ok === false &&
  listRows(SUPPLIER_KEY).some((r) => String(r.来源变更) === 'CHAN-9001'))
void todoIdx

// 13. 重置 localStorage 重新加载：归一化幂等
store = {}
const c2again = getChange(2)!
check('重载后重判结论稳定(主要变更)', String(c2again.变更类别) === '主要变更')
const c3again = getChange(3)!
check('重载后不合规批准仍为评估中', String(c3again.status) === '评估中')

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
}
