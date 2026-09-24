import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Evidence } from '../src/knowledge/evidence.ts'
import {
  buildReviewPlan,
  overdueDays,
  renderReviewPlan,
  reviewActivity,
  reviewDirectiveFor,
  shouldInterrupt,
  type ReviewCard,
} from '../src/review/plan.ts'

const NOW = new Date(2026, 8, 23, 12, 0, 0) // 2026-09-23 本地时间

function card(id: string, nextReviewAt: string | null, practiceCount = 1, nodeId?: string): ReviewCard {
  return { id, nodeId, srs: { nextReviewAt, practiceCount } }
}

function review(cardId: string, reviewedAt: string, result: 'again' | 'hard' | 'good', nodeId = 'n1'): Evidence {
  return {
    id: `ev-${cardId}-${reviewedAt}`,
    nodeId,
    kind: 'srs-review',
    sourceId: `${cardId}-srs-${reviewedAt}`,
    summary: `复习「${cardId}」：${result}`,
    result,
    srsResult: result,
    correct: result !== 'again',
    createdAt: reviewedAt,
  }
}

test('逾期天数只由日期计算：未来为 0、当天为 0、跨天正确、无排期为 0', () => {
  assert.equal(overdueDays(null, NOW), 0, '新卡不算逾期')
  assert.equal(overdueDays('2026-09-24T09:00:00.000Z', NOW), 0, '未来日期不算逾期')
  assert.equal(overdueDays('2026-09-23T00:00:00.000Z', NOW), 0, '当天到期不算逾期')
  assert.equal(overdueDays('2026-09-22T00:00:00.000Z', NOW), 1)
  assert.equal(overdueDays('2026-09-13T00:00:00.000Z', NOW), 10)
  assert.equal(overdueDays('不是时间', NOW), 0, '非法时间不产生假数字')
})

test('回归：复习计划只含到期卡，逾期最久的排最前，同分按 cardId 稳定', () => {
  const cards = [
    card('c-future', '2026-10-01T00:00:00.000Z'),
    card('c-today', '2026-09-23T00:00:00.000Z'),
    card('c-overdue-1', '2026-09-22T00:00:00.000Z'),
    card('c-overdue-9', '2026-09-14T00:00:00.000Z'),
    card('c-overdue-1b', '2026-09-22T00:00:00.000Z'),
  ]
  const plan = buildReviewPlan(cards, { now: NOW })
  assert.equal(plan.totalCards, 5)
  assert.equal(plan.dueCards, 4, '只有 4 张到期')
  assert.deepEqual(
    plan.queue.map((item) => item.cardId),
    ['c-overdue-9', 'c-overdue-1', 'c-overdue-1b', 'c-today'],
    '逾期 9 天 → 1 天（两张同分按 id 稳定）→ 今日到期',
  )
  assert.equal(plan.focus, 'due')
})

test('新卡标注为"第一次练习"，不是"复习"', () => {
  const plan = buildReviewPlan([card('c-new', null, 0)], { now: NOW })
  assert.equal(plan.freshCards, 1)
  assert.match(plan.queue[0]!.reason, /新卡/)
  assert.match(reviewDirectiveFor(plan), /新卡/)
})

test('limit 截断队列，但不改变总数与到期数', () => {
  const cards = Array.from({ length: 30 }, (_, index) => card(`c${String(index).padStart(2, '0')}`, null, 1))
  const plan = buildReviewPlan(cards, { now: NOW, limit: 5 })
  assert.equal(plan.queue.length, 5)
  assert.equal(plan.totalCards, 30)
  assert.equal(plan.dueCards, 30)
})

test('指定当前知识点时，该节点的卡排到最前（哪怕逾期更短）', () => {
  const cards = [card('c-old', '2026-09-01T00:00:00.000Z', 2, 'n-old'), card('c-now', null, 2, 'n-now')]
  const plan = buildReviewPlan(cards, { now: NOW, nodeId: 'n-now' })
  assert.equal(plan.queue[0]!.cardId, 'c-now')
  assert.equal(plan.focus, 'node')
})

test('nodeIds 限定范围：范围外的卡完全不进计划', () => {
  const cards = [card('c1', null, 1, 'n1'), card('c2', null, 1, 'n2')]
  const plan = buildReviewPlan(cards, { now: NOW, nodeIds: ['n1'] })
  assert.deepEqual(plan.queue.map((item) => item.cardId), ['c1'])
})

test('同一节点多张卡会被标出，指令要求合并提问（不连问三遍同一件事）', () => {
  const cards = [card('c1', null, 1, 'n1'), card('c2', null, 1, 'n1'), card('c3', null, 1, 'n2')]
  const plan = buildReviewPlan(cards, { now: NOW })
  assert.deepEqual(plan.mergedByNode, [{ nodeId: 'n1', cardIds: ['c1', 'c2'] }])
  assert.match(reviewDirectiveFor(plan), /合并成一次提问/)
})

test('"该节点尚无成功记录"来自证据：尝试过但一次都没成功', () => {
  const evidence = [review('c1', '2026-09-20T10:00:00.000Z', 'again'), review('c1', '2026-09-21T10:00:00.000Z', 'again')]
  const plan = buildReviewPlan([card('c1', null, 2, 'n1')], { now: NOW, evidence })
  assert.equal(plan.queue[0]!.nodeHasNoSuccess, true)
  assert.match(plan.queue[0]!.reason, /尚无成功记录/)
  assert.equal(plan.queue[0]!.lastResult, 'again')

  const passed = [review('c1', '2026-09-20T10:00:00.000Z', 'good')]
  const okPlan = buildReviewPlan([card('c1', null, 1, 'n1')], { now: NOW, evidence: passed })
  assert.equal(okPlan.queue[0]!.nodeHasNoSuccess, false)
})

test('打断规则是结构判定：连续答错必打断；当前节点有到期卡才打断', () => {
  const plan = buildReviewPlan([card('c-other', null, 1, 'n-other')], { now: NOW })

  assert.equal(shouldInterrupt(plan, { nodeId: 'n-now', consecutiveAgain: 0 }), false, '别的节点的卡不打断当前点')
  assert.equal(shouldInterrupt(plan, { nodeId: 'n-other', consecutiveAgain: 0 }), true, '同一节点有到期卡 → 插入复习')
  assert.equal(shouldInterrupt(plan, { nodeId: 'n-now', consecutiveAgain: 2 }), true, '连续答错两次 → 先停下复习')

  const none = buildReviewPlan([], { now: NOW })
  assert.equal(shouldInterrupt(none, { consecutiveAgain: 2 }), true, '没有卡也照样因连续答错而停下')
  assert.equal(shouldInterrupt(none, {}), false)
})

test('指令区分打断与收束，并在无到期时说清"不要为了完成任务而复习"', () => {
  const due = buildReviewPlan([card('c1', '2026-09-01T00:00:00.000Z', 2, 'n1')], { now: NOW })
  assert.match(reviewDirectiveFor(due, { interrupt: true }), /先停一下/)
  assert.match(reviewDirectiveFor(due), /收束前/)
  assert.match(reviewDirectiveFor(due), /到期 1 张/)

  const notDue = buildReviewPlan([card('c1', '2026-10-01T00:00:00.000Z')], { now: NOW })
  assert.equal(notDue.dueCards, 0)
  assert.match(reviewDirectiveFor(notDue), /不要为了"完成任务"提前复习/)

  const noCards = buildReviewPlan([], { now: NOW })
  assert.match(reviewDirectiveFor(noCards), /没有卡片/)
})

test('复习活动统计只来自 srs-review 证据行（替代恒为空的 reviewHistory 口径）', () => {
  const evidence = [
    review('c1', '2026-09-20T10:00:00.000Z', 'good'),
    review('c1', '2026-09-21T10:00:00.000Z', 'again'),
    review('c2', '2026-09-21T18:00:00.000Z', 'hard'),
    review('c2', '2026-09-22T09:00:00.000Z', 'good'),
    // 非复习证据不应计入
    { id: 'e-other', nodeId: 'n1', kind: 'answer-quality', sourceId: 's1', summary: '回答', createdAt: '2026-09-22T09:00:00.000Z' } as Evidence,
  ]
  const stats = reviewActivity(evidence)
  assert.equal(stats.reviewDays, 3, '三天有复习记录')
  assert.equal(stats.reviewedCards, 2, '两张不同的卡')
  assert.equal(stats.again, 1)
  assert.equal(stats.hard, 1)
  assert.equal(stats.good, 2)
})

test('空输入不产生假指标', () => {
  const plan = buildReviewPlan([], { now: NOW })
  assert.equal(plan.totalCards, 0)
  assert.equal(plan.dueCards, 0)
  assert.equal(plan.queue.length, 0)
  assert.equal(renderReviewPlan(plan), '暂无卡片')
  assert.deepEqual(reviewActivity([]), { reviewDays: 0, reviewedCards: 0, again: 0, hard: 0, good: 0 })
})

test('摘要渲染给出去重后的队列预览', () => {
  const plan = buildReviewPlan(
    [card('c-old', '2026-09-01T00:00:00.000Z'), card('c-new', null, 0)],
    { now: NOW },
  )
  const text = renderReviewPlan(plan)
  assert.match(text, /到期 2 \/ 共 2/)
  assert.match(text, /c-old/)
})
