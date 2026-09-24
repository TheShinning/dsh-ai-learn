import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Evidence } from '../src/knowledge/evidence.ts'
import type { KnowledgeNode } from '../src/knowledge/graph.ts'
import {
  CLASSROOM_GAP_LABEL,
  buildClassroomRecord,
  classroomRecordPath,
  findGaps,
  renderClassroomRecord,
} from '../src/records.classroom.ts'

let counter = 0
function ev(partial: Partial<Evidence> & Pick<Evidence, 'nodeId' | 'kind'>): Evidence {
  counter += 1
  return {
    id: `ev${String(counter).padStart(4, '0')}`,
    sourceId: `s${counter}`,
    summary: `证据 ${counter}`,
    createdAt: new Date(Date.UTC(2026, 8, 25, 10, 0, counter)).toISOString(),
    ...partial,
  }
}

const nodes: KnowledgeNode[] = [
  { id: 's1', type: 'section', title: '第一节 认识与实践', textbookKey: 'b', chapterId: 'c1', sectionId: 's1' },
  { id: 's2', type: 'section', title: '第二节 真理的标准', textbookKey: 'b', chapterId: 'c1', sectionId: 's2' },
]

const NOW = new Date(Date.UTC(2026, 8, 25, 11, 0, 0))

test('回归：记录里的每个计数都能指回证据（不是凭空统计）', () => {
  const evidence = [
    ev({ nodeId: 's1', kind: 'answer-quality', result: 'light', correct: true }),
    ev({ nodeId: 's1', kind: 'answer-quality', result: 'retell', correct: true }),
    ev({ nodeId: 's1', kind: 'flashcard', correct: true }),
    ev({ nodeId: 's1', kind: 'srs-review', result: 'good', srsResult: 'good', correct: true, sourceId: 'card-1-srs-x' }),
  ]
  const record = buildClassroomRecord({
    textbookKey: 'b',
    title: '实践论',
    materialType: 'textbook',
    mode: 'concept-driven',
    steps: [{ step: 'diagnose', action: 'ask', at: '2026-09-25T10:00:00.000Z' }],
    evidence,
    nodes,
    cards: [{ id: 'card-1', nodeId: 's1' }],
    now: NOW,
  })

  assert.equal(record.answered, 1, '一次普通作答')
  assert.equal(record.retold, 1)
  assert.equal(record.retoldPassed, 1)
  assert.equal(record.review.submitted, 1)
  assert.equal(record.review.good, 1)
  assert.equal(record.evidenceIds.length, 4, '四条证据都进记录')

  // 关键：节点条目里引用的证据 id 必须**真的能在传入证据里找到**
  const ids = new Set(evidence.map((item) => item.id))
  for (const entry of record.nodesTouched) {
    for (const id of entry.evidenceIds) assert.ok(ids.has(id), `记录引用了不存在的证据 ${id}`)
  }
})

test('掌握度用该节点的**全部**证据算，而不是只用本节证据（截断会得出错误结论）', () => {
  const prior = ev({ nodeId: 's1', kind: 'flashcard', correct: true, createdAt: '2026-09-24T10:00:00.000Z' })
  const today = ev({ nodeId: 's1', kind: 'code-lab', result: 'run' })
  const record = buildClassroomRecord({
    textbookKey: 'b',
    title: 't',
    steps: [],
    evidence: [prior, today],
    nodes,
    startedAt: '2026-09-25T09:00:00.000Z',
    endedAt: '2026-09-25T12:00:00.000Z',
    now: NOW,
  })
  const entry = record.nodesTouched.find((item) => item.nodeId === 's1')!
  assert.equal(entry.mastery, 'mastered', '闪卡答对 + 实验跑通 = 两种正向证据 → 已点亮')
  assert.equal(entry.evidenceIds.length, 1, '但本节只记录了今天那一条')
})

test('缺省起点是"最近这一段"，而不是把很久以前的历史证据也算进本节课', () => {
  const oldOne = ev({ nodeId: 's1', kind: 'answer-quality', result: 'clarify', correct: false, mastery: 'confused', createdAt: '2026-08-01T10:00:00.000Z' })
  const recent = ev({ nodeId: 's2', kind: 'answer-quality', result: 'light', correct: true, createdAt: '2026-09-25T10:50:00.000Z' })
  const record = buildClassroomRecord({ textbookKey: 'b', title: 't', steps: [], evidence: [oldOne, recent], nodes, now: NOW })
  assert.equal(record.evidenceIds.length, 1, '只把最近这一段算作本节')
  assert.equal(record.evidenceIds[0], recent.id)
})

test('缺口一：混淆未澄清（有答错且至今未点亮）', () => {
  const evidence = [ev({ nodeId: 's1', kind: 'answer-quality', result: 'clarify', correct: false, mastery: 'confused' })]
  const gaps = findGaps({ evidence, nodes })
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0]!.kind, 'confused-node')
  assert.equal(gaps[0]!.source, 'evidence')
  assert.equal(gaps[0]!.title, '第一节 认识与实践')
  assert.match(gaps[0]!.nextStep, /深度不归零|例子|二选一/)
})

test('缺口二：问了没答上（最后的问题之后没有作答证据）', () => {
  const evidence = [
    ev({ nodeId: 's1', kind: 'answer-quality', result: 'light', correct: true }),
    ev({ nodeId: 's1', kind: 'question-asked', result: 'ask', probeDepth: 1 }),
  ]
  const gaps = findGaps({ evidence, nodes })
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0]!.kind, 'unanswered')
  assert.match(gaps[0]!.nextStep, /降.*难度|例子|二选一/)

  // 问之后有作答 → 不算缺口
  const answered = [
    ev({ nodeId: 's1', kind: 'question-asked', result: 'ask' }),
    ev({ nodeId: 's1', kind: 'answer-quality', result: 'light', correct: true }),
  ]
  assert.equal(findGaps({ evidence: answered, nodes }).filter((gap) => gap.kind === 'unanswered').length, 0)
})

test('缺口三：材料残缺（解析未就绪 / 报错 / 只取到部分）', () => {
  const asFailed = findGaps({ evidence: [], nodes, parseStatus: 'failed' })
  assert.equal(asFailed[0]!.kind, 'material-defect')
  assert.equal(asFailed[0]!.source, 'material')
  assert.match(asFailed[0]!.nextStep, /重新导入|OCR/)

  const asPartial = findGaps({ evidence: [], nodes, parseStatus: 'ready', partial: true })
  assert.equal(asPartial[0]!.kind, 'material-defect')

  const asError = findGaps({ evidence: [], nodes, parseStatus: 'ready', parseError: '内容流里没有 BT/Tj' })
  assert.equal(asError[0]!.kind, 'material-defect')
  assert.match(asError[0]!.detail, /内容流/)

  // 一切正常时不得编造材料缺口
  assert.equal(findGaps({ evidence: [], nodes, parseStatus: 'ready', parseError: null, partial: false }).length, 0)
})

test('缺口四：已点亮却没建卡（系统缺口）', () => {
  const evidence = [
    ev({ nodeId: 's1', kind: 'flashcard', correct: true }),
    ev({ nodeId: 's1', kind: 'code-lab', result: 'run' }),
  ]
  const withoutCard = findGaps({ evidence, nodes })
  assert.equal(withoutCard.length, 1)
  assert.equal(withoutCard[0]!.kind, 'system-gap')
  assert.match(withoutCard[0]!.nextStep, /补建一张卡/)

  const withCard = findGaps({ evidence, nodes, cards: [{ id: 'c1', nodeId: 's1' }] })
  assert.equal(withCard.length, 0, '有卡就不算缺口')
})

test('缺口必须带来源标注，且四类标签齐全', () => {
  for (const kind of ['confused-node', 'unanswered', 'material-defect', 'system-gap'] as const) {
    assert.ok(CLASSROOM_GAP_LABEL[kind].length > 0)
  }
  const gaps = findGaps({
    evidence: [ev({ nodeId: 's1', kind: 'answer-quality', result: 'clarify', correct: false, mastery: 'confused' })],
    nodes,
    parseStatus: 'failed',
  })
  for (const gap of gaps) {
    assert.ok(['evidence', 'material', 'system', 'heuristic'].includes(gap.source))
    assert.ok(gap.nextStep.length > 5, '每个缺口都要有可执行的下一步')
  }
})

test('渲染：Markdown 含过程、知识点（带证据 id）、缺口与下一步、复习统计', () => {
  const evidence = [
    ev({ nodeId: 's1', kind: 'answer-quality', result: 'clarify', correct: false, mastery: 'confused' }),
  ]
  const record = buildClassroomRecord({
    textbookKey: 'book:demo',
    title: '实践论',
    materialType: 'textbook',
    mode: 'concept-driven',
    steps: [
      { step: 'diagnose', action: 'ask', at: '2026-09-25T10:00:00.000Z' },
      { step: 'scaffold', action: 'give-example', at: '2026-09-25T10:05:00.000Z' },
    ],
    evidence,
    nodes,
    now: NOW,
  })
  const md = renderClassroomRecord(record)

  assert.match(md, /^# 课堂记录 · 实践论/m)
  assert.match(md, /## 课堂过程/)
  assert.match(md, /diagnose｜ask/)
  assert.match(md, /## 涉及的知识点/)
  assert.match(md, /第一节 认识与实践｜掌握度 confused｜证据 1 条（ev/)
  assert.match(md, /## 还不完善的点/)
  assert.match(md, /概念混淆未澄清/)
  assert.match(md, /下一步：/)
  assert.match(md, /## 复习/)
  assert.match(md, /快照/)
})

test('无缺口时的渲染必须如实说"无"，而不是留空', () => {
  const record = buildClassroomRecord({ textbookKey: 'b', title: 't', steps: [], evidence: [], nodes, now: NOW })
  const md = renderClassroomRecord(record)
  assert.match(md, /（无：本节没有未澄清的困惑/)
  assert.match(md, /（本节没有产生证据）/)
})

test('记录 id 唯一、文件名可排序且净化了非法字符', () => {
  const one = buildClassroomRecord({ textbookKey: 'b', title: 'a/b:c*d?e"f<g>h|i', steps: [], evidence: [], nodes, now: NOW })
  const two = buildClassroomRecord({ textbookKey: 'b', title: 'x', steps: [], evidence: [], nodes, now: NOW })
  assert.notEqual(one.id, two.id)
  const path = classroomRecordPath(one)
  assert.match(path, /^\.study\/records\/2026-09-25-/)
  assert.ok(!/[\\:*?"<>|]/.test(path), `文件名不得含非法字符：${path}`)
  assert.ok(path.endsWith('.md'))
})

test('时间窗：不属于本节的证据不进记录，但仍然参与缺口归因', () => {
  const old = ev({ nodeId: 's1', kind: 'answer-quality', result: 'clarify', correct: false, mastery: 'confused', createdAt: '2026-09-01T10:00:00.000Z' })
  const today = ev({ nodeId: 's1', kind: 'answer-quality', result: 'light', correct: true })
  const record = buildClassroomRecord({
    textbookKey: 'b',
    title: 't',
    steps: [],
    evidence: [old, today],
    nodes,
    startedAt: '2026-09-25T09:00:00.000Z',
    endedAt: '2026-09-25T12:00:00.000Z',
    now: NOW,
  })
  assert.equal(record.evidenceIds.length, 1, '旧证据不进本节记录')
  assert.equal(record.answered, 1)
  // 但缺口看全量：那个旧的困惑点仍在待办里
  assert.ok(record.gaps.some((gap) => gap.kind === 'confused-node'), '旧困惑仍要出现在"还不完善的点"')
})
