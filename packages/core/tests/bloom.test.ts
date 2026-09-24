import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BLOOM_LABEL,
  BLOOM_LEVELS,
  bloomAtLeast,
  isBloomLevel,
  normalizeBloomLevel,
} from '../src/types.ts'

test('回归：原系统写进库的转义字面量必须被解码回合法层级', () => {
  // learning.masteryEvaluator.ts:230/233/236 真实写入过这些 12 字符文本
  assert.equal(normalizeBloomLevel('\\u8bb0\\u5fc6'), 'remember')
  assert.equal(normalizeBloomLevel('\\u7406\\u89e3'), 'understand')
  assert.equal(normalizeBloomLevel('\\u5e94\\u7528'), 'apply')
})

test('中文标签与常见别名都能收敛', () => {
  assert.equal(normalizeBloomLevel('记忆'), 'remember')
  assert.equal(normalizeBloomLevel('应用'), 'apply')
  assert.equal(normalizeBloomLevel('comprehension'), 'understand')
  assert.equal(normalizeBloomLevel('  apply  '), 'apply')
})

test('未知输入收敛为兜底值，不会把脏数据写进持久层', () => {
  assert.equal(normalizeBloomLevel('乱写'), 'remember')
  assert.equal(normalizeBloomLevel(''), 'remember')
  assert.equal(normalizeBloomLevel(undefined), 'remember')
  assert.equal(normalizeBloomLevel(null), 'remember')
  assert.equal(normalizeBloomLevel(42), 'remember')
  assert.equal(normalizeBloomLevel('x', 'apply'), 'apply')
  for (const level of BLOOM_LEVELS) {
    assert.equal(isBloomLevel(normalizeBloomLevel(level)), true)
  }
})

test('层级比较按认知递进顺序', () => {
  assert.equal(bloomAtLeast('apply', 'apply'), true)
  assert.equal(bloomAtLeast('analyze', 'apply'), true)
  assert.equal(bloomAtLeast('understand', 'apply'), false)
  assert.equal(bloomAtLeast('remember', 'remember'), true)
})

test('值域与标签分离：标签是中文，值是 ASCII 标识', () => {
  for (const level of BLOOM_LEVELS) {
    assert.match(level, /^[a-z]+$/)
    assert.ok(BLOOM_LABEL[level].length > 0)
    assert.ok(!/\\u/.test(BLOOM_LABEL[level]))
  }
  assert.equal(BLOOM_LEVELS.length, 6)
})
