/**
 * 课堂记录 —— 一节课的**快照**，以及"还不完善的点"的归因。
 *
 * ## 为什么必须有这个东西
 *
 * 系统此前只记住了**证据**，没记住**这节课**：能查到"某节点现在是什么掌握度"，
 * 查不到"这堂课走过哪些环节、当时结论是什么、哪一步没走完"。
 * 而学习复盘恰恰需要后者 —— 学生第二天想接着学，需要的是"上次停在哪"。
 *
 * ## 三条设计约束
 *
 * 1. **数字必须能指回证据**。记录里的每个计数都来自真实证据行与卡片状态，
 *    不允许出现"看起来不错的统计"。这与 `growth/stats.ts` 的 `Metric<T>` 同源。
 * 2. **记录是 write-once 快照**。生成之后再写新证据**不改写它** ——
 *    "同一份数据两个结论"正是原系统最贵的病，历史结论必须冻结。
 * 3. **缺口要归因、要带下一步**，不能只报"有困惑"。四类：混淆 / 问了没答 /
 *    材料本身残缺 / 系统缺口（该建卡却没建）。猜测项必须标成启发式。
 */

import type { Mastery } from './types.ts'
import type { Evidence } from './knowledge/evidence.ts'
import { orderEvidence } from './knowledge/evidence.ts'
import { masteryFromEvidence } from './knowledge/mastery.ts'
import type { KnowledgeNode } from './knowledge/graph.ts'
import { reviewActivity } from './review/plan.ts'

/** 缺口的四类归因。`source` 说明它是**证据事实**还是**系统/材料事实**。 */
export type ClassroomGapKind = 'confused-node' | 'unanswered' | 'material-defect' | 'system-gap'

export type ClassroomGapSource = 'evidence' | 'material' | 'system' | 'heuristic'

export const CLASSROOM_GAP_LABEL: Record<ClassroomGapKind, string> = {
  'confused-node': '概念混淆未澄清',
  unanswered: '问了没答上',
  'material-defect': '材料本身残缺',
  'system-gap': '该建卡却没建',
}

export type ClassroomGap = {
  readonly kind: ClassroomGapKind
  readonly source: ClassroomGapSource
  /** 涉及的知识点标题（材料/系统类缺口可能没有）。 */
  readonly nodeId?: string
  readonly title?: string
  /** 一句话说明，可直接念给学生听。 */
  readonly detail: string
  /** 可执行的下一步。 */
  readonly nextStep: string
}

export type ClassroomStep = {
  readonly step: string
  readonly at: string
  readonly action: string
}

export type ClassroomNodeEntry = {
  readonly nodeId: string
  readonly title: string
  readonly mastery: Mastery
  /** 该节点的证据 id —— **引用**，不复制证据内容（留痕靠证据表本身）。 */
  readonly evidenceIds: readonly string[]
}

export type ClassroomRecord = {
  readonly id: string
  readonly textbookKey: string
  readonly title: string
  /** 材料类型与教学模式（解自教材的复合 `sourceFormat`）；未识别时为空串。 */
  readonly materialType: string
  readonly mode: string
  readonly startedAt: string
  readonly endedAt: string
  /** 本堂课真实走过的环节（顺序即发生顺序）。 */
  readonly steps: readonly ClassroomStep[]
  readonly nodesTouched: readonly ClassroomNodeEntry[]
  readonly evidenceIds: readonly string[]
  /** 学生作答次数（answer-quality 里非复述的那些）。 */
  readonly answered: number
  /** 导师直讲次数（`result === 'light'` 且带 mastery 的那些视为讲解后确认）。 */
  readonly explained: number
  /** 复述次数与通过次数。 */
  readonly retold: number
  readonly retoldPassed: number
  readonly review: { readonly submitted: number; readonly again: number; readonly hard: number; readonly good: number }
  readonly gaps: readonly ClassroomGap[]
  readonly summary: string
  readonly nextEntry: string
}

export type ClassroomRecordInput = {
  readonly textbookKey: string
  readonly title: string
  readonly materialType?: string
  readonly mode?: string
  readonly steps: readonly ClassroomStep[]
  readonly evidence: readonly Evidence[]
  readonly nodes: readonly KnowledgeNode[]
  readonly cards?: readonly { readonly id: string; readonly nodeId?: string | null }[]
  /** 教材解析状态；`failed` / `parsing` 或 `parseError` 非空时记为材料缺陷。 */
  readonly parseStatus?: string
  readonly parseError?: string | null
  /** 是否导入时被标为 partial（例如扫描件只取到标题）。 */
  readonly partial?: boolean
  readonly startedAt?: string
  readonly endedAt?: string
  readonly now?: Date
}

/** 证据是否只属于本节课（按时间窗判定；时间缺失时按全量）。 */
function withinWindow(item: Evidence, from: string, to: string): boolean {
  return item.createdAt >= from && item.createdAt <= to
}

/**
 * 找"还不完善的点"。
 *
 * 四条判定都用真实数据；`heuristic` 只在无法定论时使用，并且**必须**在 detail 里说明是猜测。
 */
export function findGaps(input: {
  readonly evidence: readonly Evidence[]
  readonly nodes: readonly KnowledgeNode[]
  readonly cards?: readonly { readonly id: string; readonly nodeId?: string | null }[]
  readonly parseStatus?: string
  readonly parseError?: string | null
  readonly partial?: boolean
}): readonly ClassroomGap[] {
  const gaps: ClassroomGap[] = []
  const nodeTitle = (nodeId: string): string | undefined => input.nodes.find((node) => node.id === nodeId)?.title
  const byNode = new Map<string, Evidence[]>()
  for (const item of input.evidence) {
    const list = byNode.get(item.nodeId)
    if (list) list.push(item)
    else byNode.set(item.nodeId, [item])
  }

  // 1. 混淆未澄清：有答错/困惑证据，且该节点至今没有**两种**不同正向证据（即未点亮）
  for (const [nodeId, items] of byNode) {
    const mastery = masteryFromEvidence(items)
    const hasConfused = items.some((item) => item.mastery === 'confused' || item.correct === false || item.result === 'clarify')
    if (mastery === 'confused' || (hasConfused && mastery !== 'mastered')) {
      gaps.push({
        kind: 'confused-node',
        source: 'evidence',
        nodeId,
        title: nodeTitle(nodeId),
        detail: `「${nodeTitle(nodeId) ?? nodeId}」出现过答错或困惑，至今未点亮（证据 ${items.length} 条）。`,
        nextStep: '下一节课从这里开始，且**追问深度不归零**：先给例子或二选一，不要重新从定义问起。',
      })
    }
  }

  // 2. 问了没答上：有 question-asked 证据，但其后没有对应的作答证据
  for (const [nodeId, items] of byNode) {
    const ordered = orderEvidence(items)
    const asked = ordered.filter((item) => item.kind === 'question-asked')
    if (asked.length === 0) continue
    const answered = ordered.filter((item) => item.kind === 'answer-quality' && item.correct !== undefined)
    const lastAsk = asked[asked.length - 1]!
    const answeredAfter = answered.some((item) => item.createdAt >= lastAsk.createdAt)
    if (!answeredAfter) {
      gaps.push({
        kind: 'unanswered',
        source: 'evidence',
        nodeId,
        title: nodeTitle(nodeId),
        detail: `「${nodeTitle(nodeId) ?? nodeId}」最后问出去的问题没有对应的作答记录。`,
        nextStep: '先降低难度（换例子或二选一）再问一次，并把学生的回答记成证据 —— 没有作答记录就无法判断卡在哪里。',
      })
    }
  }

  // 3. 材料残缺：解析未就绪 / 部分内容 / 有解析错误
  if (input.parseStatus !== undefined && input.parseStatus !== 'ready') {
    gaps.push({
      kind: 'material-defect',
      source: 'material',
      detail: `教材解析状态为「${input.parseStatus}」，正文可能不完整。`,
      nextStep: '重新导入或换一份材料；若为扫描件，需先 OCR（`study_formats` 会说明本机缺什么依赖）。',
    })
  } else if (input.parseError) {
    gaps.push({
      kind: 'material-defect',
      source: 'material',
      detail: `教材解析时报错：${input.parseError}`,
      nextStep: '确认文件完好后重新导入；必要时改用粘贴正文。',
    })
  } else if (input.partial) {
    gaps.push({
      kind: 'material-defect',
      source: 'material',
      detail: '这份材料只取到了部分内容（例如扫描件只拿到标题），后面可能缺正文。',
      nextStep: '补齐依赖后重新导入，或把缺的部分作为图片附件交给视觉模型。',
    })
  }

  // 4. 系统缺口：已点亮（有 ≥2 种正向证据）却没有卡片
  const cardNodeIds = new Set((input.cards ?? []).map((card) => card.nodeId).filter(Boolean) as string[])
  for (const [nodeId, items] of byNode) {
    if (masteryFromEvidence(items) !== 'mastered') continue
    if (cardNodeIds.has(nodeId)) continue
    gaps.push({
      kind: 'system-gap',
      source: 'system',
      nodeId,
      title: nodeTitle(nodeId),
      detail: `「${nodeTitle(nodeId) ?? nodeId}」已点亮，但还没有对应的复习卡 —— 没有排期就一定会忘。`,
      nextStep: '补建一张卡（选择/填空/简答/口诀都可以），然后交给 SRS 排期。',
    })
  }

  return gaps
}

/**
 * 生成课堂记录（纯函数；`write-once` 语义由**调用方**保证：只生成一次、不回填）。
 */
export function buildClassroomRecord(input: ClassroomRecordInput): ClassroomRecord {
  const now = input.now ?? new Date()
  const orderedAll = orderEvidence(input.evidence)
  const endedAt = input.endedAt ?? now.toISOString()
  /**
   * 缺省起点：**最后一条证据之前**留一个宽限窗，而不是"首条证据的时间"。
   *
   * 曾经写成首条证据时间，结果是"很久以前的历史证据"也被算进本节课（测试抓到了这一点）。
   * 语义应当是："没显式给起点时，把最近这一段当作一节课"。
   * 需要精确的节次边界时，调用方应显式传 `startedAt`（工具层从留痕的第一步取）。
   */
  const lastEvidenceAt = orderedAll[orderedAll.length - 1]?.createdAt
  const fallbackStart = lastEvidenceAt
    ? new Date(Math.max(0, Date.parse(lastEvidenceAt) - 90 * 60 * 1000)).toISOString()
    : endedAt
  const startedAt = input.startedAt ?? fallbackStart
  const sessionEvidence = orderedAll.filter((item) => withinWindow(item, startedAt, endedAt))

  const byNode = new Map<string, Evidence[]>()
  for (const item of sessionEvidence) {
    const list = byNode.get(item.nodeId)
    if (list) list.push(item)
    else byNode.set(item.nodeId, [item])
  }

  const nodesTouched: ClassroomNodeEntry[] = [...byNode.entries()]
    .map(([nodeId, items]) => ({
      nodeId,
      title: input.nodes.find((node) => node.id === nodeId)?.title ?? nodeId,
      // 掌握度用**该节点的全部证据**算（不只本节）—— 掌握度是证据集合的纯函数，截断会得出错误结论
      mastery: masteryFromEvidence(input.evidence.filter((item) => item.nodeId === nodeId)),
      evidenceIds: items.map((item) => item.id),
    }))
    .sort((left, right) => (left.title < right.title ? -1 : left.title > right.title ? 1 : 0))

  const answers = sessionEvidence.filter((item) => item.kind === 'answer-quality' && item.result !== 'retell')
  const retells = sessionEvidence.filter((item) => item.kind === 'answer-quality' && item.result === 'retell')
  const explained = sessionEvidence.filter((item) => item.kind === 'question-asked' && item.result === 'ask')
  const activity = reviewActivity(sessionEvidence)

  const gaps = findGaps({
    evidence: input.evidence,
    nodes: input.nodes,
    cards: input.cards,
    parseStatus: input.parseStatus,
    parseError: input.parseError,
    partial: input.partial,
  })

  const summaryParts = [
    `本节围绕 ${nodesTouched.length} 个知识点，记录 ${sessionEvidence.length} 条证据`,
    answers.length > 0 ? `学生作答 ${answers.length} 次` : '学生未作答',
    retells.length > 0 ? `复述 ${retells.length} 次（通过 ${retells.filter((item) => item.correct === true).length} 次）` : '',
    activity.reviewedCards > 0 ? `复习 ${activity.reviewedCards} 张卡` : '',
  ].filter((part) => part.length > 0)

  return {
    id: `session-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    textbookKey: input.textbookKey,
    title: input.title,
    materialType: input.materialType ?? '',
    mode: input.mode ?? '',
    startedAt,
    endedAt,
    steps: [...input.steps],
    nodesTouched,
    evidenceIds: sessionEvidence.map((item) => item.id),
    answered: answers.length,
    explained: explained.length,
    retold: retells.length,
    retoldPassed: retells.filter((item) => item.correct === true).length,
    review: { submitted: activity.reviewedCards, again: activity.again, hard: activity.hard, good: activity.good },
    gaps,
    summary: `${summaryParts.join('；')}。`,
    nextEntry:
      gaps.length > 0
        ? `下一步：${gaps[0]!.nextStep}`
        : nodesTouched.some((entry) => entry.mastery !== 'mastered')
          ? '下一步：继续推进本教材里尚未点亮的节点（困惑点优先）。'
          : '下一步：本教材的知识点均已点亮，可做迁移练习或换一节内容。',
  }
}

/** 渲染成 Markdown —— 落盘产物与 `/socratic` 输出共用同一份，保证"看到的就是存下的"。 */
export function renderClassroomRecord(record: ClassroomRecord): string {
  const head: string[] = [
    `# 课堂记录 · ${record.title}`,
    '',
    `- 时间：${record.startedAt} → ${record.endedAt}`,
    `- 教材：${record.textbookKey}`,
  ]
  if (record.materialType) head.push(`- 材料类型：${record.materialType}${record.mode ? `｜教学模式：${record.mode}` : ''}`)
  head.push(`- 概览：${record.summary}`, '')

  const lines: string[] = [...head]

  if (record.steps.length > 0) {
    lines.push('## 课堂过程', '')
    for (const step of record.steps) lines.push(`- ${step.at}｜${step.step}｜${step.action}`)
    lines.push('')
  }

  lines.push('## 涉及的知识点', '')
  if (record.nodesTouched.length === 0) {
    lines.push('- （本节没有产生证据）')
  } else {
    for (const entry of record.nodesTouched) {
      lines.push(`- ${entry.title}｜掌握度 ${entry.mastery}｜证据 ${entry.evidenceIds.length} 条（${entry.evidenceIds.join(', ')}）`)
    }
  }
  lines.push('')

  lines.push('## 还不完善的点', '')
  if (record.gaps.length === 0) {
    lines.push('- （无：本节没有未澄清的困惑、没有悬空提问、材料与卡片都齐）')
  } else {
    for (const gap of record.gaps) {
      const sourceLabel =
        gap.source === 'evidence' ? '证据' : gap.source === 'material' ? '材料' : gap.source === 'system' ? '系统' : '启发式估计'
      lines.push(`- **${CLASSROOM_GAP_LABEL[gap.kind]}**（${sourceLabel}）${gap.title ? `「${gap.title}」` : ''}：${gap.detail}`)
      lines.push(`  - 下一步：${gap.nextStep}`)
    }
  }
  lines.push('')

  lines.push('## 复习', '')
  lines.push(
    `- 本节提交复习 ${record.review.submitted} 张：again ${record.review.again}｜hard ${record.review.hard}｜good ${record.review.good}`,
  )
  lines.push('')
  lines.push(`> ${record.nextEntry}`)
  lines.push('')
  lines.push('<!-- 本记录是快照：生成后再产生的证据不会改写它。 -->')
  return lines.join('\n')
}

/**
 * 课堂记录的文件名（工作区相对路径）。
 *
 * 用日期前缀保证按时间排序，标题做文件名净化（去掉路径分隔符与控制字符）。
 */
export function classroomRecordPath(record: ClassroomRecord, dir = '.study/records'): string {
  const date = record.endedAt.slice(0, 10)
  const safeTitle = record.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 60)
  return `${dir}/${date}-${safeTitle}.md`
}
