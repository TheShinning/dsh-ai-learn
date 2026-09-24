/**
 * 学习卡片模型与判定。
 *
 * ## 原系统的问题：「口诀卡有资产、无复习」
 *
 * 7-31 落地的"分级伴读 → 口诀候选 → 确认后写入闪卡"链路，
 * 在 `learning.mnemonicAssets.ts:21` 生成的卡片是 `options: []`；
 * 而**三处闸门**都要求 `options.length > 0` 才认这张卡：
 * - `learning/flashcardWindow.ts:52`（组牌组）
 * - `LearningFlashcardFloatingWindow.tsx:62`（练习渲染）
 * - `learning/assetsBridge.ts:394`（资产还原成卡）
 *
 * 于是口诀卡能进库、能在闪卡库窗口列出来，**永远无法被练习、也不进 SRS 队列**。
 * 根因不是漏了一个过滤器，而是把"卡片"隐含定义为"选择题"。
 *
 * ## 修法：卡片是判别联合，练习方式由类型决定
 *
 * 选择题自动判分；填空/简答/口诀走自评（again / hard / good）。
 * `isPracticable()` 对四种卡都返回 true —— 判分方式不同，不等于不能复习。
 */

import type { SrsResult } from '../knowledge/evidence.ts'

export type Choice = {
  readonly key: string
  readonly text: string
}

type CardBase = {
  readonly id: string
  /** 承载它的教材（稳定 key，见 textbook/identity.ts）。 */
  readonly textbookKey?: string
  readonly chapterId?: string
  readonly sectionId?: string
  readonly nodeId?: string
  /** 教材锚点，用于"回到原文"。 */
  readonly anchor?: string
  readonly createdAt: string
}

/** 选择题：可自动判分。 */
export type ChoiceCard = CardBase & {
  readonly kind: 'choice'
  readonly prompt: string
  readonly options: readonly Choice[]
  readonly answerKey: string
  readonly explanation?: string
}

/** 填空题：答案唯一但用户自由输入，走自评。 */
export type ClozeCard = CardBase & {
  readonly kind: 'cloze'
  readonly prompt: string
  readonly answer: string
  readonly explanation?: string
}

/** 简答题：走自评。 */
export type ShortAnswerCard = CardBase & {
  readonly kind: 'short-answer'
  readonly prompt: string
  readonly answer: string
  readonly explanation?: string
}

/**
 * 记忆口诀卡：走自评。
 *
 * 这是原系统断链的那一类。它**天生没有选项**，因此任何"必须有选项"的
 * 隐式假设都会把它排除在复习之外。
 */
export type MnemonicCard = CardBase & {
  readonly kind: 'mnemonic'
  readonly prompt: string
  readonly answer: string
  /** 口诀服务的知识点。 */
  readonly knowledgePoint: string
  /** 适用范围（法条/章节等）。 */
  readonly scope?: string
}

export type StudyCard = ChoiceCard | ClozeCard | ShortAnswerCard | MnemonicCard

export type CardKind = StudyCard['kind']

export const CARD_KIND_LABEL: Record<CardKind, string> = {
  choice: '选择题',
  cloze: '填空题',
  'short-answer': '简答题',
  mnemonic: '记忆口诀',
}

/** 判定方式：选择题自动，其余自评。 */
export type JudgementMode = 'auto' | 'self-report'

export function judgementMode(card: StudyCard): JudgementMode {
  return card.kind === 'choice' ? 'auto' : 'self-report'
}

/**
 * 这张卡是否可进入练习/复习。
 *
 * 四种卡都可练习。**唯一**的排除条件是缺少题面或答案 —— 这是内容完整性问题，
 * 与卡片类型无关。
 */
export function isPracticable(card: StudyCard): boolean {
  if (!card.prompt.trim()) return false
  if (card.kind === 'choice') {
    if (!card.answerKey.trim()) return false
    // 选择题必须有可选项才谈得上"选"
    return card.options.length > 0
  }
  return card.answer.trim().length > 0
}

/** 不可练习的原因，用于 UI 提示而不是静默丢弃。 */
export function impracticableReason(card: StudyCard): string | undefined {
  if (!card.prompt.trim()) return '缺少题面'
  if (card.kind === 'choice') {
    if (!card.answerKey.trim()) return '缺少正确选项标识'
    if (card.options.length === 0) return '选择题没有选项'
    return undefined
  }
  if (!card.answer.trim()) return '缺少答案'
  return undefined
}

/**
 * 从答案文本推断选择题的正确选项 key。
 *
 * 对齐原系统 `lib/learningFlashcards.ts:266-278` 的策略：
 * 1. 答案以 A–D（可带 `A.` / `A、`）开头 → 取该字母；
 * 2. 否则把答案与各选项文本做去空白/小写后的双向包含匹配。
 *
 * @returns 命中的 key；无法判定时返回 `undefined`（调用方应回退到自评，而不是判错）。
 */
export function resolveChoiceKey(card: ChoiceCard): string | undefined {
  const answer = card.answerKey.trim()
  const leading = answer.match(/^([A-Za-z])[.、．)）:：]?/)
  if (leading) {
    const key = leading[1]!.toUpperCase()
    if (card.options.some((option) => option.key.toUpperCase() === key)) return key
  }
  const normalized = normalizeForMatch(answer)
  if (!normalized) return undefined
  const exact = card.options.find((option) => normalizeForMatch(option.text) === normalized)
  if (exact) return exact.key
  const contains = card.options.find((option) => {
    const text = normalizeForMatch(option.text)
    return text.length > 0 && (text.includes(normalized) || normalized.includes(text))
  })
  return contains?.key
}

function normalizeForMatch(value: string): string {
  return value
    .replace(/[*_`>#\s]/g, '')
    .replace(/[（(].*?[）)]/g, '')
    .toLowerCase()
}

/**
 * 判定一次作答。
 *
 * - 选择题：选对 → `good`；选错 → `again`；**无法判定正确项 → 交给调用方自评**
 *   （返回 `undefined`，而不是像原系统那样判成 `hard`，
 *   原系统 `LearningFlashcardFloatingWindow.tsx:28-34` 在无法推出正确键时直接判 `hard`，
 *   会把"题目没写清楚"记成"学生勉强答对"）；
 * - 其他类型：用调用方给的自评结果。
 */
export function judge(card: StudyCard, response: { selectedKey?: string; selfReport?: SrsResult }): SrsResult | undefined {
  if (card.kind === 'choice') {
    if (!response.selectedKey) return undefined
    const correctKey = resolveChoiceKey(card)
    if (!correctKey) return undefined
    return response.selectedKey.toUpperCase() === correctKey.toUpperCase() ? 'good' : 'again'
  }
  return response.selfReport
}

/** 由题干与答案构造一个口诀卡（供伴读链路直接调用，避免再次写出 `options: []` 的死链）。 */
export function mnemonicCard(input: {
  id: string
  knowledgePoint: string
  prompt: string
  answer: string
  scope?: string
  textbookKey?: string
  nodeId?: string
  anchor?: string
  now?: string
}): MnemonicCard {
  return {
    kind: 'mnemonic',
    id: input.id,
    prompt: input.prompt,
    answer: input.answer,
    knowledgePoint: input.knowledgePoint,
    scope: input.scope,
    textbookKey: input.textbookKey,
    nodeId: input.nodeId,
    anchor: input.anchor,
    createdAt: input.now ?? new Date().toISOString(),
  }
}
