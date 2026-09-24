import { test } from 'node:test'
import assert from 'node:assert/strict'

import { runIngestPipeline } from '../../core/src/ingest/types.ts'
import type { IngestTier, SourceFormat, SourceParser } from '../../core/src/ingest/types.ts'
import { capabilities, clearParserCache, defaultParsers } from '../src/registry.ts'

type FakeOptions = {
  readonly id: string
  readonly tier: IngestTier
  readonly formats?: readonly SourceFormat[]
  readonly available?: boolean
  readonly requires?: readonly string[]
  readonly markdown?: string
  readonly reason?: string
  readonly partial?: boolean
  readonly throwMessage?: string
}

/** 造一个可观测的假解析器：记录被调用的顺序。 */
function fakeParser(options: FakeOptions, order: string[]): SourceParser {
  return {
    capability: {
      id: options.id,
      tier: options.tier,
      formats: options.formats ?? ['pdf'],
      handlesScanned: false,
      available: options.available ?? true,
      requires: options.requires,
    },
    parse: async () => {
      order.push(options.id)
      if (options.throwMessage) throw new Error(options.throwMessage)
      return { markdown: options.markdown ?? '', reason: options.reason, partial: options.partial }
    },
  }
}

test('runIngestPipeline：按 native → builtin → external 顺序编排（与传入顺序无关）', async () => {
  const order: string[] = []
  const parsers = [
    fakeParser({ id: 'ext', tier: 'external', markdown: '外部层文本' }, order),
    fakeParser({ id: 'foreign', tier: 'external', markdown: '不该被调用' }, order),
    fakeParser({ id: 'built', tier: 'builtin', markdown: '内置层文本' }, order),
    fakeParser({ id: 'nat', tier: 'native', markdown: '' }, order),
  ]
  const result = await runIngestPipeline({ bytes: new Uint8Array([1]), fileName: 'a.pdf', format: 'pdf', parsers })

  assert.equal(result.ok, true)
  assert.equal(result.markdown, '内置层文本')
  assert.deepEqual(order, ['nat', 'built'], 'native 先跑；成功即停，external 不该被调用')
  assert.deepEqual(
    result.attempts.map((attempt) => `${attempt.tier}:${attempt.parser}`),
    ['native:nat', 'builtin:built'],
  )
  assert.equal(result.attempts[0]?.ok, false)
  assert.equal(result.attempts[1]?.ok, true)
})

test('runIngestPipeline：全部失败时 attempts 仍是完整 tier 顺序轨迹', async () => {
  const order: string[] = []
  const parsers = [
    fakeParser({ id: 'ext', tier: 'external' }, order),
    fakeParser({ id: 'nat', tier: 'native' }, order),
    fakeParser({ id: 'built', tier: 'builtin' }, order),
  ]
  const result = await runIngestPipeline({ bytes: new Uint8Array([1]), fileName: 'a.pdf', format: 'pdf', parsers })
  assert.equal(result.ok, false)
  assert.deepEqual(order, ['nat', 'built', 'ext'])
  assert.deepEqual(
    result.attempts.map((attempt) => attempt.tier),
    ['native', 'builtin', 'external'],
  )
})

test('runIngestPipeline：不可用依赖记成失败尝试，reason 以「依赖不可用」开头并列出缺什么', async () => {
  const order: string[] = []
  const result = await runIngestPipeline({
    bytes: new Uint8Array([1]),
    fileName: 'scan.pdf',
    format: 'pdf',
    parsers: [fakeParser({ id: 'pdf-ocr', tier: 'external', available: false, requires: ['pdftoppm', 'tesseract'] }, order)],
  })
  assert.equal(result.ok, false)
  assert.deepEqual(order, [], '不可用的解析器不该被调用')
  assert.equal(result.attempts[0]?.ok, false)
  assert.match(result.attempts[0]?.reason ?? '', /^依赖不可用/)
  assert.match(result.attempts[0]?.reason ?? '', /pdftoppm, tesseract/)
})

test('runIngestPipeline：空文本的「成功」不算成功，会继续降级到下一层', async () => {
  const order: string[] = []
  const result = await runIngestPipeline({
    bytes: new Uint8Array([1]),
    fileName: 'scan.pdf',
    format: 'pdf',
    parsers: [
      fakeParser({ id: 'nat', tier: 'native', markdown: '   \n  ', reason: '该 PDF 看起来是扫描件，没有文本层' }, order),
      fakeParser({ id: 'built', tier: 'builtin', markdown: '内置层救回来了' }, order),
    ],
  })
  assert.equal(result.ok, true)
  assert.equal(result.markdown, '内置层救回来了')
  assert.deepEqual(order, ['nat', 'built'])
  assert.equal(result.attempts[0]?.ok, false)
  assert.match(result.attempts[0]?.reason ?? '', /扫描件/)
  assert.equal(result.attempts[1]?.ok, true)
})

test('runIngestPipeline：解析器抛错被记进 reason，而不是炸掉整条管线', async () => {
  const order: string[] = []
  const result = await runIngestPipeline({
    bytes: new Uint8Array([1]),
    fileName: 'broken.docx',
    format: 'docx',
    parsers: [fakeParser({ id: 'docx-zip', tier: 'builtin', formats: ['docx'], throwMessage: 'docx 里找不到 word/document.xml' }, order)],
  })
  assert.equal(result.ok, false)
  assert.match(result.attempts[0]?.reason ?? '', /word\/document\.xml/)
})

test('runIngestPipeline：PDF 全失败时的 advice 给出对的安装提示', async () => {
  const order: string[] = []
  const withUnavailable = await runIngestPipeline({
    bytes: new Uint8Array([1]),
    fileName: 'scan.pdf',
    format: 'pdf',
    parsers: [
      fakeParser({ id: 'pdf-text-layer', tier: 'builtin', markdown: '', reason: '扫描件/图片型 PDF，没有文本层' }, order),
      fakeParser({ id: 'pdftoppm-tesseract', tier: 'external', available: false, requires: ['pdftoppm', 'tesseract'] }, order),
    ],
  })
  assert.equal(withUnavailable.ok, false)
  assert.match(withUnavailable.advice ?? '', /poppler/)
  assert.match(withUnavailable.advice ?? '', /tesseract/)
  assert.match(withUnavailable.advice ?? '', /pdftoppm-tesseract/)

  const withoutUnavailable = await runIngestPipeline({
    bytes: new Uint8Array([1]),
    fileName: 'scan.pdf',
    format: 'pdf',
    parsers: [fakeParser({ id: 'pdf-text-layer', tier: 'builtin', markdown: '', reason: '扫描件' }, order)],
  })
  assert.equal(withoutUnavailable.ok, false)
  assert.match(withoutUnavailable.advice ?? '', /tesseract/)
  assert.match(withoutUnavailable.advice ?? '', /chi_sim/)
})

test('defaultParsers：返回的解析器列表按 tier 有序、顺序稳定且覆盖全部格式', async () => {
  clearParserCache()
  const parsers = await defaultParsers()
  assert.deepEqual(
    parsers.map((parser) => `${parser.capability.tier}:${parser.capability.id}`),
    [
      'native:markdown-passthrough',
      'native:text-passthrough',
      'builtin:html-strip',
      'builtin:text-fallback',
      'builtin:pdf-text-layer',
      'builtin:docx-zip',
      'builtin:odt-zip',
      'builtin:epub-zip',
      'external:pdftotext',
      'external:pdftoppm-tesseract',
    ],
  )
  const formats = new Set(parsers.flatMap((parser) => parser.capability.formats))
  for (const format of ['markdown', 'text', 'html', 'pdf', 'docx', 'odt', 'epub', 'unknown'] as const) {
    assert.equal(formats.has(format), true, `应声明支持 ${format}`)
  }
  // 二次调用走缓存，返回同一批解析器（外部命令探测不会反复执行）
  assert.equal(await defaultParsers(), parsers)
})

test('capabilities：给 UI 的能力清单包含原生视觉与 PDF 各层，并标注 handlesScanned', async () => {
  const list = await capabilities()
  const byId = new Map(list.map((capability) => [capability.id, capability]))

  const image = byId.get('image-native-vision')
  assert.ok(image, '应声明图像原生视觉能力')
  assert.equal(image.tier, 'native')
  assert.equal(image.handlesScanned, true)
  assert.deepEqual(image.formats, ['image'])

  assert.equal(byId.get('pdf-text-layer')?.handlesScanned, false)
  assert.equal(byId.get('pdftotext')?.handlesScanned, false)
  assert.equal(byId.get('pdftoppm-tesseract')?.handlesScanned, true)

  const tiers = list.map((capability) => capability.tier)
  assert.deepEqual([...tiers].sort((left, right) => ['native', 'builtin', 'external'].indexOf(left) - ['native', 'builtin', 'external'].indexOf(right)), tiers, 'tier 必须有序')

  const external = byId.get('pdftoppm-tesseract')
  assert.deepEqual(external?.requires, ['pdftoppm', 'tesseract'])
  assert.equal(typeof external?.available, 'boolean')
})
