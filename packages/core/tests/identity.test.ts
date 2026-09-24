import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyImportPlan,
  contentHash,
  emptyLearnerState,
  planTextbookImport,
  textbookKey,
  type TextbookRecord,
} from '../src/textbook/identity.ts'

const FIRST_BODY = `# 矛盾论\n\n## 第一节\n\n事物的矛盾法则，即对立统一的法则。\n`

test('contentHash 对同样内容稳定、对改动敏感', () => {
  assert.equal(contentHash(FIRST_BODY), contentHash(FIRST_BODY))
  assert.notEqual(contentHash(FIRST_BODY), contentHash(FIRST_BODY + ' '))
  assert.match(contentHash(FIRST_BODY), /^[0-9a-f]{16}$/)
})

test('textbookKey 只由来源决定，正文不参与', () => {
  const a = textbookKey({ title: '矛盾论', sourceRef: 'study-material/book/017-矛盾论.md' })
  const b = textbookKey({ title: '矛盾论（修订）', sourceRef: 'study-material/book/017-矛盾论.md' })
  assert.equal(a, b, '同一来源引用必须得到同一身份，标题变化不影响')
  const c = textbookKey({ title: '矛盾论', sourceRef: 'study-material/book/018-实践论.md' })
  assert.notEqual(a, c)
  const explicit = textbookKey({ title: '矛盾论', explicitId: 'maodun' })
  assert.equal(explicit, 'book:maodun')
})

test('回归：改正文后仍是同一本教材（原系统会新建并追加）', () => {
  const sourceRef = 'study-material/book/017-矛盾论.md'
  const created = applyImportPlan(
    planTextbookImport({ title: '矛盾论', body: FIRST_BODY, sourceRef, now: '2026-07-01T00:00:00.000Z' }),
    { title: '矛盾论', sourceRef, now: '2026-07-01T00:00:00.000Z' },
  )
  const existing: TextbookRecord = created

  const revised = planTextbookImport({
    title: '矛盾论',
    body: FIRST_BODY.replace('对立统一', '对立统一（修订）'),
    sourceRef,
    existing,
    now: '2026-07-02T00:00:00.000Z',
  })

  assert.equal(revised.action, 'revise', '同一来源改正文应为修订，而不是新建')
  assert.equal(revised.key, existing.key, '身份必须保持不变')
  assert.notEqual(revised.revision, existing.revision, '正文哈希变了')
  assert.equal(revised.preservesLearnerState, true, '修订必须保留学习状态')
  assert.equal(revised.rebuildsStructure, true)
})

test('回归：教材记录的形状必须与持久层（domain textbooks 表）一致', () => {
  // 病因（2026-09-24 修正）：core 曾用嵌套 `revision: { revision, parsedAt, parseStatus }`，
  // 而 domain schema 要求 `revision: string` + 顶层 `parseStatus`/`parseError`。
  // 两者被当成同一类型使用（applyImportPlan 的返回值直接传给 putTextbook），
  // 于是写进域的行结构不合法、`parseStatus` 在工具里永远是 undefined。
  const record = applyImportPlan(
    planTextbookImport({ title: '矛盾论', body: FIRST_BODY, sourceRef: 'study-material/017.md' }),
    { title: '矛盾论', sourceRef: 'study-material/017.md' },
  )

  assert.equal(typeof record.revision, 'string', 'revision 必须是内容哈希字符串，而不是嵌套对象')
  assert.match(record.revision, /^[0-9a-f]{16}$/)
  assert.equal(record.parseStatus, 'ready', 'parseStatus 必须在顶层（domain 的必填字段）')
  assert.equal(record.parseError, null, 'parseError 成功时为 null（domain 约定 .nullable()）')
  assert.equal(typeof record.parsedAt, 'string')
  assert.ok(!Number.isNaN(Date.parse(record.parsedAt)))
  // 允许出现在记录上的键集合（多一个就会在 domain 里被静默丢弃，少一个就写不进去）
  assert.deepEqual(
    Object.keys(record).sort(),
    ['createdAt', 'key', 'parseError', 'parseStatus', 'parsedAt', 'revision', 'sourceFormat', 'sourceRef', 'structureVersion', 'title', 'updatedAt'].sort(),
  )
})

test('正文未变时判定为 unchanged，且不重建结构', () => {
  const sourceRef = 'study-material/book/017-矛盾论.md'
  const existing = applyImportPlan(planTextbookImport({ title: '矛盾论', body: FIRST_BODY, sourceRef }), {
    title: '矛盾论',
    sourceRef,
  })
  const again = planTextbookImport({ title: '矛盾论', body: FIRST_BODY, sourceRef, existing })
  assert.equal(again.action, 'unchanged')
  assert.equal(again.rebuildsStructure, false)
  assert.equal(again.preservesLearnerState, true)
})

test('不同来源引用视为另一本教材，并显式说明', () => {
  const existing = applyImportPlan(planTextbookImport({ title: '矛盾论', body: FIRST_BODY, sourceRef: 'a.md' }), {
    title: '矛盾论',
    sourceRef: 'a.md',
  })
  const other = planTextbookImport({ title: '矛盾论', body: FIRST_BODY, sourceRef: 'b.md', existing })
  assert.equal(other.action, 'create')
  assert.equal(other.preservesLearnerState, false)
  assert.match(other.reason, /身份不同/)
})

test('学习状态与结构解耦，可独立于教材记录存在', () => {
  const state = emptyLearnerState('book:maodun')
  assert.deepEqual(state.mastery, {})
  assert.deepEqual(state.palace, {})
})

test('applyImportPlan：结构版本递增、createdAt 保留、sourceFormat 可继承', () => {
  const sourceRef = 'study-material/book/017-矛盾论.md'
  const firstPlan = planTextbookImport({ title: '矛盾论', body: FIRST_BODY, sourceRef, now: '2026-07-01T00:00:00.000Z' })
  const first = applyImportPlan(firstPlan, {
    title: '矛盾论',
    sourceRef,
    sourceFormat: 'markdown',
    now: '2026-07-01T00:00:00.000Z',
  })
  assert.equal(first.structureVersion, 1)
  assert.equal(first.sourceFormat, 'markdown')

  const revisePlan = planTextbookImport({
    title: '矛盾论',
    body: `${FIRST_BODY}\n补充一段。\n`,
    sourceRef,
    existing: first,
    now: '2026-07-02T00:00:00.000Z',
  })
  const revised = applyImportPlan(revisePlan, {
    title: '矛盾论',
    sourceRef,
    existing: first,
    now: '2026-07-02T00:00:00.000Z',
  })
  assert.equal(revised.structureVersion, 2, '重建结构时版本递增')
  assert.equal(revised.createdAt, first.createdAt, '修订保留创建时间')
  assert.equal(revised.sourceFormat, 'markdown', '未显式传时继承旧值')

  const unchangedPlan = planTextbookImport({
    title: '矛盾论',
    body: `${FIRST_BODY}\n补充一段。\n`,
    sourceRef,
    existing: revised,
  })
  const unchanged = applyImportPlan(unchangedPlan, { title: '矛盾论', sourceRef, existing: revised })
  assert.equal(unchanged.structureVersion, 2, '正文未变时不递增结构版本')
})
