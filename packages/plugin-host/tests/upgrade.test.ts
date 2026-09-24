import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 升级安全回归（S3.7 / `docs/versioning-and-upgrade.md` §3.2）。
 *
 * ## 为什么这条必须有，而且要用**真实后端**
 *
 * 读 `@deepseek-ai/dsh-storage-json` 的实现得到一条反直觉的事实：
 * 本域是 `layout: 'per-record'`，每条记录一个文件、**每个文件带版本戳**；
 * 读取时只接受"当前版本 + `compatibleVersions`"，**不在集合里的戳会让该记录读作"不存在"——
 * 是丢弃，不是迁移，而且不报错**。
 *
 * 也就是说：给域加了新表、把 `version` 从 1 提到 2，却忘了写 `compatibleVersions: [1]`，
 * 用户升级后会看到"教材、证据、复习排期全空了"，且没有任何错误。这种坑用假实现测不出来 ——
 * 必须让**真后端**去读写真文件。
 *
 * 本测试同时给出**反证**：`compatibleVersions: []` 时旧记录确实读不到，
 * 证明这条测试真的在防这个坑，而不是"恰好通过"。
 */

const UNIT = 'study_alongwith_ai'
const V1_TABLES = ['textbooks', 'nodes', 'edges', 'evidence', 'cards', 'learner_state']
const V2_TABLES = [...V1_TABLES, 'sessions']

function descriptor(version: number, compatibleVersions: number[]) {
  return {
    name: UNIT,
    version,
    tables: version === 1 ? V1_TABLES : V2_TABLES,
    hasGlobal: true,
    layout: 'per-record' as const,
    compatibleVersions,
  }
}

type Unit = {
  loadAll(): Promise<{ version: number; global: unknown; tables: Record<string, Record<string, unknown>> }>
  putRecord(table: string, key: string, value: unknown): Promise<void>
  close(): Promise<void>
}

let backendModule: typeof import('@deepseek-ai/dsh-storage-json') | undefined
let skipReason: string | undefined
try {
  backendModule = (await import('@deepseek-ai/dsh-storage-json')) as typeof import('@deepseek-ai/dsh-storage-json')
} catch (error) {
  skipReason = error instanceof Error ? error.message : String(error)
}

/** 读出磁盘上该记录文件的原始版本戳（用于断言后端没有偷偷改写它）。 */
function rawStamp(root: string, table: string, key: string): number {
  const file = join(root, UNIT, table, `${key}.json`)
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version: number; record: unknown }
  return parsed.version
}

test('升级安全：v2 域声明 compatibleVersions:[1] 时，v1 记录照常读入', { skip: skipReason }, async () => {
  const Backend = (backendModule as unknown as { JsonStorageBackend: new (root: string) => { kv: { open(d: unknown): Promise<Unit> }; close(): Promise<void> } }).JsonStorageBackend
  const root = mkdtempSync(join(tmpdir(), 'study-upgrade-'))

  // —— ① 先按 v1 写入一本教材（模拟"用户已经在用旧版本"）
  const v1Backend = new Backend(root)
  const v1 = await v1Backend.kv.open(descriptor(1, []))
  const textbook = {
    key: 'book:demo',
    title: '实践论',
    sourceRef: 'pasted-text',
    sourceFormat: 'markdown|textbook|explicit',
    revision: '0123456789abcdef',
    parsedAt: '2026-09-25T10:00:00.000Z',
    parseStatus: 'ready',
    parseError: null,
    structureVersion: 1,
    createdAt: '2026-09-25T10:00:00.000Z',
    updatedAt: '2026-09-25T10:00:00.000Z',
  }
  await v1.putRecord('textbooks', 'book_demo', textbook)
  await v1.close()
  await v1Backend.close()

  // 磁盘上确实是 v1 的戳，且目录里能看到这条记录
  assert.equal(rawStamp(root, 'textbooks', 'book_demo'), 1)
  assert.ok(readdirSync(join(root, UNIT, 'textbooks')).includes('book_demo.json'))

  // —— ② 升级到 v2（**声明** compatibleVersions: [1]）：旧记录必须还在
  const v2Backend = new Backend(root)
  const upgraded = await v2Backend.kv.open(descriptor(2, [1]))
  const loaded = await upgraded.loadAll()
  assert.deepEqual(
    loaded.tables.textbooks?.book_demo,
    textbook,
    'v1 的教材记录必须在 v2 域里读得到（这正是 compatibleVersions 的作用）',
  )
  assert.deepEqual(loaded.tables.sessions ?? {}, {}, 'v1 数据在新表 sessions 里就是空表（平滑升级，无需迁移）')

  // 后端不得偷偷改写旧文件的版本戳（否则"回退到旧版本"会变成数据丢失）
  assert.equal(rawStamp(root, 'textbooks', 'book_demo'), 1, '旧记录的版本戳应保持原样')
  await upgraded.close()
  await v2Backend.close()
})

test('反证：忘了写 compatibleVersions 时，旧记录**静默消失**（不是报错，这正是危险之处）', { skip: skipReason }, async () => {
  const Backend = (backendModule as unknown as { JsonStorageBackend: new (root: string) => { kv: { open(d: unknown): Promise<Unit> }; close(): Promise<void> } }).JsonStorageBackend
  const root = mkdtempSync(join(tmpdir(), 'study-upgrade-bad-'))

  const v1Backend = new Backend(root)
  const v1 = await v1Backend.kv.open(descriptor(1, []))
  await v1.putRecord('textbooks', 'book_demo', { key: 'book:demo', title: '实践论' })
  await v1.putRecord('evidence', 'ev_1', { id: 'ev-1', nodeId: 's1', kind: 'answer-quality', summary: '答对', createdAt: '2026-09-25T10:00:00.000Z' })
  await v1.close()
  await v1Backend.close()

  // 升到 v2 但**不列** compatibleVersions —— 这是要防的写法
  const bad = new Backend(root)
  const broken = await bad.kv.open(descriptor(2, []))
  const loaded = await broken.loadAll()
  assert.deepEqual(loaded.tables.textbooks ?? {}, {}, '不列 compatibleVersions 时旧教材读不到（丢弃而非迁移）')
  assert.deepEqual(loaded.tables.evidence ?? {}, {}, '旧证据同样消失')
  // 文件还在磁盘上 —— 所以"能救"，但用户界面上就是"数据没了"
  assert.ok(readdirSync(join(root, UNIT, 'textbooks')).includes('book_demo.json'), '文件仍在磁盘上（未被删除）')
  await broken.close()
  await bad.close()
})

test('本仓库的 STUDY_DOMAIN 必须声明 compatibleVersions（防止有人改回 version:2 却忘了这一行）', { skip: skipReason }, async () => {
  const { STUDY_DOMAIN } = await import('../src/storage.ts')
  assert.equal(STUDY_DOMAIN.version, 2, 'S3.7 之后域版本应为 2')
  assert.deepEqual(
    [...(STUDY_DOMAIN.compatibleVersions ?? [])],
    [1],
    '必须接受 v1 记录，否则用户升级后学习数据会**静默消失**（见 docs/versioning-and-upgrade.md §3.2）',
  )
  assert.ok(Object.keys(STUDY_DOMAIN.tables).includes('sessions'), '新表 sessions 必须在声明里')
})
