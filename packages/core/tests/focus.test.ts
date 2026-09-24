import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Evidence } from '../src/knowledge/evidence.ts'
import type { KnowledgeEdge, KnowledgeGraph, KnowledgeNode } from '../src/knowledge/graph.ts'
import { buildReviewPlan } from '../src/review/plan.ts'
import {
  FOCUS_REASON_LABEL,
  focusReasonDirective,
  renderFocus,
  selectFocusNode,
} from '../src/pedagogy/focus.ts'

let counter = 0
function node(id: string, title: string, chapterId = 'c1', sectionId?: string): KnowledgeNode {
  return { id, type: 'section', title, textbookKey: 'b', chapterId, sectionId: sectionId ?? id }
}

function edge(from: string, to: string, relation: KnowledgeEdge['relation'] = 'prerequisite'): KnowledgeEdge {
  return { id: `e-${from}-${to}`, from, to, relation, confidence: 1, manual: false }
}

function ev(nodeId: string, mastery: Evidence['mastery'], result?: string): Evidence {
  counter += 1
  return {
    id: `ev${counter}`,
    nodeId,
    kind: 'answer-quality',
    sourceId: `s${counter}`,
    summary: `证据 ${counter}`,
    mastery,
    result,
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, counter)).toISOString(),
  }
}

function graphOf(nodes: KnowledgeNode[], evidence: Evidence[] = [], edges: KnowledgeEdge[] = []): KnowledgeGraph {
  return { nodes, edges, evidence }
}

test('空图谱：返回 empty 且直接指向零起点动作，而不是报错', () => {
  const decision = selectFocusNode(graphOf([]))
  assert.equal(decision.reason, 'empty')
  assert.equal(decision.nodeId, undefined)
  assert.match(decision.directive, /锁定一份材料/)
})

test('回归：困惑点优先于一切（负面证据有否决权）', () => {
  const graph = graphOf(
    [node('s1', '第一节'), node('s2', '第二节'), node('s3', '第三节')],
    [ev('s3', 'confused', 'clarify')],
  )
  const decision = selectFocusNode(graph)
  assert.equal(decision.reason, 'confused')
  assert.equal(decision.title, '第三节')
  assert.match(decision.detail, /困惑|答错/)
  assert.match(decision.directive, /降阶/)
})

test('答错（correct=false）即使掌握度不是 confused 也算困惑信号', () => {
  const wrong: Evidence = { ...ev('s2', undefined), correct: false }
  const graph = graphOf([node('s1', '第一节'), node('s2', '第二节')], [wrong])
  assert.equal(selectFocusNode(graph).title, '第二节')
})

test('到期复习优先于未点亮：有到期卡的节点先来', () => {
  const graph = graphOf([node('s1', '第一节'), node('s2', '第二节')])
  const plan = buildReviewPlan([{ id: 'c1', nodeId: 's2', srs: { nextReviewAt: null, practiceCount: 1 } }], {
    now: new Date(2026, 8, 23, 12, 0, 0),
  })
  const decision = selectFocusNode(graph, { reviewPlan: plan })
  assert.equal(decision.reason, 'due-review')
  assert.equal(decision.title, '第二节')
  assert.match(decision.directive, /复习/)
})

test('先修缺口：目标点未亮而先修也没亮 → 先补先修，并列出未点亮的先修', () => {
  const graph = graphOf([node('s1', '基础概念'), node('s2', '进阶应用')], [], [edge('s1', 's2')])
  const decision = selectFocusNode(graph)
  assert.equal(decision.reason, 'prerequisite-gap')
  assert.equal(decision.title, '进阶应用')
  assert.deepEqual(decision.unresolvedPrerequisites, ['基础概念'])
  assert.match(decision.detail, /基础概念/)
})

test('先修已点亮时不再算缺口，正常进入未点亮档', () => {
  const evidence = [ev('s1', 'mastered', 'light'), { ...ev('s1', 'mastered', 'light'), kind: 'flashcard' as const, correct: true }]
  const graph = graphOf([node('s1', '基础概念'), node('s2', '进阶应用')], evidence, [edge('s1', 's2')])
  const decision = selectFocusNode(graph)
  assert.equal(decision.reason, 'unlit')
  assert.equal(decision.title, '进阶应用')
})

test('未点亮档内：已有证据者优先于完全没碰过的（与 routeScore 同口径）', () => {
  const graph = graphOf([node('s1', '第一节'), node('s2', '第二节')], [ev('s2', 'partial', 'consolidate')])
  const decision = selectFocusNode(graph)
  assert.equal(decision.reason, 'unlit')
  assert.equal(decision.title, '第二节', '有证据的未点亮点更该继续推进')
  assert.match(decision.detail, /已有 1 条证据/)
})

test('同档内偏好只影响选择，不改变档位顺序', () => {
  const graph = graphOf(
    [node('s1', '第一节'), node('s2', '第二节')],
    [ev('s1', 'confused', 'clarify')],
  )
  // 偏好第二节，但第一节是困惑点 → 困惑档位必须赢
  const decision = selectFocusNode(graph, { preferNodeIds: ['s2'] })
  assert.equal(decision.reason, 'confused')
  assert.equal(decision.title, '第一节')

  // 没有困惑点时，偏好生效
  const plain = selectFocusNode(graphOf([node('s1', '第一节'), node('s2', '第二节')]), { preferNodeIds: ['s2'] })
  assert.equal(plain.title, '第二节')
})

test('excludeNodeIds 排除刚讲完的点，避免原地打转', () => {
  const graph = graphOf([node('s1', '第一节'), node('s2', '第二节')])
  const decision = selectFocusNode(graph, { excludeNodeIds: ['s1'] })
  assert.equal(decision.title, '第二节')
})

test('全部点亮时进入低频复盘档，并要求给迁移题而不是重复原题', () => {
  const evidence = [
    ev('s1', 'mastered', 'light'),
    { ...ev('s1', 'mastered', 'light'), kind: 'flashcard' as const, correct: true },
  ]
  const decision = selectFocusNode(graphOf([node('s1', '第一节')], evidence))
  assert.equal(decision.reason, 'review-mastered')
  assert.match(decision.directive, /迁移|变式/)
})

test('textbook/chapter 容器节点不是可推进单元', () => {
  const container: KnowledgeNode = { id: 'kg:b', type: 'textbook', title: '某教材', textbookKey: 'b' }
  const chapter: KnowledgeNode = { id: 'ch1', type: 'chapter', title: '第一章', textbookKey: 'b', chapterId: 'ch1' }
  const decision = selectFocusNode(graphOf([container, chapter]))
  assert.equal(decision.reason, 'empty', '只有容器节点时视为没有可推进单元')
})

test('每条档位都有中文标签与策略句（不出现空字符串）', () => {
  for (const reason of Object.keys(FOCUS_REASON_LABEL) as (keyof typeof FOCUS_REASON_LABEL)[]) {
    assert.ok(FOCUS_REASON_LABEL[reason].length > 0)
    assert.ok(focusReasonDirective(reason).length > 5)
  }
})

test('渲染状态行包含焦点、理由与证据条数', () => {
  const graph = graphOf([node('s1', '第一节')], [ev('s1', 'confused', 'clarify')])
  const line = renderFocus(selectFocusNode(graph))
  assert.match(line, /焦点：第一节/)
  assert.match(line, /困惑点优先澄清/)
  assert.match(line, /证据 1 条/)
})
