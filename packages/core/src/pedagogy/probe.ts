/**
 * 追问深度状态机（probeState）。
 *
 * ## 保留的设计（原系统做得对的部分）
 *
 * 追问深度**不是**模型自报的，而是从真实证据里数出来的：同一节点、同一语气
 * 连续出现多少条 `answer-quality` 证据。这是"追问从文字祈求变为系统状态"
 * 的核心兑现点，原系统 `learning.masteryEvaluator.ts:86-109` 的实现方向正确。
 *
 * ## 修复的点
 *
 * 原系统的 `deriveLearningProbeState` 只读图谱里的 answer-quality 证据，
 * 而"同一节点连续三次困惑 → 降阶"这个机制在真实会话里很难触发，因为
 * 评估器只在命中困惑词时才产出证据（`learning.masteryEvaluator.ts:226`），
 * 非困惑回答根本不产生 answer-quality 证据，streak 永远断掉。
 * 这里显式接收"每次评估的产出"，包括 `undefined`（未产出证据），
 * 让 streak 语义可测试、可解释。
 */

import type { EvidenceTone, ProbeDepth } from '../types.ts'
import { PROBE_DEPTH_MAX } from '../types.ts'
import type { Evidence } from '../knowledge/evidence.ts'
import { evidenceTone } from '../knowledge/evidence.ts'

export type ProbeState = {
  readonly nodeId?: string
  readonly probeDepth: ProbeDepth
  readonly lastEvidenceTone: EvidenceTone
  /** 连续同语气证据条数，用于解释深度是怎么来的。 */
  readonly streak: number
}

export const INITIAL_PROBE_STATE: ProbeState = {
  probeDepth: 0,
  lastEvidenceTone: 'unknown',
  streak: 0,
}

function clampDepth(value: number): ProbeDepth {
  const bounded = Math.max(0, Math.min(PROBE_DEPTH_MAX, Math.round(value)))
  return bounded as ProbeDepth
}

export function normalizeProbeState(input?: Partial<ProbeState> | null): ProbeState {
  if (!input) return INITIAL_PROBE_STATE
  const tone: EvidenceTone =
    input.lastEvidenceTone === 'confused' ||
    input.lastEvidenceTone === 'partial' ||
    input.lastEvidenceTone === 'mastered'
      ? input.lastEvidenceTone
      : 'unknown'
  return {
    nodeId: input.nodeId,
    probeDepth: clampDepth(typeof input.probeDepth === 'number' ? input.probeDepth : 0),
    lastEvidenceTone: tone,
    streak: typeof input.streak === 'number' && input.streak > 0 ? Math.floor(input.streak) : 0,
  }
}

/**
 * 从证据集合推导追问深度。
 *
 * - 取该节点最新一条 `answer-quality` 证据；
 * - 从它往前数，同节点且同语气的连续条数即为 streak；
 * - `confused`：深度 = clamp(streak, 1, 3)；
 * - `partial`：深度 = clamp(streak − 1, 0, 2)；
 * - `mastered` / 无证据：深度 0。
 *
 * @param evidence 该教材范围内的全部证据。
 * @param nodeId 目标节点；省略时用证据里最新的 answer-quality 所属节点。
 */
export function deriveProbeState(evidence: readonly Evidence[], nodeId?: string): ProbeState {
  const answers = evidence
    .filter((item) => item.kind === 'answer-quality' && (nodeId === undefined || item.nodeId === nodeId))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))

  const latest = answers[answers.length - 1]
  if (!latest) return { ...INITIAL_PROBE_STATE, nodeId }

  const tone = evidenceTone(latest)
  if (tone === 'unknown') {
    return { nodeId: latest.nodeId, probeDepth: 0, lastEvidenceTone: 'unknown', streak: 0 }
  }

  let streak = 0
  for (let index = answers.length - 1; index >= 0; index -= 1) {
    const item = answers[index]!
    if (item.nodeId !== latest.nodeId) break
    if (evidenceTone(item) !== tone) break
    streak += 1
  }

  let probeDepth: ProbeDepth = 0
  if (tone === 'confused') probeDepth = clampDepth(Math.max(1, streak))
  else if (tone === 'partial') probeDepth = clampDepth(Math.max(0, streak - 1))

  return { nodeId: latest.nodeId, probeDepth, lastEvidenceTone: tone, streak }
}

/**
 * 生成随深度变化的降阶/直讲指令。
 *
 * 这是任务书阶段 A 第 3 条的落地：0/1 继续单问题追问；2 降阶（学伴口吻、
 * 反例或缩小范围）；3 直接讲授最小正确模型并要求复述。
 */
export function depthDirective(depth: ProbeDepth): string {
  switch (depth) {
    case 0:
      return '当前追问深度为 0：先问后讲，优先用一个关键问题确认学生当前的理解位置。'
    case 1:
      return '当前追问深度为 1：继续围绕同一知识点追问，但仍保持一次只问一个关键问题，不要提前给完整答案。'
    case 2:
      return '当前追问深度已到 2：已进入降阶状态。切换为学伴口吻，用更温和的语气，以反例、缩小范围或更小场景继续追问；优先帮学生完成局部判断。'
    default:
      return '当前追问深度已到 3：不要继续抽象追问。请直接讲授当前点的最小正确模型，再要求学生用自己的话复述确认。'
  }
}

/** 证据语气对应的话术基调。 */
export function toneDirective(tone: EvidenceTone): string {
  switch (tone) {
    case 'confused':
      return '最近证据信号偏困惑：先澄清误区，再决定是否推进。'
    case 'partial':
      return '最近证据信号偏半掌握：优先巩固边界、条件和迁移，再决定是否点亮。'
    case 'mastered':
      return '最近证据信号偏已掌握：可以加一点迁移或应用，但仍只推进一个小点。'
    default:
      return '最近暂无稳定证据信号：先通过问题获取判断依据。'
  }
}
