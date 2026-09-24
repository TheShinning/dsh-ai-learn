import { test } from 'node:test'
import assert from 'node:assert/strict'

import { EvidenceIdAllocator, evidenceKey, stableEvidenceDigest } from '../src/knowledge/evidence.ts'

/**
 * 回归来源（2026-09-23 诊断发现）：
 * 证据 id 原先写成 `` `kgev-${evidenceKey(...).length.toString(16)}-${Date.now().toString(36)}` `` ——
 * 用幂等键的**长度**当摘要。同一毫秒内写入的两条不同证据只要键长度相同，id 就完全相同，
 * 而存储层按 id 建键 → **后写覆盖先写**。
 *
 * 实测后果：连续三次"答错"只留下两条证据，追问深度永远到不了 3，
 * 于是"深度 3 才直讲"这条跨模式底线在真实运行里失效（core 单测却全绿，因为纯函数没问题）。
 */

test('回归：幂等键长度相同、内容不同 → 摘要必须不同（旧写法会当成同一条证据）', () => {
  const base = { nodeId: 'n1', kind: 'answer-quality' as const, summary: '第 N 次答错' }
  const keys = [1, 2, 3].map((index) => evidenceKey({ ...base, sourceId: `probe-${index}` }))
  assert.equal(new Set(keys.map((key) => key.length)).size, 1, '三个键长度相同（这正是旧写法的致命前提）')

  const digests = keys.map((key) => stableEvidenceDigest(key))
  assert.equal(new Set(digests).size, 3, '内容摘要必须两两不同')
})

test('摘要稳定：同样的键永远得到同样的摘要（幂等性不被削弱）', () => {
  const left = evidenceKey({ nodeId: 'n1', kind: 'flashcard', sourceId: 'c1', summary: '答对' })
  const right = evidenceKey({ nodeId: 'n1', kind: 'flashcard', sourceId: 'c1', summary: '答对' })
  assert.equal(stableEvidenceDigest(left), stableEvidenceDigest(right))
  assert.match(stableEvidenceDigest(left), /^[0-9a-f]{8}$/)
})

test('回归：同一毫秒内分配多个 id，必须互不相同且单调可解释', () => {
  const allocator = new EvidenceIdAllocator()
  const at = new Date('2026-09-23T10:00:00.000Z')
  const ids = [
    allocator.next(evidenceKey({ nodeId: 'n1', kind: 'answer-quality', sourceId: 's1', summary: 'a' }), at),
    allocator.next(evidenceKey({ nodeId: 'n1', kind: 'answer-quality', sourceId: 's2', summary: 'b' }), at),
    allocator.next(evidenceKey({ nodeId: 'n1', kind: 'answer-quality', sourceId: 's3', summary: 'c' }), at),
  ]
  assert.equal(new Set(ids).size, 3, '同毫秒内不得碰撞')
  assert.ok(ids[0]!.endsWith('-' + at.getTime().toString(36)), '第一条不带序号后缀')
  assert.ok(ids[1]!.endsWith('-1'), '第二条带递增序号')
  assert.ok(ids[2]!.endsWith('-2'), '第三条继续递增')
})

test('跨毫秒时序号归零（id 仍可读、可排序）', () => {
  const allocator = new EvidenceIdAllocator()
  const key = evidenceKey({ nodeId: 'n1', kind: 'note', sourceId: 'x', summary: 'y' })
  const first = allocator.next(key, new Date(1000))
  const second = allocator.next(key, new Date(2000))
  // 1000..toString(36) === 'rs'；2000..toString(36) === '1jk'
  assert.ok(first.endsWith('-rs'), `第一条应是 -rs，实际 ${first}`)
  assert.ok(second.endsWith('-1jk'), `第二条应是 -1jk（跨毫秒后序号归零，不带 -0 后缀），实际 ${second}`)
  assert.ok(!second.endsWith('-0'), '序号 0 不写后缀')
})

test('同一个 allocator 对同一键在同一毫秒返回不同 id（覆盖语义由调用方决定，不由碰撞决定）', () => {
  const allocator = new EvidenceIdAllocator()
  const at = new Date('2026-09-23T10:00:00.000Z')
  const key = evidenceKey({ nodeId: 'n1', kind: 'answer-quality', sourceId: 'same', summary: 'same' })
  assert.notEqual(allocator.next(key, at), allocator.next(key, at))
})
