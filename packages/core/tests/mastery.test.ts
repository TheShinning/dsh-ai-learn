import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Evidence } from '../src/knowledge/evidence.ts'
import {
  MASTERY_POSITIVE_KIND_FLOOR,
  deriveMastery,
  hasReachedBloom,
  isPositiveEvidence,
  masteryFromEvidence,
  masteryWithout,
  positiveKindCount,
  suggestBloomLevel,
} from '../src/knowledge/mastery.ts'

let counter = 0
function evidence(partial: Partial<Evidence> & Pick<Evidence, 'kind'>): Evidence {
  counter += 1
  return {
    id: `e${String(counter).padStart(4, '0')}`,
    nodeId: 'kg:section:book-demo-ch001-sec001',
    sourceId: `s${counter}`,
    summary: `证据 ${counter}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, counter)).toISOString(),
    ...partial,
  }
}

test('isPositiveEvidence 是唯一正向判定，且严格看 correct/result', () => {
  assert.equal(isPositiveEvidence(evidence({ kind: 'flashcard', correct: true })), true)
  assert.equal(isPositiveEvidence(evidence({ kind: 'flashcard', correct: false })), false)
  assert.equal(isPositiveEvidence(evidence({ kind: 'code-lab', result: 'run' })), true)
  // 原系统正常路径会把"失败的代码实验"也算成正向种类（宽松判定），这里必须为 false
  assert.equal(isPositiveEvidence(evidence({ kind: 'code-lab', result: 'error' })), false)
  assert.equal(isPositiveEvidence(evidence({ kind: 'note' })), false)
  assert.equal(isPositiveEvidence(evidence({ kind: 'blackboard' })), false)
  assert.equal(isPositiveEvidence(evidence({ kind: 'mastery-confirm', mastery: 'confused' })), true)
  assert.equal(isPositiveEvidence(evidence({ kind: 'answer-quality', result: 'light' })), true)
  assert.equal(isPositiveEvidence(evidence({ kind: 'srs-review', srsResult: 'good' })), true)
  assert.equal(isPositiveEvidence(evidence({ kind: 'srs-review', srsResult: 'again' })), false)
})

test('回归：一条笔记 + 一次失败的代码实验，不得被判为已掌握', () => {
  // 这是原系统的真实缺陷：写入路径把 note/code-lab 直接计为正向种类，
  // 而重放路径用严格判定，同一份证据两个结论。
  const set = [
    evidence({ kind: 'note', mastery: 'partial' }),
    evidence({ kind: 'code-lab', result: 'error' }),
  ]
  assert.equal(positiveKindCount(set), 0)
  assert.equal(masteryFromEvidence(set), 'partial')
  assert.notEqual(masteryFromEvidence(set), 'mastered')
})

test('合法的多元正向组合可以点亮', () => {
  const set = [
    evidence({ kind: 'flashcard', correct: true }),
    evidence({ kind: 'code-lab', result: 'run' }),
  ]
  assert.equal(positiveKindCount(set), 2)
  assert.equal(masteryFromEvidence(set), 'mastered')
})

test('困惑具有否决权：种类再多也不提升为已掌握', () => {
  const set = [
    evidence({ kind: 'flashcard', correct: true }),
    evidence({ kind: 'code-lab', result: 'run' }),
    evidence({ kind: 'answer-quality', mastery: 'confused', result: 'clarify' }),
  ]
  assert.equal(positiveKindCount(set), 2)
  assert.equal(masteryFromEvidence(set), 'confused')
})

test('显式 mastery 覆盖一切', () => {
  const set = [
    evidence({ kind: 'flashcard', correct: true }),
    evidence({ kind: 'code-lab', result: 'run' }),
    evidence({ kind: 'mastery-confirm', mastery: 'confused' }),
  ]
  assert.equal(masteryFromEvidence(set), 'confused')
})

test('增量推导与整体推导按构造相等（原系统双路径不对称的结构性修复）', () => {
  // 确定性伪随机序列，避免 flaky
  let seed = 20260731
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const kinds: Evidence['kind'][] = ['note', 'flashcard', 'code-lab', 'answer-quality', 'srs-review', 'mastery-confirm']

  for (let round = 0; round < 200; round += 1) {
    const history: Evidence[] = []
    for (let index = 0; index < 6; index += 1) {
      const kind = kinds[Math.floor(rand() * kinds.length) ]!
      history.push(evidence({
        kind,
        correct: kind === 'flashcard' ? rand() > 0.4 : undefined,
        result: kind === 'code-lab' ? (rand() > 0.5 ? 'run' : 'error')
          : kind === 'answer-quality' ? (rand() > 0.5 ? 'light' : 'consolidate')
          : undefined,
        srsResult: kind === 'srs-review' ? (rand() > 0.5 ? 'good' : 'again') : undefined,
        mastery: kind === 'mastery-confirm' ? (rand() > 0.5 ? 'mastered' : 'partial') : undefined,
      }))
    }

    // 逐条增量推进
    let incremental = masteryFromEvidence([history[0]!])
    for (let index = 1; index < history.length; index += 1) {
      incremental = deriveMastery(history.slice(0, index), history[index]!)
    }
    // 一次性整体推导
    const whole = masteryFromEvidence(history)
    assert.equal(incremental, whole, `第 ${round} 轮：增量=${incremental} 整体=${whole}`)
  }
})

test('撤销任意一条证据都能重算，不需要 previousMastery 快照', () => {
  const confirm = evidence({ kind: 'mastery-confirm', mastery: 'mastered' })
  const set = [
    evidence({ kind: 'flashcard', correct: true }),
    evidence({ kind: 'code-lab', result: 'run' }),
    confirm,
  ]
  assert.equal(masteryFromEvidence(set), 'mastered')
  // 去掉人工确认后，仍靠两条正向证据成立
  assert.equal(masteryWithout(set, confirm.id), 'mastered')
  // 去掉人工确认与一条正向证据后回落
  const weak = masteryWithout(set, confirm.id)
  assert.equal(weak, 'mastered')
  const remaining = set.filter((item) => item.id !== confirm.id)
  const dropOne = remaining.slice(0, 1)
  assert.notEqual(masteryFromEvidence(dropOne), 'mastered')
})

test('正向种类门限与常量一致', () => {
  assert.equal(MASTERY_POSITIVE_KIND_FLOOR, 2)
  assert.equal(
    masteryFromEvidence([evidence({ kind: 'answer-quality', result: 'light' })]),
    'partial',
    '单一正向证据只能到半掌握',
  )
})

test('suggestBloomLevel 返回封闭联合值（原系统写的是转义文本）', () => {
  assert.equal(suggestBloomLevel(0, 0), 'remember')
  assert.equal(suggestBloomLevel(2, 0), 'understand')
  assert.equal(suggestBloomLevel(3, 1), 'apply')
  // 关键回归：绝不能是 "\\u5e94\\u7528" 这类字面量
  const value: string = suggestBloomLevel(5, 2)
  assert.ok(!value.includes('\\u'), `布鲁姆层级不得包含转义字面量，实际=${value}`)
})

test('hasReachedBloom 支持"达到或高于"目标层级', () => {
  const applied = [evidence({ kind: 'answer-quality', result: 'light', bloomLevel: 'apply' })]
  const analyzed = [evidence({ kind: 'answer-quality', result: 'light', bloomLevel: 'analyze' })]
  const remembered = [evidence({ kind: 'answer-quality', result: 'light', bloomLevel: 'remember' })]
  assert.equal(hasReachedBloom(applied, 'apply'), true)
  assert.equal(hasReachedBloom(analyzed, 'apply'), true, '高于目标的层级也应满足')
  assert.equal(hasReachedBloom(remembered, 'apply'), false)
})
