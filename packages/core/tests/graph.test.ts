import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Evidence } from '../src/knowledge/evidence.ts'
import {
  PREREQUISITE_PENALTY,
  buildMasteryIndex,
  buildRouteStops,
  masteryStats,
  nodeBloomLevel,
  prerequisitesReady,
  rebuildStructure,
  routeScore,
  type KnowledgeEdge,
  type KnowledgeGraph,
  type KnowledgeNode,
} from '../src/knowledge/graph.ts'

const BOOK = 'book:maodun'

const nodes: KnowledgeNode[] = [
  { id: 'kg:textbook:book', type: 'textbook', title: '矛盾论', textbookKey: BOOK },
  { id: 'ch1', type: 'chapter', title: '第一章', textbookKey: BOOK, chapterId: 'ch1' },
  { id: 'sec1', type: 'section', title: '两种宇宙观', textbookKey: BOOK, chapterId: 'ch1', sectionId: 'sec1' },
  { id: 'sec2', type: 'section', title: '矛盾的普遍性', textbookKey: BOOK, chapterId: 'ch1', sectionId: 'sec2' },
  { id: 'sec3', type: 'section', title: '矛盾的特殊性', textbookKey: BOOK, chapterId: 'ch1', sectionId: 'sec3' },
]

const structureEdges: KnowledgeEdge[] = [
  { id: 'e-text-ch', from: 'kg:textbook:book', to: 'ch1', relation: 'contains', confidence: 1 },
  { id: 'e-ch-s1', from: 'ch1', to: 'sec1', relation: 'contains', confidence: 1 },
  { id: 'e-ch-s2', from: 'ch1', to: 'sec2', relation: 'contains', confidence: 1 },
  { id: 'e-ch-s3', from: 'ch1', to: 'sec3', relation: 'contains', confidence: 1 },
  { id: 'e-prereq-12', from: 'sec1', to: 'sec2', relation: 'prerequisite', confidence: 0.8 },
]

let counter = 0
function ev(partial: Partial<Evidence> & Pick<Evidence, 'nodeId' | 'kind'>): Evidence {
  counter += 1
  return {
    id: `e${String(counter).padStart(4, '0')}`,
    sourceId: `s${counter}`,
    summary: `证据 ${counter}`,
    createdAt: new Date(Date.UTC(2026, 6, 1, 0, 0, counter)).toISOString(),
    ...partial,
  }
}

function baseGraph(evidence: Evidence[] = []): KnowledgeGraph {
  return { nodes, edges: structureEdges, evidence }
}

test('routeScore：困惑点分数最高，先修未点亮统一降权一次', () => {
  const confused = routeScore({ node: nodes[2]!, mastery: 'confused', evidenceCount: 0, prerequisites: [] })
  const unknownWithEvidence = routeScore({ node: nodes[2]!, mastery: 'unknown', evidenceCount: 2, prerequisites: [] })
  const unknown = routeScore({ node: nodes[2]!, mastery: 'unknown', evidenceCount: 0, prerequisites: [] })
  const partial = routeScore({ node: nodes[2]!, mastery: 'partial', evidenceCount: 0, prerequisites: [] })
  assert.equal(confused.score, 100)
  assert.equal(unknownWithEvidence.score, 82)
  assert.equal(unknown.score, 62)
  assert.equal(partial.score, 42)
  assert.ok(confused.score > unknownWithEvidence.score)
  assert.ok(unknownWithEvidence.score > unknown.score)
  assert.ok(unknown.score > partial.score)

  const gated = routeScore({
    node: nodes[3]!,
    mastery: 'unknown',
    evidenceCount: 0,
    prerequisites: [
      { node: nodes[2]!, mastery: 'confused' },
      { node: nodes[1]!, mastery: 'unknown' },
    ],
  })
  assert.equal(gated.score, 62 - PREREQUISITE_PENALTY, '多个未点亮先修只扣一次')
  assert.equal(gated.unresolvedPrerequisites.length, 2)
  assert.match(gated.reason, /先修未点亮/)
})

test('routeScore：已掌握节点不再扣先修罚分（与旧实现一致）', () => {
  const mastered = routeScore({
    node: nodes[3]!,
    mastery: 'mastered',
    evidenceCount: 3,
    prerequisites: [{ node: nodes[2]!, mastery: 'confused' }],
  })
  assert.equal(mastered.score, 8 + 3)
  assert.deepEqual(mastered.unresolvedPrerequisites, [])
})

test('buildRouteStops：先修未点亮的节点被降到先修之后', () => {
  // sec1 有证据（80）但先修已亮；sec2 有证据但要先修 sec1 —— sec1 未点亮时 sec2 被 −50
  const graph = baseGraph([
    ev({ nodeId: 'sec1', kind: 'answer-quality', result: 'light' }),
    ev({ nodeId: 'sec2', kind: 'answer-quality', result: 'light' }),
  ])
  const index = buildMasteryIndex(graph)
  assert.equal(index.sec1, 'partial', '单条正向证据只到半掌握')
  assert.equal(index.sec2, 'partial')

  const stops = buildRouteStops(graph, index)
  const position = (id: string) => stops.findIndex((stop) => stop.node.id === id)
  const sec2 = stops.find((stop) => stop.node.id === 'sec2')!
  // sec2 是半掌握（42）+ 1 条证据 − 先修未点亮 50 = −7
  // 负分的含义：先回去点亮先修，而不是继续推进这个点
  assert.equal(sec2.score, 42 + 1 - PREREQUISITE_PENALTY)
  assert.ok(sec2.score < 0, '半掌握且先修未点亮 → 负分，排到最后')
  assert.ok(
    position('sec1') < position('sec2'),
    `后继被降到先修之后：sec1@${position('sec1')} 应在 sec2@${position('sec2')} 之前`,
  )
  // 未点亮(62) 排在半掌握(43) 之前是打分表的本意：先照亮没接触过的点
  assert.equal(stops[0]!.node.id, 'sec3')
  assert.equal(stops.at(-1)!.node.id, 'sec2', '被先修门控否决的点排在最后')
  assert.equal(stops.length, 3, 'containers（textbook/chapter）被排除在路线之外')
  assert.ok(!stops.some((stop) => stop.node.type === 'chapter'), '不把"第一章"这种容器当作可推进的学习单元')

  const withContainers = buildRouteStops(graph, index, { includeContainers: true })
  assert.ok(withContainers.some((stop) => stop.node.type === 'chapter'), '显式打开后可看到层级节点')
})

test('buildRouteStops：limit 与同分时的确定性排序', () => {
  const graph = baseGraph()
  const index = buildMasteryIndex(graph)
  const limited = buildRouteStops(graph, index, { limit: 2 })
  assert.equal(limited.length, 2)
  // 同分（都是 unknown 62，sec2 因先修 −50）时按章节/节序排列
  const all = buildRouteStops(graph, index)
  assert.deepEqual(all.map((stop) => stop.node.id), ['sec1', 'sec3', 'sec2'])
  assert.deepEqual(limited.map((stop) => stop.node.id), ['sec1', 'sec3'])
})

test('nodeBloomLevel：取证据里出现过的最高层级', () => {
  const graph = baseGraph([
    ev({ nodeId: 'sec1', kind: 'answer-quality', result: 'light', bloomLevel: 'remember' }),
    ev({ nodeId: 'sec1', kind: 'answer-quality', result: 'light', bloomLevel: 'apply' }),
    ev({ nodeId: 'sec1', kind: 'note', bloomLevel: 'understand' }),
  ])
  assert.equal(nodeBloomLevel(graph, 'sec1'), 'apply')
  assert.equal(nodeBloomLevel(graph, 'sec2'), undefined)
})

test('prerequisitesReady 是硬门控（全亮才 true）', () => {
  const none = baseGraph()
  assert.equal(prerequisitesReady(none, buildMasteryIndex(none), 'sec1'), true, '无先修即就绪')
  assert.equal(prerequisitesReady(none, buildMasteryIndex(none), 'sec2'), false)

  const lit = baseGraph([
    ev({ nodeId: 'sec1', kind: 'mastery-confirm', mastery: 'mastered' }),
  ])
  assert.equal(prerequisitesReady(lit, buildMasteryIndex(lit), 'sec2'), true)
})

test('回归：重建结构必须保留证据、掌握度与手工语义边（原系统从空图重建全部丢失）', () => {
  const graph = baseGraph([
    ev({ nodeId: 'sec1', kind: 'flashcard', correct: true }),
    ev({ nodeId: 'sec1', kind: 'code-lab', result: 'run' }),
    ev({ nodeId: 'sec2', kind: 'mastery-confirm', mastery: 'mastered' }),
  ])
  const manual: KnowledgeEdge[] = [
    { id: 'm1', from: 'sec1', to: 'sec3', relation: 'contrasts', confidence: 1 },
    { id: 'm2', from: 'sec2', to: 'sec3', relation: 'confused-with', confidence: 1 },
  ]
  const before: KnowledgeGraph = { ...graph, edges: [...graph.edges, ...manual] }
  assert.equal(buildMasteryIndex(before).sec1, 'mastered')

  // 模拟"按教材重建结构"：节点与结构边原样给出
  const next = rebuildStructure(
    { nodes, edges: structureEdges },
    before,
  )

  assert.equal(next.evidence.length, 3, '证据必须全部保留')
  assert.equal(buildMasteryIndex(next).sec1, 'mastered', '掌握度是证据的纯函数，因而自动保留')
  assert.equal(buildMasteryIndex(next).sec2, 'mastered')
  const relations = next.edges.map((edge) => edge.relation)
  assert.ok(relations.includes('contrasts'), '手工对照边保留')
  assert.ok(relations.includes('confused-with'), '手工易混边保留')
  assert.equal(relations.filter((relation) => relation === 'contains').length, 4, '结构边按新结构生成')
})

test('重建结构：节点被删时其证据一并丢弃，不留孤儿证据', () => {
  const before = baseGraph([ev({ nodeId: 'sec3', kind: 'note' })])
  const trimmedNodes = nodes.filter((node) => node.id !== 'sec3')
  const trimmedEdges = structureEdges.filter((edge) => edge.to !== 'sec3')
  const next = rebuildStructure({ nodes: trimmedNodes, edges: trimmedEdges }, before)
  assert.equal(next.evidence.length, 0)
  assert.equal(next.nodes.some((node) => node.id === 'sec3'), false)
})

test('masteryStats：排除 textbook 节点，active = mastered + partial', () => {
  const graph = baseGraph([
    ev({ nodeId: 'sec1', kind: 'mastery-confirm', mastery: 'mastered' }),
    ev({ nodeId: 'sec2', kind: 'answer-quality', result: 'light' }),
    ev({ nodeId: 'sec3', kind: 'answer-quality', mastery: 'confused', result: 'clarify' }),
  ])
  const stats = masteryStats(graph, buildMasteryIndex(graph))
  assert.equal(stats.total, 4, 'textbook 节点不计入')
  assert.equal(stats.mastered, 1)
  assert.equal(stats.partial, 1)
  assert.equal(stats.confused, 1)
  assert.equal(stats.unknown, 1)
  assert.equal(stats.active, 2)
})
