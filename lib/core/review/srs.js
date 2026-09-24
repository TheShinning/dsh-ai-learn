/**
 * 间隔重复调度（简化 SM-2，三档）。
 *
 * 沿用原系统 `learning.srsScheduler.ts` 的三档设计（again / hard / good），
 * 理由与原注释一致：自学场景里"太简单"（标准 SM-2 的 easy）几乎不出现，
 * 三档让每次选择更明确。
 *
 * 与原系统的差异（修复点）：
 * 1. **纯函数、无存储耦合**：原实现的调度与 localStorage 读写混在
 *    `learning.flashcardBank.ts` 里，导致"同一张卡被计时两次"这类问题
 *    （`learning.flashcardWindow.ts:75-80` 会在关窗时再调一次
 *    `markLearningFlashcardsPracticed`，对同一批卡第二次 `practiceCount + 1`）。
 *    这里只有一个入口 `scheduleReview()`，计数与排期同源。
 * 2. **到期比较用日期键**：原系统比较的是 ISO 字符串切片
 *    （`nextReviewAt.slice(0,10) <= now.slice(0,10)`），语义是"按天"。
 *    这里把该语义显式写成 `dayKey()`，避免读者误以为按时刻比较。
 */

                                                         

                        
                           
                               
                     
                             
                     
                                
                                
                                  
 

export const INITIAL_SRS           = {
  intervalDays: 0,
  easeFactor: 2.5,
  practiceCount: 0,
}

export const SRS_EASE_FLOOR = 1.3
export const SRS_INTERVAL_FLOOR = 1
export const SRS_INTERVAL_CEILING = 365

/** 结果的展示标签。原系统把这份表放在 `srsScheduler.ts:106-110` 却无生产消费者。 */
export const SRS_RESULT_LABEL                            = {
  again: '错了',
  hard: '勉强对',
  good: '答对了',
}

/** 取本地日期键（YYYY-MM-DD）。到期判定按天，不按时刻。 */
export function dayKey(at                        )         {
  const date = at instanceof Date ? at : new Date(at)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 计算下一次复习时间：本地日期的当天 + interval 天的 12:00（本地时区）。
 *
 * 选中午而不是 00:00，是为了让"今天到期"在跨时区/夏令时下也不会因为几小时
 * 误差而提前或推迟一天。
 */
export function nextReviewAt(from      , intervalDays        )         {
  const target = new Date(from.getFullYear(), from.getMonth(), from.getDate() + intervalDays, 12, 0, 0, 0)
  return target.toISOString()
}

/**
 * 应用一次复习结果，返回新的 SRS 状态。
 *
 * 规则（对齐原系统 `learning.srsScheduler.ts:42-78`）：
 * - `again`：间隔归 1 天，ease − 0.2；
 * - `hard`：间隔 ×1.2（从未复习过则 1 天），ease − 0.15；
 * - `good`：0→1 天、1→3 天，否则 ×ease；ease + 0.1。
 *
 * @param state 当前状态（新卡用 {@link INITIAL_SRS}）。
 * @param result 三档结果。
 * @param at 复习发生的时刻（默认现在）。
 */
export function scheduleReview(state          , result           , at       = new Date())           {
  const ease = Math.max(SRS_EASE_FLOOR, state.easeFactor)
  const current = Math.max(0, state.intervalDays)
  let intervalDays        
  let easeFactor        

  if (result === 'again') {
    intervalDays = 1
    easeFactor = Math.max(SRS_EASE_FLOOR, ease - 0.2)
  } else if (result === 'hard') {
    intervalDays = current <= 0 ? 1 : Math.round(current * 1.2)
    easeFactor = Math.max(SRS_EASE_FLOOR, ease - 0.15)
  } else {
    intervalDays = current <= 0 ? 1 : current === 1 ? 3 : Math.round(current * ease)
    easeFactor = ease + 0.1
  }

  intervalDays = Math.min(SRS_INTERVAL_CEILING, Math.max(SRS_INTERVAL_FLOOR, intervalDays))

  return {
    intervalDays,
    easeFactor,
    nextReviewAt: nextReviewAt(at, intervalDays),
    practiceCount: state.practiceCount + 1,
    lastReviewedAt: at.toISOString(),
  }
}

/** 到期判定：无排期视为到期（新卡），否则按日期键比较。 */
export function isDue(state          , now       = new Date())          {
  if (!state.nextReviewAt) return true
  return dayKey(state.nextReviewAt) <= dayKey(now)
}

/**
 * 复习失败是否应触发掌握度降级。
 *
 * 原系统把降级逻辑放在 Go 侧，但 Go **只存不读** `srsResult`
 * （`learning_knowledge_graph.go:82,732` 之外全仓无引用），
 * 于是"复习失败把节点掌握度降回去"完全依赖前端另外显式传 `mastery`。
 * 这里把该判定变成 core 的显式函数，任何调用方都能得到同一答案。
 */
export function srsMasterySignal(result           )                                     {
  if (result === 'again') return 'confused'
  if (result === 'hard') return 'partial'
  return undefined
}
