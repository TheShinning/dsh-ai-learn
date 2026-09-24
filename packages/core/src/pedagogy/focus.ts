/**
 * 焦点选择 —— "这一轮推进哪一个知识点"的唯一判定。
 *
 * ## 为什么不能复用 `buildRouteStops()`
 *
 * `buildRouteStops()` 是**评分排序**（困惑 100 / 未点亮 62 / 半掌握 42 / 已掌握 8，先修未点亮 −50），
 * 适合给用户列"候选路线"。但苏格拉底模式需要的是**单一焦点 + 可解释的理由**：
 * 为什么是它、而不是别的？这个理由要能直接变成一句话讲给学生听，也要能写进课堂记录。
 *
 * 所以本模块的分工是：
 * - 继承同一套证据口径（`buildMasteryIndex()`、`prerequisitesReady()`）—— 不另算掌握度；
 * - 但判定顺序是**硬优先级**（困惑 > 到期复习 > 先修缺口 > 未点亮 > 复盘），同档内按既有稳定排序键；
 * - 输出 `FocusReason` + `detail` + `directive`，把"为什么"变成数据。
 *
 * 与 `docs/socratic-teaching-mode-plan.md` §3c 的对应：`TeachingStrategy.focusBias` 只影响
 * **同档内的偏好**（例如刷题模式优先有错题的节点），不改变档位顺序 —— 档位顺序是跨模式底线。
 */

import type { Mastery } from '../types.ts'
import type { KnowledgeGraph, KnowledgeNode } from '../knowledge/graph.ts'
import { buildMasteryIndex, prerequisitesReady } from '../knowledge/graph.ts'
import type { Evidence } from '../knowledge/evidence.ts'
import { orderEvidence } from '../knowledge/evidence.ts'
import type { ReviewPlan } from '../review/plan.ts'

/** 焦点理由。档位顺序即 {@link selectFocusNode} 的判定顺序。 */
export type FocusReason = 'confused' | 'due-review' | 'prerequisite-gap' | 'unlit' | 'review-mastered' | 'empty'

export const FOCUS_REASON_LABEL: Record<FocusReason, string> = {
  confused: '困惑点优先澄清',
  'due-review': '到期复习',
  'prerequisite-gap': '先修未满足',
  unlit: '尚未点亮',
  'review-mastered': '已点亮的低频复盘',
  empty: '暂无可推进节点',
}

export type FocusDecision = {
  readonly reason: FocusReason
  readonly nodeId?: string
  readonly title?: string
  readonly mastery?: Mastery
  /** 该节点已有多少条证据（用于解释"为什么是它"）。 */
  readonly evidenceCount: number
  /** 未点亮的先修节点标题（仅 `prerequisite-gap` 非空）。 */
  readonly unresolvedPrerequisites: readonly string[]
  /** 一句话解释，可直接讲给学生听。 */
  readonly detail: string
  /** 给模型照做的指令。 */
  readonly directive: string
}

/** 容器型节点不是可推进的学习单元（与 `graph.ts` 的 KEEP 口径一致）。 */
const CONTAINER_TYPES: ReadonlySet<KnowledgeNode['type']> = new Set(['textbook', 'chapter'])

/** 与 `graph.ts:nodeSortKey()` 同口径的稳定排序键（章节序 → 节序 → 页序 → 标题 → id）。 */
function sortKey(node: KnowledgeNode): string {
  const typeRank = node.type === 'chapter' ? '1' : node.type === 'section' ? '2' : node.type === 'page' ? '3' : '4'
  return [typeRank, node.chapterId ?? '', node.sectionId ?? '', node.pageId ?? '', node.title, node.id].join('/')
}

/** 图里可作为学习单元的节点。 */
export function studyNodes(graph: KnowledgeGraph): readonly KnowledgeNode[] {
  return [...graph.nodes.filter((node) => !CONTAINER_TYPES.has(node.type))].sort((left, right) =>
    sortKey(left) < sortKey(right) ? -1 : sortKey(left) > sortKey(right) ? 1 : 0,
  )
}

function evidenceByNode(graph: KnowledgeGraph): Map<string, Evidence[]> {
  const map = new Map<string, Evidence[]>()
  for (const item of orderEvidence(graph.evidence)) {
    const list = map.get(item.nodeId)
    if (list) list.push(item)
    else map.set(item.nodeId, [item])
  }
  return map
}

/** 该节点是否有"困惑"信号（负面证据优先，与 `masteryFromEvidence` 的否决权一致）。 */
function hasConfusedSignal(items: readonly Evidence[] | undefined): boolean {
  return (items ?? []).some((item) => item.mastery === 'confused' || item.result === 'clarify' || item.correct === false)
}

/** 该节点关联的先修边（只取 `prerequisite`，键为"被依赖的节点"）。 */
function prerequisiteEdges(graph: KnowledgeGraph): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (edge.relation !== 'prerequisite') continue
    const list = map.get(edge.to)
    if (list) list.push(edge.from)
    else map.set(edge.to, [edge.from])
  }
  return map
}

export type FocusOptions = {
  /** 复习计划：用于把"有到期卡的节点"排在未点亮之前（复习优先于新内容）。 */
  readonly reviewPlan?: ReviewPlan
  /**
   * 同档内的额外偏好（来自 {@link TeachingStrategy.focusBias}）。
   * 只影响**同档内**的选择，不改变档位顺序。
   */
  readonly preferNodeIds?: readonly string[]
  /** 排除节点（例如刚刚讲完的）。 */
  readonly excludeNodeIds?: readonly string[]
}

/**
 * 选择本轮焦点。判定顺序（硬优先级，跨模式不覆盖）：
 *
 * 1. `confused` —— 有困惑信号的节点（负面证据否决权）；
 * 2. `due-review` —— 有到期卡的节点（先复习，再上新内容）；
 * 3. `prerequisite-gap` —— 有未点亮先修、且**先修本身可推进**的节点（先补基础）；
 * 4. `unlit` —— 尚未点亮的节点（已有证据者优先，与 `routeScore` 同口径）；
 * 5. `review-mastered` —— 已点亮节点（低频复盘用）；
 * 6. `empty` —— 没有任何可推进节点（零起点路径交给 `nextSocraticMove()`）。
 *
 * 同一档内：`preferNodeIds` 命中者优先，然后按 {@link sortKey} 稳定排序。
 */
export function selectFocusNode(
  graph: KnowledgeGraph,
  options: FocusOptions = {},
): FocusDecision {
  const nodes = studyNodes(graph).filter((node) => !(options.excludeNodeIds ?? []).includes(node.id))
  if (nodes.length === 0) {
    return {
      reason: 'empty',
      evidenceCount: 0,
      unresolvedPrerequisites: [],
      detail: '图谱里还没有可推进的学习单元。',
      directive: '先与用户锁定一份材料（导入文件、粘贴正文，或直接说一个想学的知识点），再开始提问。',
    }
  }

  const index = buildMasteryIndex(graph)
  const byNode = evidenceByNode(graph)
  const prereq = prerequisiteEdges(graph)
  const prefer = new Set(options.preferNodeIds ?? [])
  const dueNodeIds = new Set((options.reviewPlan?.queue ?? []).map((item) => item.nodeId).filter(Boolean))

  const pick = (candidates: readonly KnowledgeNode[]): KnowledgeNode | undefined => {
    if (candidates.length === 0) return undefined
    const preferred = candidates.filter((node) => prefer.has(node.id))
    const pool = preferred.length > 0 ? preferred : candidates
    return pool[0]
  }

  const masteryOf = (node: KnowledgeNode): Mastery => {
    const value = index[node.id]
    return value === undefined ? 'unknown' : value
  }
  const evidenceOf = (node: KnowledgeNode): number => byNode.get(node.id)?.length ?? 0

  const build = (reason: FocusReason, node: KnowledgeNode, extra: { unresolved?: readonly string[]; detail: string }, directive: string): FocusDecision => ({
    reason,
    nodeId: node.id,
    title: node.title,
    mastery: masteryOf(node),
    evidenceCount: evidenceOf(node),
    unresolvedPrerequisites: extra.unresolved ?? [],
    detail: extra.detail,
    directive,
  })

  // 1. 困惑
  const confused = pick(nodes.filter((node) => masteryOf(node) === 'confused' || hasConfusedSignal(byNode.get(node.id))))
  if (confused) {
    return build(
      'confused',
      confused,
      { detail: `「${confused.title}」出现过答错或困惑信号（证据 ${evidenceOf(confused)} 条），先澄清它。` },
      '先处理困惑点：用降阶阶梯（例子 → 二选一）确认卡在哪里，不要跳到新内容。',
    )
  }

  // 2. 到期复习
  const dueNode = pick(nodes.filter((node) => dueNodeIds.has(node.id)))
  if (dueNode) {
    return build(
      'due-review',
      dueNode,
      { detail: `「${dueNode.title}」有到期复习卡，复习优先于开新点。` },
      '先插入到期复习（答错会把掌握度信号带回来），再回到当前知识点。',
    )
  }

  // 3. 先修缺口：本节点未亮但先修也没亮 → 先补先修
  const gapCandidates = nodes.filter((node) => {
    if (masteryOf(node) === 'mastered') return false
    const prerequisites = prereq.get(node.id) ?? []
    if (prerequisites.length === 0) return false
    return !prerequisitesReady(graph, index, node.id)
  })
  const gap = pick(gapCandidates)
  if (gap) {
    const unresolved = (prereq.get(gap.id) ?? [])
      .map((from) => nodes.find((node) => node.id === from))
      .filter((node): node is KnowledgeNode => Boolean(node))
      .filter((node) => masteryOf(node) !== 'mastered')
      .map((node) => node.title)
    return build(
      'prerequisite-gap',
      gap,
      { unresolved, detail: `「${gap.title}」的先修（${unresolved.join('、') || '未知'}）尚未点亮，先补基础再推进。` },
      '先讲清未点亮的先修是什么、它解决了什么问题，再回到目标知识点；不要跳过先修硬讲目标。',
    )
  }

  // 4. 未点亮（有证据者优先，与 routeScore 同口径）
  const unlit = nodes.filter((node) => masteryOf(node) === 'unknown' || masteryOf(node) === 'partial')
  const withEvidence = pick(unlit.filter((node) => evidenceOf(node) > 0))
  const chosenUnlit = withEvidence ?? pick(unlit)
  if (chosenUnlit) {
    return build(
      'unlit',
      chosenUnlit,
      {
        detail:
          evidenceOf(chosenUnlit) > 0
            ? `「${chosenUnlit.title}」已有 ${evidenceOf(chosenUnlit)} 条证据但尚未点亮，继续推进它。`
            : `「${chosenUnlit.title}」尚未点亮，从它开始。`,
      },
      '一次只推进这一个点：先问后讲，点亮需要多元证据（复述 + 一次练习）。',
    )
  }

  // 5. 已点亮：低频复盘
  const mastered = pick(nodes)
  return build(
    'review-mastered',
    mastered!,
    { detail: `「${mastered!.title}」已点亮，可作为复盘或迁移练习。` },
    '当前没有未点亮的点。给一个迁移或变式问题（而不是重复原题），或与用户商量换一节内容。',
  )
}

/** 焦点理由 → 一句话策略（可直接进 context 节）。 */
export function focusReasonDirective(reason: FocusReason): string {
  switch (reason) {
    case 'confused':
      return '当前档位：困惑优先。降阶阶梯固定为"换例子 → 缩范围 → 二选一"，不要在困惑点上提高抽象度。'
    case 'due-review':
      return '当前档位：复习优先。先处理到期卡，再决定是否开新点。'
    case 'prerequisite-gap':
      return '当前档位：先修补基础。先讲清未点亮的先修，再回到目标知识点。'
    case 'unlit':
      return '当前档位：新内容推进。一次只推进一个点，点亮需要多元证据。'
    case 'review-mastered':
      return '当前档位：复盘。给迁移或变式问题，不要重复原题。'
    default:
      return '当前档位：零起点。先与用户锁定一份材料，再开始提问。'
  }
}

/** 把决策渲染成可读状态行（供 `study_steps` 与 `/socratic` 复用）。 */
export function renderFocus(decision: FocusDecision): string {
  if (!decision.nodeId) return `焦点：${FOCUS_REASON_LABEL[decision.reason]}｜${decision.detail}`
  return `焦点：${decision.title}｜${FOCUS_REASON_LABEL[decision.reason]}｜证据 ${decision.evidenceCount} 条｜${decision.detail}`
}
