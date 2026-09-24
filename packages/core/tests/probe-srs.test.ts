import { test } from 'node:test'
import assert from 'node:assert/strict'

import { deriveProbeState, depthDirective, toneDirective } from '../src/pedagogy/probe.ts'
import { INITIAL_SRS, dayKey, isDue, scheduleReview, srsMasterySignal } from '../src/review/srs.ts'
import type { Evidence } from '../src/knowledge/evidence.ts'

function answer(tone: 'confused' | 'partial' | 'mastered', index: number, nodeId = 'n1'): Evidence {
  return {
    id: `a${String(index).padStart(3, '0')}`,
    nodeId,
    kind: 'answer-quality',
    sourceId: `s${index}`,
    summary: `第 ${index} 次回答`,
    mastery: tone,
    result: tone === 'confused' ? 'clarify' : tone === 'partial' ? 'consolidate' : 'light',
    createdAt: new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString(),
  }
}

test('回归：连续三次困惑推导出 0→1→2→3，且到 3 不再增长', () => {
  assert.equal(deriveProbeState([]).probeDepth, 0)

  const one = deriveProbeState([answer('confused', 1)])
  assert.equal(one.probeDepth, 1)
  assert.equal(one.streak, 1)

  const two = deriveProbeState([answer('confused', 1), answer('confused', 2)])
  assert.equal(two.probeDepth, 2)

  const three = deriveProbeState([answer('confused', 1), answer('confused', 2), answer('confused', 3)])
  assert.equal(three.probeDepth, 3)

  const five = deriveProbeState([1, 2, 3, 4, 5].map((index) => answer('confused', index)))
  assert.equal(five.probeDepth, 3, '深度上限为 3')
  assert.equal(five.streak, 5, 'streak 继续记录，便于解释深度来源')
})

test('半掌握按 streak−1 推导，封顶 2', () => {
  assert.equal(deriveProbeState([answer('partial', 1)]).probeDepth, 0)
  assert.equal(deriveProbeState([answer('partial', 1), answer('partial', 2)]).probeDepth, 1)
  assert.equal(
    deriveProbeState([1, 2, 3].map((index) => answer('partial', index))).probeDepth,
    2,
  )
})

test('语气切换会打断 streak', () => {
  const state = deriveProbeState([answer('confused', 1), answer('confused', 2), answer('mastered', 3)])
  assert.equal(state.lastEvidenceTone, 'mastered')
  assert.equal(state.probeDepth, 0)
  assert.equal(state.streak, 1)
})

test('节点隔离：不同知识点的证据不互相计数', () => {
  const evidence = [answer('confused', 1, 'n1'), answer('confused', 2, 'n2'), answer('confused', 3, 'n2')]
  assert.equal(deriveProbeState(evidence, 'n1').probeDepth, 1)
  assert.equal(deriveProbeState(evidence, 'n2').probeDepth, 2)
})

test('深度指令覆盖四档，且 2 档是降阶、3 档是直讲', () => {
  assert.match(depthDirective(0), /先问后讲/)
  assert.match(depthDirective(1), /继续围绕同一知识点追问/)
  assert.match(depthDirective(2), /降阶/)
  assert.match(depthDirective(3), /直接讲授/)
  assert.match(toneDirective('confused'), /澄清误区/)
  assert.match(toneDirective('mastered'), /迁移/)
})

test('SRS：连续答对间隔递增，答错重置；ease 有下限', () => {
  let state = { ...INITIAL_SRS }
  state = scheduleReview(state, 'good', new Date('2026-07-01T12:00:00.000Z'))
  assert.equal(state.intervalDays, 1)
  state = scheduleReview(state, 'good', new Date('2026-07-02T12:00:00.000Z'))
  assert.equal(state.intervalDays, 3)
  const beforeEase = state.easeFactor
  state = scheduleReview(state, 'good', new Date('2026-07-05T12:00:00.000Z'))
  assert.ok(state.intervalDays > 3, '第三次答对后间隔按 ease 放大')
  assert.ok(state.easeFactor > beforeEase, '答对提升 ease')

  const reset = scheduleReview(state, 'again', new Date('2026-07-06T12:00:00.000Z'))
  assert.equal(reset.intervalDays, 1, '答错重置为 1 天')
  assert.ok(reset.easeFactor >= 1.3)

  let floored = { ...INITIAL_SRS, easeFactor: 1.35 }
  for (let index = 0; index < 5; index += 1) floored = scheduleReview(floored, 'again', new Date('2026-07-07T12:00:00.000Z'))
  assert.equal(floored.easeFactor, 1.3, 'ease 不得低于下限')
})

test('SRS：计数与排期同源，一次调用只加一次', () => {
  // 用本地时间构造，避免断言依赖机器时区
  const base = new Date(2026, 6, 1, 12, 0, 0)
  const once = scheduleReview(INITIAL_SRS, 'good', base)
  assert.equal(once.practiceCount, 1)
  assert.ok(once.nextReviewAt)
  assert.equal(dayKey(once.nextReviewAt!), dayKey(new Date(2026, 6, 2)), '到期落在本地时区的次日')
})

test('SRS：到期按天比较，无排期视为到期', () => {
  const base = new Date(2026, 6, 1, 12, 0, 0)
  assert.equal(isDue(INITIAL_SRS, base), true, '新卡视为到期')
  const scheduled = scheduleReview(INITIAL_SRS, 'good', base)
  assert.equal(isDue(scheduled, new Date(2026, 6, 1, 23, 0, 0)), false, '当天不到期')
  assert.equal(isDue(scheduled, new Date(2026, 6, 2, 0, 30, 0)), true, '次日到期')
  assert.equal(isDue(scheduled, new Date(2026, 6, 9, 12, 0, 0)), true, '逾期仍到期')
})

test('复习失败给出掌握度信号（原系统 Go 侧只存不读 srsResult）', () => {
  assert.equal(srsMasterySignal('again'), 'confused')
  assert.equal(srsMasterySignal('hard'), 'partial')
  assert.equal(srsMasterySignal('good'), undefined)
})
