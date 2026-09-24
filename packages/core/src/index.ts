/**
 * `@dsh-study/core` 的公开出口。
 *
 * 保持"一个模块一个关注点"的目录结构，但对外只暴露这一层，
 * 这样插件侧不需要知道 `knowledge/graph.ts` 还是 `review/srs.ts`。
 */

export * from './types.ts'

export * from './knowledge/evidence.ts'
export * from './knowledge/mastery.ts'
export * from './knowledge/graph.ts'

export * from './textbook/identity.ts'
export * from './textbook/structure.ts'

export * from './pedagogy/probe.ts'
export * from './pedagogy/step.ts'
export * from './pedagogy/quiz.ts'
export * from './pedagogy/focus.ts'
export * from './pedagogy/material.ts'
export * from './pedagogy/strategy.ts'

export * from './review/cards.ts'
export * from './review/srs.ts'
export * from './review/plan.ts'

export * from './growth/stats.ts'

export * from './records.classroom.ts'

export * from './ingest/types.ts'
