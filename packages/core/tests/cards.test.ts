import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CARD_KIND_LABEL,
  impracticableReason,
  isPracticable,
  judge,
  judgementMode,
  mnemonicCard,
  resolveChoiceKey,
  type ChoiceCard,
  type StudyCard,
} from '../src/review/cards.ts'

const choice: ChoiceCard = {
  kind: 'choice',
  id: 'c1',
  prompt: '矛盾的两个属性是？',
  options: [
    { key: 'A', text: '普遍性与特殊性' },
    { key: 'B', text: '同一性与斗争性' },
  ],
  answerKey: 'B',
  createdAt: '2026-07-01T00:00:00.000Z',
}

test('回归：口诀卡（无选项）可练习 —— 原系统三处 options.length>0 闸门把它排除在复习之外', () => {
  const card = mnemonicCard({
    id: 'mnemonic-1',
    knowledgePoint: '矛盾的普遍性与特殊性',
    prompt: '如何记住"普遍性与特殊性"的区别？',
    answer: '共性寓于个性之中，一般只能通过个别而存在。',
    scope: '矛盾论 · 第二节',
  })
  assert.deepEqual((card as { options?: unknown }).options, undefined, '口诀卡不应持有 options 字段')
  assert.equal(isPracticable(card), true, '口诀卡必须可练习')
  assert.equal(impracticableReason(card), undefined)
  assert.equal(judgementMode(card), 'self-report')
})

test('四种卡都可练习；只有内容缺失才不可练习', () => {
  const cloze: StudyCard = { kind: 'cloze', id: 'z1', prompt: '同一性是指____', answer: '矛盾双方相互依存', createdAt: 'x' }
  const short: StudyCard = { kind: 'short-answer', id: 's1', prompt: '简述斗争性', answer: '相互排斥、相互对立', createdAt: 'x' }
  const broken: StudyCard = { kind: 'short-answer', id: 's2', prompt: '简述斗争性', answer: '   ', createdAt: 'x' }
  assert.equal(isPracticable(choice), true)
  assert.equal(isPracticable(cloze), true)
  assert.equal(isPracticable(short), true)
  assert.equal(isPracticable(broken), false)
  assert.equal(impracticableReason(broken), '缺少答案')
  assert.equal(CARD_KIND_LABEL.mnemonic, '记忆口诀')
})

test('选择题自动判分；无法判定正确项时交给自评，而不是判成"勉强对"', () => {
  assert.equal(judgementMode(choice), 'auto')
  assert.equal(judge(choice, { selectedKey: 'B' }), 'good')
  assert.equal(judge(choice, { selectedKey: 'A' }), 'again')
  assert.equal(judge(choice, {}), undefined, '未作答不产生结果')

  // 答案文本无法对应任何选项 → 原系统直接判 hard（把"题目没写清"记成"勉强答对"）
  const ambiguous: ChoiceCard = { ...choice, answerKey: '以上都对' }
  assert.equal(resolveChoiceKey(ambiguous), undefined)
  assert.equal(judge(ambiguous, { selectedKey: 'A' }), undefined, '无法判定时应返回 undefined 交给自评')
})

test('resolveChoiceKey 支持字母前缀与文本包含匹配', () => {
  assert.equal(resolveChoiceKey(choice), 'B')
  assert.equal(resolveChoiceKey({ ...choice, answerKey: 'b.' }), 'B')
  assert.equal(resolveChoiceKey({ ...choice, answerKey: '同一性与斗争性' }), 'B')
  assert.equal(resolveChoiceKey({ ...choice, answerKey: '同一性' }), 'B', '答案文本被选项文本包含时命中')
})

test('自评类卡片按传入结果判定', () => {
  const card = mnemonicCard({ id: 'm1', knowledgePoint: 'K', prompt: 'P', answer: 'A' })
  assert.equal(judge(card, { selfReport: 'good' }), 'good')
  assert.equal(judge(card, { selfReport: 'again' }), 'again')
  assert.equal(judge(card, {}), undefined)
})
