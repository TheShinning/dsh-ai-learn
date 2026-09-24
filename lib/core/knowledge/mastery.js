                                                      
import {                orderEvidence } from './evidence.js'

/**
 * 掌握度推导 —— 全系统**唯一**的实现。
 *
 * ## 为什么要有这个模块
 *
 * 原系统有两条推导路径，且二者的"正向证据"判定不一致：
 * - 正常写入：`desktop/learning_knowledge_graph.go:339-403`（`deriveLearningKnowledgeMastery`）
 * - 撤销重放：`desktop/learning_knowledge_graph.go:441-482`（`replayLearningKnowledgeNodeMasterySince`）
 *
 * 正常路径的"多 kind 提升"分支（`:388-393`）只要 kind 属于
 * `flashcard / code-lab / note / blackboard` 就计为正向，**不检查 `correct` / `result`**；
 * 而重放路径用的是严格的 `isPositiveEvidence`（`:313-327`）。
 * 结果：「一条笔记 + 一次失败的代码实验」在正常路径可以被提升为 `mastered`，
 * 撤销同一条人工确认后重放同一组证据却不会 —— 同一份数据两个结论。
 *
 * ## 修法：把掌握度定义成**证据集合的纯函数**
 *
 * `masteryFromEvidence()` 只读证据集合，不读"当前状态"，也不区分
 * "新来的这条"和"历史那些条"。于是：
 * - 增量推导 = 重放推导（按构造相等，不是靠两处代码同步维护）；
 * - 节点上的 `mastery` 降级为**可重算的缓存**，永久重建图谱时只要证据在，掌握度就在；
 * - 判定严格性只有一处定义（`isPositiveEvidence`），不可能再分叉。
 */

/** 结构性证据：能证明"接触过"，但单独不足以点亮。 */
const STRUCTURAL_KINDS                                = new Set([
  'note',
  'blackboard',
  'code-lab',
  'flashcard',
  'srs-review',
])

/** 点亮所需的**不同**正向证据种类数。 */
export const MASTERY_POSITIVE_KIND_FLOOR = 2

/**
 * 一条证据是否算"正向"。
 *
 * 这是全系统唯一的正向判定，任何地方需要判断都必须调用它。
 * 语义对齐原系统 `learning_knowledge_graph.go:313-327`，并补上 `srs-review`
 * （原系统把 SRS 结果存在 `srsResult` 字段里但 Go 侧只存不读，等于丢弃）。
 */
export function isPositiveEvidence(evidence          )          {
  switch (evidence.kind) {
    case 'answer-quality':
      return evidence.result === 'light' || evidence.mastery === 'mastered'
    case 'flashcard':
      return evidence.correct === true
    case 'srs-review':
      return evidence.srsResult === 'good' || evidence.correct === true
    case 'code-lab':
      return evidence.result === 'run'
    case 'mastery-confirm':
      return true
    default:
      return false
  }
}

/** 正向证据覆盖了多少个**不同**种类。 */
export function positiveKindCount(evidence                     )         {
  const kinds = new Set                  ()
  for (const item of evidence) {
    if (isPositiveEvidence(item)) kinds.add(item.kind)
  }
  return kinds.size
}

/**
 * 从完整证据集合推导掌握度。
 *
 * 规则（按顺序）：
 * 1. `mastery-confirm` 与任何自带 `mastery` 的证据**显式覆盖**当前状态；
 * 2. `correct === false` → `confused`（答错即困惑）；
 * 3. `correct === true` 且当前未点亮 → `partial`；
 * 4. 任何**正向证据**（`isPositiveEvidence`）且当前 `unknown` → `partial`
 *    —— 一次答对本身就是"半掌握"，但单独一条不足以点亮；
 * 5. 结构性证据且当前 `unknown` → `partial`（证明接触过，比正向证据弱）；
 * 6. 最终若不同正向种类 ≥ {@link MASTERY_POSITIVE_KIND_FLOOR} → `mastered`；
 * 7. `confused` 具有否决权：不会因为种类够多而被提升为 `mastered`（负面优先）。
 *
 * @param evidence 该节点的**全部**证据（顺序无关，内部会按时间排序）。
 */
export function masteryFromEvidence(evidence                     )          {
  const ordered = orderEvidence(evidence)
  let state          = 'unknown'

  for (const item of ordered) {
    // 1. 显式覆盖优先
    if (item.mastery) {
      state = item.mastery
      continue
    }
    // 2/3. `correct` 三态
    if (item.correct === false) {
      state = 'confused'
      continue
    }
    if (item.correct === true) {
      if (state === 'unknown' || state === 'confused') state = 'partial'
      continue
    }
    // 4. 任何正向证据都能把"未接触"推到"半掌握"（一次答对本身就是进展）
    if (isPositiveEvidence(item)) {
      if (state === 'unknown') state = 'partial'
      continue
    }
    // 5. 结构性证据：只证明接触过，比正向证据弱
    if (STRUCTURAL_KINDS.has(item.kind) && state === 'unknown') {
      state = 'partial'
    }
  }

  // 7. 困惑具有否决权
  if (state === 'confused') return 'confused'

  // 6. 多元正向门控
  if (positiveKindCount(ordered) >= MASTERY_POSITIVE_KIND_FLOOR) return 'mastered'
  return state
}

/**
 * 增量写入后的掌握度。
 *
 * 只是 `masteryFromEvidence` 的糖：把新证据并进历史**一起**推导。
 * 刻意不接收 "current" 参数 —— 当前状态若是独立输入，就会再次出现
 * "同一份证据两个结论"的空间。
 *
 * @param history 该节点已有的全部证据（不含 `incoming`）。
 * @param incoming 即将写入的证据。
 */
export function deriveMastery(history                     , incoming          )          {
  return masteryFromEvidence([...history, incoming])
}

/**
 * 删除一条证据后重算掌握度（撤销 `mastery-confirm` 的路径）。
 *
 * 与原系统的关键差异：原系统需要 `previousMastery` 快照才能回放
 * （`learning_knowledge_graph.go:441-482` 依赖 `removed.PreviousMastery`），
 * 于是只有 `mastery-confirm` 可撤销。这里掌握度是证据的纯函数，
 * **任何**证据都能撤销，不需要快照。
 */
export function masteryWithout(evidence                     , removedId        )          {
  return masteryFromEvidence(evidence.filter((item) => item.id !== removedId))
}

/**
 * 回答信号 → 建议布鲁姆层级。
 *
 * 原系统在 `learning.masteryEvaluator.ts:233` 用
 * `"\\u5e94\\u7528" : "\\u7406\\u89e3" : "\\u8bb0\\u5fc6"` 赋值，
 * 未过解码器，落库的是 12 个字符的转义文本，导致层级门控永不成立。
 * 这里返回封闭联合类型的值，标签由 `BLOOM_LABEL` 在展示层查表。
 *
 * @param understandingSignals 命中"因为/所以/本质/区别/边界/条件/反例/例如/应用/场景"等理解信号的个数。
 * @param anchorSignals 命中"教材/原文/页"等教材锚点信号的个数。
 */
export function suggestBloomLevel(understandingSignals        , anchorSignals        )             {
  if (understandingSignals >= 3 && anchorSignals >= 1) return 'apply'
  if (understandingSignals >= 2) return 'understand'
  return 'remember'
}

/**
 * 层级递进门控：允许提问层级上移的前提。
 *
 * 对应任务书阶段 B 第 3 条「节点历史证据 bloomLevel 达『应用』及以上，
 * 路线才推进下一层级提问」。
 *
 * @param evidence 该节点的全部证据。
 * @param floor 所需的最低层级。
 */
export function hasReachedBloom(evidence                     , floor             = 'apply')          {
  const reached = evidence.some((item) => item.bloomLevel === floor)
  if (reached) return true
  // 也接受"高于 floor"的层级
  const order               = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create']
  const floorIndex = order.indexOf(floor)
  return evidence.some((item) => item.bloomLevel !== undefined && order.indexOf(item.bloomLevel) >= floorIndex)
}
