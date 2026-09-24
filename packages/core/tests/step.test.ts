import { test } from 'node:test'
import assert from 'node:assert/strict'

import { deriveProbeState, INITIAL_PROBE_STATE } from '../src/pedagogy/probe.ts'
import {
  SOCRATIC_ACTION_LABEL,
  SOCRATIC_STEP_LABEL,
  appendStep,
  nextSocraticMove,
  renderMove,
} from '../src/pedagogy/step.ts'
import type { Evidence } from '../src/knowledge/evidence.ts'

let counter = 0
function answer(tone: 'confused' | 'partial' | 'mastered', result?: string): Evidence {
  counter += 1
  const suffix = result ? `-${result}` : ''
  return {
    id: `e${String(counter).padStart(4, '0')}`,
    nodeId: 'n1',
    kind: 'answer-quality',
    sourceId: `s${counter}${suffix}`,
    summary: `第 ${counter} 次回答`,
    result: result ?? (tone === 'confused' ? 'clarify' : tone === 'partial' ? 'consolidate' : 'light'),
    mastery: tone,
    createdAt: new Date(Date.UTC(2026, 6, 1, 0, 0, counter)).toISOString(),
  }
}

function retell(passed: boolean, index = 1): Evidence {
  counter += 1
  return {
    id: `e${String(counter).padStart(4, '0')}`,
    nodeId: 'n1',
    kind: 'answer-quality',
    sourceId: `retell-${index}`,
    summary: passed ? '复述：通过' : '复述：未通过',
    result: 'retell',
    correct: passed,
    createdAt: new Date(Date.UTC(2026, 6, 2, 0, 0, index)).toISOString(),
  }
}

test('零起点：没有节点时给出"先锁定材料"，不报错也不返回空对象', () => {
  const move = nextSocraticMove({ mastery: 'unknown', probeState: INITIAL_PROBE_STATE })
  assert.equal(move.action, 'import-material')
  assert.equal(move.step, 'diagnose')
  assert.equal(move.mayRevealAnswer, false)
  assert.match(move.directive, /锁定/)
})

test('回归：一次只问一个问题 —— questionBudget 恒为 1，任何输入都不能改变', () => {
  const cases = [
    { mastery: 'unknown' as const, probeState: INITIAL_PROBE_STATE, nodeId: 'n1' },
    { mastery: 'confused' as const, probeState: { probeDepth: 3 as const, lastEvidenceTone: 'confused' as const, streak: 3, nodeId: 'n1' }, nodeId: 'n1' },
    { mastery: 'mastered' as const, probeState: INITIAL_PROBE_STATE, nodeId: 'n1' },
    { mastery: 'partial' as const, probeState: { probeDepth: 2 as const, lastEvidenceTone: 'partial' as const, streak: 3, nodeId: 'n1' }, nodeId: 'n1' },
  ]
  for (const input of cases) {
    assert.equal(nextSocraticMove(input).questionBudget, 1)
  }
})

test('未知掌握度 + 无证据：第一步是诊断性提问（一次一个关键问题）', () => {
  const move = nextSocraticMove({ nodeId: 'n1', mastery: 'unknown', probeState: INITIAL_PROBE_STATE, evidence: [] })
  assert.equal(move.step, 'diagnose')
  assert.equal(move.action, 'ask')
  assert.equal(move.focusNodeId, 'n1')
  assert.match(move.directive, /先问后讲/)
})

test('回归：先问后讲 —— 深度未到 3 且非半掌握时，绝不允许揭示答案', () => {
  const low = nextSocraticMove({ nodeId: 'n1', mastery: 'unknown', probeState: { probeDepth: 1, lastEvidenceTone: 'confused', streak: 1, nodeId: 'n1' }, evidence: [answer('confused')] })
  assert.equal(low.mayRevealAnswer, false, '困惑一次只能给例子，不能给答案')

  const narrow = nextSocraticMove({ nodeId: 'n1', mastery: 'unknown', probeState: { probeDepth: 2, lastEvidenceTone: 'partial', streak: 3, nodeId: 'n1' }, evidence: [answer('partial')] })
  assert.equal(narrow.action, 'narrow')
  assert.equal(narrow.mayRevealAnswer, false, '缩小范围仍然只是问')
})

test('深度到 3：直讲最小正确模型并要求复述（这是允许给答案的唯一困惑路径）', () => {
  const evidence = [answer('confused'), answer('confused'), answer('confused')]
  const probe = deriveProbeState(evidence, 'n1')
  assert.equal(probe.probeDepth, 3)

  const move = nextSocraticMove({ nodeId: 'n1', mastery: 'confused', probeState: probe, evidence })
  assert.equal(move.step, 'explain-and-retell')
  assert.equal(move.action, 'explain-then-retell')
  assert.equal(move.mayRevealAnswer, true)
  assert.equal(move.mustRetell, true, '直讲之后必须先复述')
  assert.match(move.directive, /必须要求复述/)
})

test('困惑阶梯是固定的：第 1 次给例子，第 2 次换二选一（不由模型选）', () => {
  const once = nextSocraticMove({
    nodeId: 'n1',
    mastery: 'confused',
    probeState: { probeDepth: 1, lastEvidenceTone: 'confused', streak: 1, nodeId: 'n1' },
    evidence: [answer('confused')],
  })
  assert.equal(once.action, 'give-example')
  assert.equal(once.scaffoldLadder.length > 0, true, '降阶要给出台阶，而不是一句"再想想"')

  const twice = nextSocraticMove({
    nodeId: 'n1',
    mastery: 'confused',
    probeState: { probeDepth: 2, lastEvidenceTone: 'confused', streak: 2, nodeId: 'n1' },
    evidence: [answer('confused'), answer('confused')],
  })
  assert.equal(twice.action, 'offer-binary')
  assert.match(twice.directive, /二选一/)
})

test('回归：复述未通过时不重置追问深度（不把学生重新问一遍）', () => {
  const evidence = [answer('confused'), answer('confused'), answer('confused'), retell(false)]
  const probe = deriveProbeState(evidence, 'n1')
  const move = nextSocraticMove({ nodeId: 'n1', mastery: 'confused', probeState: probe, evidence, lastQuiz: 'retell-fail' })

  assert.equal(move.action, 'retell-again')
  assert.equal(move.step, 'explain-and-retell')
  assert.equal(move.mustRetell, true)
  assert.equal(move.probeDepth, probe.probeDepth, '深度必须保持')
  assert.match(move.directive, /不要.*重新问一遍/)
})

test('复述通过后转入验收：有卡就出题，没卡就先提议建卡', () => {
  const withCard = nextSocraticMove({
    nodeId: 'n1',
    mastery: 'partial',
    probeState: INITIAL_PROBE_STATE,
    evidence: [answer('partial'), retell(true)],
    cards: [{ id: 'c1', nodeId: 'n1' }],
    lastQuiz: 'retell-ok',
  })
  assert.equal(withCard.action, 'quiz')
  assert.equal(withCard.step, 'quiz')

  const withoutCard = nextSocraticMove({
    nodeId: 'n1',
    mastery: 'partial',
    probeState: INITIAL_PROBE_STATE,
    evidence: [answer('partial'), retell(true)],
    cards: [],
    lastQuiz: 'retell-ok',
  })
  assert.equal(withoutCard.action, 'review')
  assert.match(withoutCard.directive, /建一张卡/)
})

test('已点亮：到期卡先复习，其次验收，最后推进（不满足于"学生说懂了"）', () => {
  const mastered = nextSocraticMove({
    nodeId: 'n1',
    mastery: 'mastered',
    probeState: INITIAL_PROBE_STATE,
    evidence: [answer('mastered')],
    cards: [{ id: 'c1', nodeId: 'n1', due: true }],
  })
  assert.equal(mastered.action, 'review')
  assert.match(mastered.directive, /不要手动改掌握度/)

  const needsQuiz = nextSocraticMove({
    nodeId: 'n1',
    mastery: 'mastered',
    probeState: INITIAL_PROBE_STATE,
    evidence: [answer('mastered')],
    cards: [{ id: 'c1', nodeId: 'n1', due: false }],
  })
  assert.equal(needsQuiz.action, 'quiz')

  const advance = nextSocraticMove({
    nodeId: 'n1',
    mastery: 'mastered',
    probeState: INITIAL_PROBE_STATE,
    evidence: [answer('mastered'), { ...answer('mastered'), kind: 'flashcard', correct: true }],
    cards: [{ id: 'c1', nodeId: 'n1', due: false }],
    lastQuiz: 'good',
  })
  assert.equal(advance.action, 'advance')
})

test('半掌握且深度到 2：停止加压，改为直讲 + 复述', () => {
  const evidence = [answer('partial'), answer('partial'), answer('partial')]
  const probe = deriveProbeState(evidence, 'n1')
  const move = nextSocraticMove({ nodeId: 'n1', mastery: 'partial', probeState: probe, evidence })
  assert.equal(move.action, 'explain-then-retell')
  assert.equal(move.mustRetell, true)
  assert.match(move.directive, /停止加压/)
})

test('零起点与全部动作都有中文标签，渲染出来的状态行包含关键约束', () => {
  for (const label of Object.values(SOCRATIC_ACTION_LABEL)) assert.ok(label.length > 0)
  for (const label of Object.values(SOCRATIC_STEP_LABEL)) assert.ok(label.length > 0)

  const move = nextSocraticMove({
    nodeId: 'n1',
    mastery: 'confused',
    probeState: { probeDepth: 3, lastEvidenceTone: 'confused', streak: 3, nodeId: 'n1' },
    evidence: [answer('confused'), answer('confused'), answer('confused')],
  })
  const line = renderMove(move)
  assert.match(line, /环节：直讲与复述/)
  assert.match(line, /可以给答案：可以/)
  assert.match(line, /必须让学生复述/)
})

test('留痕是纯函数：appendStep 不修改原数组，时间来自传入的时钟', () => {
  const move = nextSocraticMove({ nodeId: 'n1', mastery: 'unknown', probeState: INITIAL_PROBE_STATE, evidence: [] })
  const first = appendStep([], move, new Date('2026-09-23T10:00:00.000Z'))
  const second = appendStep(first, move, new Date('2026-09-23T10:05:00.000Z'))
  assert.equal(first.length, 1)
  assert.equal(second.length, 2)
  assert.equal(second[0]!.at, '2026-09-23T10:00:00.000Z')
  assert.equal(first[0]!.step, move.step)
})
