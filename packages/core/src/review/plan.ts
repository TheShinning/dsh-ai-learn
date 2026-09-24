/**
 * 复习编排 —— 把"到期卡"变成一节课里真正能插入的复习动作。
 *
 * ## 为什么不能只列一个到期清单
 *
 * 原系统有 SRS 字段、有调度器、也有到期列表，但复习始终是**旁路**：
 * 它在闪卡窗口里独立发生，教学回路读不到"刚刚复习失败过"。
 * 于是"及时复习"只能靠用户自己去点开闪卡窗口。
 *
 * 本模块把复习折进教学步骤：
 * - `buildReviewPlan()` 给出**有序**队列（逾期越久越靠前，同分按卡 id 稳定排序）；
 * - `reviewBlockFor()` 给出"现在插复习、还是先收束"的判定（每节课最多打断一次）；
 * - `reviewDirectiveFor()` 把结果渲染成模型可照做的指令。
 *
 * ## 诚实口径（沿用 `Metric<T>` 的约束）
 *
 * - `overdueDays` 只由 `nextReviewAt` 与 `now` 计算，**不猜**；
 * - `cardDays` 只由 `srs-review` 证据行推导（而不是另一个模块里的数组字段）。
 *   这一点是必须的：`growth/stats.ts` 原先依赖 `FlashcardLike.reviewHistory`，
 *   而生产调用点恒传空数组，导致"复习天数/已复习卡"在真实运行里恒为 0。
 */

import type { Evidence } from '../knowledge/evidence.ts'
import { orderEvidence } from '../knowledge/evidence.ts'
import type { SrsState } from './srs.ts'
import { dayKey } from './srs.ts'

/** 计数上限：超过这个数只是"多次"，不影响教学决策，避免把大数字带进提示。 */
export const INTERRUPT_MAX_AGAIN = 2
const MS_PER_DAY = 86_400_000

/** 待复习卡的只读视图（存储层记录与 core 视图之间的最小交集）。 */
export type ReviewCard = {
  readonly id: string
  readonly nodeId?: string
  readonly srs: Pick<SrsState, 'nextReviewAt' | 'practiceCount'>
}

export type ReviewCandidate = {
  readonly cardId: string
  /** 卡片所属节点（无节点绑定则为 undefined）。 */
  readonly nodeId?: string
  /** 是否到期（无排期视为到期，与 `isDue()` 同义）。 */
  readonly due: boolean
  /** 逾期天数；未到期为 0，无排期按 0 计（新卡不算逾期）。 */
  readonly overdueDays: number
  /** 该节点已有几次复习记录（来自 srs-review 证据，不是自报）。 */
  readonly reviewCount: number
  /** 最近一次复习结果；从未复习则为 undefined。 */
  readonly lastResult?: string
  /** 该节点尝试过但尚无一次成功（由证据推出）。 */
  readonly nodeHasNoSuccess: boolean
  readonly reason: string
}

export type ReviewPlan = {
  /** 有序队列：逾期越久越靠前，同分按 cardId 稳定排序。 */
  readonly queue: readonly ReviewCandidate[]
  /** 同一节点下有多张卡：提示可以合并成一次提问。 */
  readonly mergedByNode: readonly { readonly nodeId: string; readonly cardIds: readonly string[] }[]
  readonly totalCards: number
  /** 从未复习过的卡（新卡）数量 —— 新卡不是"复习"，是第一次练习。 */
  readonly freshCards: number
  /** 到期卡数量。 */
  readonly dueCards: number
  /** 计划口径：`due` 按逾期排序 / `node` 围绕当前知识点（供指令选择话术）。 */
  readonly focus: 'due' | 'node'
}

/** 逾期天数（整数，向下取整；未来日期为 0）。使用日期键比较，避免时区与小时误差。 */
export function overdueDays(nextReviewAt: string | null | undefined, now: Date): number {
  if (!nextReviewAt) return 0
  const due = dayKey(nextReviewAt)
  const today = dayKey(now)
  if (due >= today) return 0
  const dueTime = Date.parse(`${due}T00:00:00.000Z`)
  const nowTime = Date.parse(`${today}T00:00:00.000Z`)
  if (!Number.isFinite(dueTime) || !Number.isFinite(nowTime)) return 0
  return Math.max(0, Math.round((nowTime - dueTime) / MS_PER_DAY))
}

/** 该节点尝试过的卡片 id（来自 `flashcard` / `srs-review` 证据，按时间序）。 */
export function attemptedCardIds(evidence: readonly Evidence[], nodeId: string): readonly string[] {
  const ids: string[] = []
  for (const item of orderEvidence(evidence)) {
    if (item.nodeId !== nodeId) continue
    if (item.kind !== 'flashcard' && item.kind !== 'srs-review') continue
    if (!ids.includes(item.sourceId)) ids.push(item.sourceId)
  }
  return ids
}

/** 按节点统计"已尝试但还没有成功记录"的情况 —— 用于把到期卡排到该节点前。 */
export type ReviewGap = {
  readonly nodeId: string
  readonly attempted: number
  readonly passed: number
}

export function nodeReviewGap(evidence: readonly Evidence[], nodeId: string): ReviewGap {
  let attempted = 0
  let passed = 0
  for (const item of evidence) {
    if (item.nodeId !== nodeId) continue
    if (item.kind !== 'flashcard' && item.kind !== 'srs-review') continue
    attempted += 1
    if (item.correct === true || item.srsResult === 'good') passed += 1
  }
  return { nodeId, attempted, passed }
}

/**
 * 生成复习计划。
 *
 * @param cards 卡片记录（含 SRS 状态）。
 * @param options.now 判定基准时刻；`nodeIds` 限定节点范围；`nodeId` 把该节点的卡排到最前；
 *   `limit` 截断队列长度（默认 20）；`evidence` 用于推导"该节点尚无成功记录"与新卡判定。
 */
export function buildReviewPlan(
  cards: readonly ReviewCard[],
  options: {
    readonly now?: Date
    readonly nodeIds?: readonly string[]
    readonly nodeId?: string
    readonly limit?: number
    readonly evidence?: readonly Evidence[]
  } = {},
): ReviewPlan {
  const now = options.now ?? new Date()
  const limit = options.limit ?? 20
  const scope = options.nodeIds ? new Set(options.nodeIds) : undefined
  const evidence = options.evidence ?? []

  const candidates: ReviewCandidate[] = []
  let freshCards = 0

  for (const card of cards) {
    if (scope && (!card.nodeId || !scope.has(card.nodeId))) continue
    const due = !card.srs.nextReviewAt || dayKey(card.srs.nextReviewAt) <= dayKey(now)
    if (!due) continue

    const overdue = overdueDays(card.srs.nextReviewAt, now)
    const fresh = card.srs.practiceCount === 0
    if (fresh) freshCards += 1

    const gap = card.nodeId ? nodeReviewGap(evidence, card.nodeId) : undefined
    const nodeHasNoSuccess = Boolean(gap && gap.attempted > 0 && gap.passed === 0)
    const reason = fresh
      ? '新卡：第一次练习（不是复习）'
      : overdue > 0
        ? `逾期 ${overdue} 天`
        : '今日到期'
    candidates.push({
      cardId: card.id,
      nodeId: card.nodeId,
      due: true,
      overdueDays: overdue,
      reviewCount: card.srs.practiceCount,
      lastResult: lastReviewResult(evidence, card),
      nodeHasNoSuccess,
      reason: nodeHasNoSuccess ? `${reason}；该节点尚无成功记录` : reason,
    })
  }

  // 排序：同一知识点的卡先来（若指定）→ 逾期越久越靠前 → cardId 稳定排序
  const focusNode = options.nodeId
  const queue = [...candidates]
    .sort((left, right) => {
      if (focusNode) {
        const leftHit = left.nodeId === focusNode ? 0 : 1
        const rightHit = right.nodeId === focusNode ? 0 : 1
        if (leftHit !== rightHit) return leftHit - rightHit
      }
      if (left.overdueDays !== right.overdueDays) return right.overdueDays - left.overdueDays
      return left.cardId < right.cardId ? -1 : left.cardId > right.cardId ? 1 : 0
    })
    .slice(0, Math.max(0, limit))

  const byNode = new Map<string, string[]>()
  for (const item of queue) {
    if (!item.nodeId) continue
    const list = byNode.get(item.nodeId) ?? []
    list.push(item.cardId)
    byNode.set(item.nodeId, list)
  }
  const mergedByNode = [...byNode.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([nodeId, cardIds]) => ({ nodeId, cardIds: [...cardIds].sort() }))
    .sort((left, right) => (left.nodeId < right.nodeId ? -1 : 1))

  return {
    queue,
    mergedByNode,
    totalCards: cards.length,
    freshCards,
    dueCards: candidates.length,
    focus: focusNode ? 'node' : 'due',
  }
}

function lastReviewResult(evidence: readonly Evidence[], card: ReviewCard): string | undefined {
  let latest: Evidence | undefined
  for (const item of orderEvidence(evidence)) {
    if (item.kind !== 'srs-review') continue
    if (item.sourceId !== card.id && !item.sourceId.startsWith(`${card.id}-`)) continue
    latest = item
  }
  return latest?.result
}

/**
 * 是否应该打断当前知识点，插入复习。
 *
 * 规则（可测，不是"看情况"）：
 * - 当前节点连续答错 ≥ {@link INTERRUPT_MAX_AGAIN} 次 → 打断（继续追问只会加深挫败）；
 * - 有到期卡且**当前节点**恰好有卡到期 → 打断（同一节点上复习最省认知成本）；
 * - 其余情况不打断（复习留到收束）。
 *
 * 刻意不做字符串匹配：判定只读结构字段（`nodeId` / `overdueDays`）。
 */
export function shouldInterrupt(
  plan: ReviewPlan,
  current: { readonly nodeId?: string; readonly consecutiveAgain?: number } = {},
): boolean {
  if ((current.consecutiveAgain ?? 0) >= INTERRUPT_MAX_AGAIN) return true
  if (!current.nodeId) return false
  return plan.queue.some((item) => item.nodeId === current.nodeId)
}

/**
 * 生成复习环节的指令。
 *
 * @param plan 复习计划。
 * @param options.interrupt 是否是打断当前知识点（影响话术：打断时必须先说明"我们停一下"）。
 */
export function reviewDirectiveFor(plan: ReviewPlan, options: { readonly interrupt?: boolean } = {}): string {
  if (plan.dueCards === 0) {
    return plan.totalCards === 0
      ? '当前没有卡片：讲完一个知识点后可以提议建一张卡（需要征得同意），不要凭空生成一堆题。'
      : '今天没有到期卡，不要为了"完成任务"提前复习；把时间留给当前知识点。'
  }
  const head = options.interrupt
    ? '先停一下当前知识点，插入一次复习（答错会把掌握度信号带回来）。'
    : '本点收束前插入一次复习。'
  const fresh = plan.freshCards > 0 ? `其中 ${plan.freshCards} 张是新卡（第一次练习，不是复习）。` : ''
  const merged = plan.mergedByNode.length > 0 ? '同一知识点有多张卡时合并成一次提问，不要连问三遍同一件事。' : ''
  return `${head}到期 ${plan.dueCards} 张 / 共 ${plan.totalCards} 张，按逾期最久的先来。${fresh}${merged}`.trim()
}

/** 复习计划的可读摘要（供 `study_progress` 与 `/socratic` 复用）。 */
export function renderReviewPlan(plan: ReviewPlan): string {
  if (plan.totalCards === 0) return '暂无卡片'
  if (plan.dueCards === 0) return `共 ${plan.totalCards} 张，今日无到期`
  const top = plan.queue.slice(0, 3).map((item) => `${item.cardId}（${item.reason}）`)
  return `到期 ${plan.dueCards} / 共 ${plan.totalCards}：${top.join('、')}`
}

/**
 * 复习天数与已复习卡数 —— 只来自 `srs-review` 证据行。
 *
 * 这是 `growth/stats.ts` 里那条 `reviewHistory` 死接线的替代口径：
 * 生产调用点原先恒传 `reviewHistory: []`，于是这两个数字永远是 0。
 * 证据行自带时间戳与结果，是真实数据里唯一可靠的一手来源。
 */
export function reviewActivity(evidence: readonly Evidence[]): {
  readonly reviewDays: number
  readonly reviewedCards: number
  readonly again: number
  readonly hard: number
  readonly good: number
} {
  const days = new Set<string>()
  const cards = new Set<string>()
  let again = 0
  let hard = 0
  let good = 0
  for (const item of evidence) {
    if (item.kind !== 'srs-review') continue
    days.add(item.createdAt.slice(0, 10))
    cards.add(item.sourceId.split('-srs-')[0] ?? item.sourceId)
    if (item.result === 'again') again += 1
    else if (item.result === 'hard') hard += 1
    else if (item.result === 'good') good += 1
  }
  return { reviewDays: days.size, reviewedCards: cards.size, again, hard, good }
}
