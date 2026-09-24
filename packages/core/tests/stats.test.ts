import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Evidence } from '../src/knowledge/evidence.ts'
import type { KnowledgeGraph } from '../src/knowledge/graph.ts'
import { buildStudyStats, metric, renderStats, type FlashcardLike } from '../src/growth/stats.ts'

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

const graph: KnowledgeGraph = {
  nodes: [
    { id: 'kg:textbook:b', type: 'textbook', title: '教材', textbookKey: 'b' },
    { id: 's1', type: 'section', title: '第一节', textbookKey: 'b', chapterId: 'c1', sectionId: 's1' },
    { id: 's2', type: 'section', title: '第二节', textbookKey: 'b', chapterId: 'c1', sectionId: 's2' },
    { id: 's3', type: 'section', title: '第三节', textbookKey: 'b', chapterId: 'c1', sectionId: 's3' },
  ],
  edges: [],
  evidence: [
    ev({ nodeId: 's1', kind: 'flashcard', correct: true }),
    ev({ nodeId: 's1', kind: 'code-lab', result: 'run' }),
    ev({ nodeId: 's2', kind: 'metacognition' }),
    ev({ nodeId: 's3', kind: 'answer-quality', mastery: 'confused', result: 'clarify' }),
    ev({ nodeId: 's3', kind: 'answer-quality', mastery: 'confused', result: 'clarify', sourceId: 'second' }),
  ],
}

const now = new Date(2026, 6, 10, 12, 0, 0)

test('回归：启发式指标必须带 note，否则构造即失败（原系统把启发式数字渲染成"基于真实证据"）', () => {
  assert.throws(() => metric(7, 'heuristic'), /启发式指标必须提供 note/)
  const ok = metric(7, 'heuristic', { note: '按对话轮数估计，不是掌握证据' })
  assert.equal(ok.source, 'heuristic')
  assert.ok(ok.note)
})

test('buildStudyStats：统计只来自证据与复习史，没有任何聊天文本输入', () => {
  const cards: FlashcardLike[] = [
    { id: 'c1', reviewHistory: [{ reviewedAt: '2026-07-08T10:00:00.000Z', result: 'good' }], srs: { intervalDays: 3, easeFactor: 2.6, practiceCount: 1, nextReviewAt: '2026-07-20T12:00:00.000Z' } },
    { id: 'c2', reviewHistory: [], srs: { intervalDays: 0, easeFactor: 2.5, practiceCount: 0 } },
  ]
  const stats = buildStudyStats({ graph, flashcards: cards, now })

  assert.equal(stats.totalNodes.value, 3, '排除 textbook 节点')
  assert.equal(stats.totalNodes.source, 'evidence')
  assert.equal(stats.masteredNodes.value, 1, 's1 有闪卡答对 + 实验跑通两种正向证据')
  assert.equal(stats.confusedNodes.value, 1)
  assert.equal(stats.totalEvidence.value, 5)
  assert.equal(stats.metacognitionCount.value, 1)
  assert.equal(stats.reviewDays.value, 1)
  assert.equal(stats.reviewedCards.value, 1)
  assert.equal(stats.dueCards.value, 1, 'c2 无排期视为到期；c1 到期日在 now 之后')
})

test('反复困惑节点是派生指标，并说明口径', () => {
  const stats = buildStudyStats({ graph, flashcards: [], now })
  assert.equal(stats.repeatedConfusedNodes.value, 1, 's3 出现两条困惑证据')
  assert.equal(stats.repeatedConfusedNodes.source, 'derived')
  assert.match(String(stats.repeatedConfusedNodes.note), /≥2 条困惑证据/)
})

test('所有证据型指标都带 basedOn，便于回溯到证据条数', () => {
  const stats = buildStudyStats({ graph, flashcards: [], now })
  for (const [label, item] of Object.entries(stats)) {
    if (item.source === 'evidence') {
      assert.equal(typeof item.basedOn, 'number', `${label} 缺少 basedOn`)
    }
  }
})

test('renderStats：非证据指标必须显式标注来源，证据指标保持干净', () => {
  const stats = buildStudyStats({ graph, flashcards: [], now })
  const text = renderStats(stats)
  assert.match(text, /反复困惑节点：1（由证据派生）/)
  assert.match(text, /已点亮：1\n/, '证据型指标不额外加后缀')
  assert.ok(!text.includes('启发式估计'), '本轮数据里没有启发式指标')
})

test('空数据不产生假指标', () => {
  const empty: KnowledgeGraph = { nodes: [], edges: [], evidence: [] }
  const stats = buildStudyStats({ graph: empty, flashcards: [], now })
  assert.equal(stats.totalNodes.value, 0)
  assert.equal(stats.masteredNodes.value, 0)
  assert.equal(stats.totalEvidence.value, 0)
  assert.equal(stats.dueCards.value, 0)
  assert.match(renderStats(stats), /知识点总数：0/)
})

test('回归：复习统计以 srs-review 证据为准 —— 生产调用点从不传 reviewHistory 的时代结束了', () => {
  const reviewRows: Evidence[] = [
    ev({ nodeId: 's1', kind: 'srs-review', sourceId: 'c1-srs-1', result: 'good', srsResult: 'good', correct: true, createdAt: '2026-07-08T10:00:00.000Z' }),
    ev({ nodeId: 's1', kind: 'srs-review', sourceId: 'c1-srs-2', result: 'again', srsResult: 'again', correct: false, createdAt: '2026-07-09T10:00:00.000Z' }),
    ev({ nodeId: 's1', kind: 'srs-review', sourceId: 'c2-srs-1', result: 'hard', srsResult: 'hard', correct: true, createdAt: '2026-07-09T18:00:00.000Z' }),
  ]
  // 生产调用点的真实形状：reviewHistory 恒为空数组
  const cards: FlashcardLike[] = [
    { id: 'c1', reviewHistory: [], srs: { intervalDays: 1, easeFactor: 2.4, practiceCount: 2, nextReviewAt: '2026-07-20T12:00:00.000Z' } },
    { id: 'c2', reviewHistory: [], srs: { intervalDays: 3, easeFactor: 2.5, practiceCount: 1, nextReviewAt: '2026-07-20T12:00:00.000Z' } },
  ]

  const withoutEvidence = buildStudyStats({ graph, flashcards: cards, now })
  assert.equal(withoutEvidence.reviewDays.value, 0, '没有证据行时保持旧口径（0），不假装有数据')

  const withEvidence = buildStudyStats({ graph, flashcards: cards, reviewEvidence: reviewRows, now })
  assert.equal(withEvidence.reviewDays.value, 2, '7-08 与 7-09 两天有复习记录')
  assert.equal(withEvidence.reviewedCards.value, 2, 'c1 与 c2 两张卡')
  assert.equal(withEvidence.reviewDays.source, 'evidence')
  assert.equal(typeof withEvidence.reviewDays.basedOn, 'number')

  // 渲染里应能看到真实数字，而不是恒 0
  assert.match(renderStats(withEvidence), /复习天数：2/)
  assert.match(renderStats(withEvidence), /已复习卡：2/)
})
