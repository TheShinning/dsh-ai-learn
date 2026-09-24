import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { MaterialType } from '../src/types.ts'
import { MATERIAL_TYPE_LABEL } from '../src/types.ts'
import {
  FALLBACK_STRATEGY,
  TEACHING_MODE_INVARIANTS,
  TEACHING_MODE_LABEL,
  materialDirective,
  modeDirective,
  renderStrategy,
  strategyFor,
  teachingModeOf,
  type TeachingMode,
  type TeachingStrategy,
} from '../src/pedagogy/strategy.ts'

const ALL_TYPES: readonly MaterialType[] = [
  'article',
  'textbook',
  'regulation',
  'lecture-notes',
  'exam',
  'answer-analysis',
]

const ALL_MODES: readonly TeachingMode[] = [
  'concept-driven',
  'clause-driven',
  'drill-driven',
  'argument-driven',
  'exam-debrief',
]

test('类型 → 模式是封闭映射：六种材料都有模式，且不越界', () => {
  for (const type of ALL_TYPES) {
    const mode = teachingModeOf(type)
    assert.ok(ALL_MODES.includes(mode), `${type} 映射出不存在的模式 ${mode}`)
  }
  assert.equal(teachingModeOf('regulation'), 'clause-driven')
  assert.equal(teachingModeOf('exam'), 'drill-driven')
  assert.equal(teachingModeOf('article'), 'argument-driven')
  assert.equal(teachingModeOf('answer-analysis'), 'exam-debrief')
  assert.equal(teachingModeOf('textbook'), 'concept-driven')
  assert.equal(teachingModeOf('lecture-notes'), 'concept-driven')
})

test('回归：五种模式在同一段材料上的策略**逐字段确实不同**（不是"字符串非空"）', () => {
  const strategies: TeachingStrategy[] = ALL_TYPES.map((type) => strategyFor(type))

  for (const field of ['questionBias', 'scaffoldLadder', 'wrapUpChecklist', 'cardBias', 'focusBias'] as const) {
    const seen = new Set(strategies.map((strategy) => JSON.stringify(strategy[field])))
    assert.ok(
      seen.size >= 4,
      `${field} 只有 ${seen.size} 种不同取值，模式之间区分度不足`,
    )
  }

  // 抽查两条最该不同的：刷题必须先自答，条例必须先问适用条件
  const drill = strategyFor('exam')
  assert.ok(drill.questionBias.some((line) => /先.*说.*答案/.test(line)), '刷题模式必须先让学生自答')
  const clause = strategyFor('regulation')
  assert.ok(clause.questionBias.some((line) => /适用条件/.test(line)), '条例模式必须先问适用条件')
  const debrief = strategyFor('answer-analysis')
  assert.ok(debrief.questionBias.some((line) => /出题人/.test(line)), '解析模式必须反推出题意图')
})

test('回归：模式只改策略字段，不触碰四条跨模式底线', () => {
  assert.equal(TEACHING_MODE_INVARIANTS.length, 4)
  for (const invariant of TEACHING_MODE_INVARIANTS) assert.ok(invariant.length > 5)

  // 策略对象里**不允许**出现任何能改变底线的字段名
  const forbidden = ['questionBudget', 'mayRevealAnswer', 'mustRetell', 'probeDepth', 'masteryFloor', 'skipRetell']
  for (const type of ALL_TYPES) {
    const keys = Object.keys(strategyFor(type))
    for (const name of forbidden) {
      assert.ok(!keys.includes(name), `${type} 的策略不应包含字段 ${name}`)
    }
  }
})

test('兜底策略就是教材策略（未识别材料按教材教，但由上层负责先问用户）', () => {
  assert.deepEqual(FALLBACK_STRATEGY, strategyFor('textbook'))
})

test('每种模式都有可执行的指令，且不含"直接给答案"这类越线话术', () => {
  for (const mode of ALL_MODES) {
    const text = modeDirective(mode)
    assert.ok(text.length > 20, `${mode} 的指令太短`)
    assert.ok(!/直接告诉|把答案给|先讲答案/.test(text), `${mode} 的指令越过了"先问后讲"`)
  }
  assert.match(modeDirective('drill-driven'), /先让学生自答/)
  assert.match(modeDirective('clause-driven'), /适用条件/)
  assert.match(modeDirective('exam-debrief'), /出题人/)
})

test('渲染摘要包含模式、追问重点、出题偏好、降阶阶梯与收束检查', () => {
  const text = renderStrategy(strategyFor('regulation'))
  assert.match(text, /教学模式：条文驱动/)
  assert.match(text, /追问重点：/)
  assert.match(text, /出题偏好：cloze \/ mnemonic/)
  assert.match(text, /降阶阶梯：.*→/)
  assert.match(text, /收束检查：/)
})

test('materialDirective 把类型直接接到教学动作上（六类都有输出）', () => {
  for (const type of ALL_TYPES) {
    const line = materialDirective(type)
    assert.ok(line.startsWith(MATERIAL_TYPE_LABEL[type]), `${type} 的指令应以类型标签开头`)
    assert.ok(line.length > 20)
  }
  assert.match(materialDirective('exam'), /先让学生自答/)
})

test('模式与标签表一一对应，不出现空标签', () => {
  for (const mode of ALL_MODES) assert.ok(TEACHING_MODE_LABEL[mode].length > 0)
})
