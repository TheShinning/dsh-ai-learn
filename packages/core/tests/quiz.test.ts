import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isPositiveEvidence } from '../src/knowledge/mastery.ts'
import { evidenceTone } from '../src/knowledge/evidence.ts'
import {
  answerToEvidence,
  inferErrorType,
  quizDirective,
  quizIntent,
  renderQuizIntent,
  retellEvidence,
} from '../src/pedagogy/quiz.ts'

test('回归：不产出第二套正向判定 —— 答对只写 correct/result，是否正向交给 isPositiveEvidence', () => {
  const correct = answerToEvidence({ nodeId: 'n1', sourceId: 's1', answer: '因为要先看适用条件', correct: true, now: new Date('2026-09-23T10:00:00.000Z') })
  assert.equal(correct.correct, true)
  assert.equal(correct.mastery, undefined, '一次答对不等于已掌握（点亮需要多元证据）')
  assert.equal(correct.result, 'light')
  assert.equal(isPositiveEvidence({ id: 'x', nodeId: 'n1', kind: 'answer-quality', sourceId: 's1', summary: 's', createdAt: '2026-09-23T10:00:00.000Z', ...correct }), true)

  const wrong = answerToEvidence({ nodeId: 'n1', sourceId: 's2', answer: '我觉得就是 A', correct: false, now: new Date('2026-09-23T10:00:00.000Z') })
  assert.equal(wrong.correct, false)
  assert.equal(wrong.mastery, 'confused', '答错即困惑（负面证据要有否决权，必须写进 mastery）')
  assert.equal(wrong.result, 'clarify')
  const wrongRow = { id: 'y', nodeId: 'n1', kind: 'answer-quality', sourceId: 's2', summary: 's', createdAt: '2026-09-23T10:00:00.000Z', ...wrong }
  assert.equal(isPositiveEvidence(wrongRow), false)
  assert.equal(evidenceTone(wrongRow), 'confused', '新映射必须与 evidenceTone 的语义一致')
})

test('未作答与答错是两件事：未作答不判错，只标记需要澄清', () => {
  const empty = answerToEvidence({ nodeId: 'n1', sourceId: 's3', answer: '   ' })
  assert.equal(empty.correct, undefined, '未作答的 correct 是 undefined（三态），不是 false')
  assert.equal(empty.result, 'clarify')
  assert.equal(empty.mastery, undefined)
  assert.equal(empty.errorType, 'no-answer')
})

test('复述是显式作答类型：result=retell，通过与否写在 correct 上', () => {
  const passed = retellEvidence({ nodeId: 'n1', sourceId: 'r1', answer: '它的作用是限定适用条件', passed: true })
  assert.equal(passed.result, 'retell')
  assert.equal(passed.correct, true)
  assert.equal(passed.kind, 'answer-quality')
  assert.match(passed.summary, /复述/)

  const failed = retellEvidence({ nodeId: 'n1', sourceId: 'r2', answer: '大概是……', passed: false })
  assert.equal(failed.result, 'retell')
  assert.equal(failed.correct, false)
  assert.equal(failed.mastery, 'confused')
})

test('卡片作答走 flashcard 证据，自评三档映射到 correct', () => {
  const good = answerToEvidence({ nodeId: 'n1', sourceId: 'c1', answer: '选 B', kind: 'card', selfReport: 'good' })
  assert.equal(good.kind, 'flashcard')
  assert.equal(good.correct, true)
  const again = answerToEvidence({ nodeId: 'n1', sourceId: 'c2', answer: '选 A', kind: 'card', selfReport: 'again' })
  assert.equal(again.correct, false)
  assert.equal(again.mastery, 'confused')
})

test('错误类型推断是启发式的：命中不了就返回 undefined，并允许显式覆盖', () => {
  assert.equal(inferErrorType({ answer: '', correct: false }), 'no-answer')
  assert.equal(inferErrorType({ answer: '我忘了这一条的条件', correct: false }), 'forgetting')
  assert.equal(inferErrorType({ answer: '题目问的是什么我没看清', correct: false }), 'comprehension-deviation')
  assert.equal(inferErrorType({ answer: '我把这两个概念搞混了', correct: false }), 'concept-misunderstanding')
  assert.equal(inferErrorType({ answer: '因为条件满足所以适用', correct: true }), undefined, '答对不产生错误类型')

  // 有作答、判错、但没有任何自述信号：给"迁移失败"（仍是启发式）
  assert.equal(inferErrorType({ answer: '嗯，应该是这样', correct: false }), 'transfer-failure')

  // 显式传入优先
  const explicit = answerToEvidence({ nodeId: 'n1', sourceId: 's9', answer: '忘了', correct: false, errorType: 'concept-misunderstanding' })
  assert.equal(explicit.errorType, 'concept-misunderstanding')
})

test('摘要不整段入库：超长作答被截断', () => {
  const long = '条'.repeat(200)
  const row = answerToEvidence({ nodeId: 'n1', sourceId: 's10', answer: long })
  assert.ok(row.summary.length < long.length)
  assert.match(row.summary, /…$/)
})

test('验收方式由层级与掌握度决定：未达理解先讲一遍，达应用给简答', () => {
  assert.equal(quizIntent({ mastery: 'unknown', bloom: 'remember', hasCard: true }), 'explain-in-own-words')
  assert.equal(quizIntent({ mastery: 'partial', bloom: 'understand', hasCard: true }), 'cloze')
  assert.equal(quizIntent({ mastery: 'confused', bloom: 'understand', hasCard: true }), 'choice', '困惑时用选择题当场辨析')
  assert.equal(quizIntent({ mastery: 'partial', bloom: 'apply', hasCard: true }), 'short-answer')
  assert.equal(quizIntent({ mastery: 'partial', bloom: 'apply', hasCard: false }), 'explain-in-own-words', '没有卡就先让学生讲')
})

test('每种验收方式都有可执行的指令，且不越过"先问后讲"', () => {
  for (const intent of ['explain-in-own-words', 'choice', 'cloze', 'short-answer', 'mnemonic'] as const) {
    const text = quizDirective(intent, 'partial')
    assert.ok(text.length > 10, `${intent} 的指令太短`)
  }
  assert.match(renderQuizIntent('short-answer', 'partial'), /迁移/)
  assert.match(quizDirective('choice', 'confused'), /不要只报对错/)
})
