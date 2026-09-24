/**
 * 成长统计 —— 每个数字都必须声明**来源**。
 *
 * ## 原系统的问题：「数字与证据脱节」
 *
 * `learning.growthModel.ts` 把两类东西混在同一个快照里：
 * - 真证据统计（`buildLearningEvidenceStats`，`:79-129`，来自图谱与闪卡复习史）；
 * - 关键词/正则产物：图谱关系按 `index % 5` 轮流赋"包含/对比/易混/应用/迁移"（`:314-320`）、
 *   "连续追问"成就门槛是 `userTurns >= 5`（`:352`）、教师记忆首条 `whatWorked` 是常量（`:448`）、
 *   分享卡时长在 `elapsedMs <= 0` 时用"N 轮互动"顶替（`:473-478`）。
 *
 * 面板因此读起来像"证据驱动"，实际只有 `evidenceSummary` 一处标注了真实来源
 * （`:616-624`），而 `LearningProfilePanel.tsx:38` 直接把启发式判定写成
 * "已掌握 N 个知识节点（基于 M 条真实证据）"。
 *
 * ## 修法：把"来源"变成类型的一部分
 *
 * 每个指标都是 `Metric<T>`，`source` 必填。展示层无法"忘记"标注来源 ——
 * 想拿到数字就必须先声明它是证据、派生还是启发式。
 * 启发式指标另带 `note`，UI 必须显式说明它不可作为学习结论。
 */

                                          
                                                        
import { masteryFromEvidence } from '../knowledge/mastery.js'
                                                           
import { reviewActivity } from '../review/plan.js'
                                                

/** 指标来源。`heuristic` 的数字**不得**作为学习结论展示。 */
                                                               

export const METRIC_SOURCE_LABEL                               = {
  evidence: '来自证据',
  derived: '由证据派生',
  heuristic: '启发式估计',
}

                                  
                   
                               
                                
                        
                                                 
                           
 

export function metric   (value   , source              , extra                                      = {})            {
  if (source === 'heuristic' && !extra.note) {
    throw new Error('启发式指标必须提供 note，说明它不是证据结论')
  }
  return { value, source, ...extra }
}

/** 闪卡侧的最小只读视图（避免 core 依赖具体存储实现）。 */
                             
                     
                                                                                              
                         
 

                          
                             
                                
                               
                                
                                
                                     
                                        
                             
                           
                                
 

/**
 * 由真实证据与复习史计算统计。
 *
 * 这里**没有**任何输入是 `userTurns` / 聊天文本 / 时间。
 * 想加一个非证据指标，就必须显式走 {@link metric}(`'heuristic'`) 并提供 note。
 *
 * ## `reviewEvidence`：复习数字的**一手**来源
 *
 * 原实现只从 `flashcards[].reviewHistory` 统计"复习天数/已复习卡"，
 * 而生产调用点恒传 `reviewHistory: []`（见 `plugin-host/src/tools.ts`），
 * 于是这两个数字在真实运行里永远是 0 —— 测试却因为手写夹具而为绿。
 *
 * 现在以 `kind === 'srs-review'` 的**证据行**为准（每次提交复习都会写一条，自带时间戳与结果）。
 * `reviewHistory` 仍被接受（老调用方与老数据不会失效），但只有在没有 `reviewEvidence` 时才参与计算。
 */
export function buildStudyStats(input   
                       
                                      
                                                 
                                      
            
 )             {
  const byNode = new Map                    ()
  for (const item of input.graph.evidence) {
    const list = byNode.get(item.nodeId)
    if (list) list.push(item)
    else byNode.set(item.nodeId, [item])
  }

  let mastered = 0
  let partial = 0
  let confused = 0
  let repeatedConfused = 0
  const studyNodes = input.graph.nodes.filter((node) => node.type !== 'textbook')

  for (const node of studyNodes) {
    const items = byNode.get(node.id) ?? []
    const mastery          = masteryFromEvidence(items)
    if (mastery === 'mastered') mastered += 1
    else if (mastery === 'partial') partial += 1
    else if (mastery === 'confused') confused += 1

    // "反复困惑"= 同一节点出现过 ≥2 条困惑证据（而不是 ≥2 次回答）
    const confusedCount = items.filter((item) => item.mastery === 'confused' || item.result === 'clarify').length
    if (confusedCount >= 2) repeatedConfused += 1
  }

  const metacognitionCount = input.graph.evidence.filter((item) => item.kind === 'metacognition').length

  const days = new Set        ()
  let reviewedCards = 0
  let dueCards = 0
  const now = input.now ?? new Date()
  for (const card of input.flashcards) {
    if (card.reviewHistory?.length) {
      reviewedCards += 1
      for (const record of card.reviewHistory) days.add(record.reviewedAt.slice(0, 10))
    }
    if (isCardDue(card, now)) dueCards += 1
  }

  // 一手来源优先：srs-review 证据行（时间戳 + 结果都是系统写的）
  const fromEvidence = input.reviewEvidence ? reviewActivity(input.reviewEvidence) : undefined
  const reviewDaysMetric = fromEvidence
    ? metric(fromEvidence.reviewDays, 'evidence', { basedOn: fromEvidence.reviewedCards })
    : metric(days.size, 'evidence', { basedOn: reviewedCards })
  const reviewedCardsMetric = fromEvidence
    ? metric(fromEvidence.reviewedCards, 'evidence', { basedOn: input.reviewEvidence?.length ?? 0 })
    : metric(reviewedCards, 'evidence', { basedOn: reviewedCards })

  const evidenceCount = input.graph.evidence.length
  return {
    totalNodes: metric(studyNodes.length, 'evidence', { basedOn: studyNodes.length }),
    masteredNodes: metric(mastered, 'evidence', { basedOn: mastered }),
    partialNodes: metric(partial, 'evidence', { basedOn: partial }),
    confusedNodes: metric(confused, 'evidence', { basedOn: confused }),
    totalEvidence: metric(evidenceCount, 'evidence', { basedOn: evidenceCount }),
    metacognitionCount: metric(metacognitionCount, 'evidence', { basedOn: metacognitionCount }),
    repeatedConfusedNodes: metric(repeatedConfused, 'derived', {
      basedOn: evidenceCount,
      note: '统计同一节点出现 ≥2 条困惑证据的节点数，用于观察教学是否在起效',
    }),
    reviewDays: reviewDaysMetric,
    dueCards: metric(dueCards, 'derived', { basedOn: input.flashcards.length }),
    reviewedCards: reviewedCardsMetric,
  }
}

function isCardDue(card               , now      )          {
  const next = card.srs?.nextReviewAt
  if (!next) return true
  return next.slice(0, 10) <= now.toISOString().slice(0, 10)
}

/**
 * 把统计渲染成一段人可读文本，**每个数字后面都带来源标记**。
 *
 * 这是"面板读起来像证据驱动"这个问题的直接修法：
 * 只要走这个渲染函数，启发式数字就不可能伪装成证据。
 */
export function renderStats(stats            )         {
  const rows                     = [
    ['知识点总数', stats.totalNodes],
    ['已点亮', stats.masteredNodes],
    ['半掌握', stats.partialNodes],
    ['困惑', stats.confusedNodes],
    ['证据条数', stats.totalEvidence],
    ['元认知反思', stats.metacognitionCount],
    ['反复困惑节点', stats.repeatedConfusedNodes],
    ['复习天数', stats.reviewDays],
    ['到期卡', stats.dueCards],
    ['已复习卡', stats.reviewedCards],
  ]
  return rows
    .map(([label, item]) => {
      const suffix = item.source === 'evidence' ? '' : `（${METRIC_SOURCE_LABEL[item.source]}）`
      return `- ${label}：${String(item.value)}${suffix}`
    })
    .join('\n')
}

/** 便于调用方在不直接依赖 review 模块的情况下拿到 SRS 状态类型。 */
                        
