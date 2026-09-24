/**
 * `@dsh-study/core` 的公开出口。
 *
 * 保持"一个模块一个关注点"的目录结构，但对外只暴露这一层，
 * 这样插件侧不需要知道 `knowledge/graph.ts` 还是 `review/srs.ts`。
 */

export * from './types.js'

export * from './knowledge/evidence.js'
export * from './knowledge/mastery.js'
export * from './knowledge/graph.js'

export * from './textbook/identity.js'
export * from './textbook/structure.js'

export * from './pedagogy/probe.js'
export * from './pedagogy/step.js'
export * from './pedagogy/quiz.js'
export * from './pedagogy/focus.js'
export * from './pedagogy/material.js'
export * from './pedagogy/strategy.js'

export * from './review/cards.js'
export * from './review/srs.js'
export * from './review/plan.js'

export * from './growth/stats.js'

export * from './records.classroom.js'

export * from './ingest/types.js'
