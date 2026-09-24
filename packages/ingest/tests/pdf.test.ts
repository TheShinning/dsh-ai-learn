import { test } from 'node:test'
import assert from 'node:assert/strict'

import { runIngestPipeline } from '../../core/src/ingest/types.ts'
import {
  commandAvailable,
  extractPdfTextLayer,
  extractTextFromContentStream,
  pdfBuiltinParser,
  pdfOcrParser,
  pdfPopplerParser,
  runExternalCommand,
} from '../src/pdf.ts'
import { buildPdf } from './helpers/fixtures.ts'

const encoder = new TextEncoder()

test('PDF 内置提取器：FlateDecode 内容流里抠出 Tj 文本（含中文）', () => {
  const bytes = buildPdf('BT /F1 12 Tf 72 720 Td (Hello 学习) Tj ET')
  const result = extractPdfTextLayer(bytes)
  assert.equal(result.text, 'Hello 学习')
  assert.equal(result.pages, 1)
  assert.equal(result.streams, 1)
  assert.equal(result.inflated, 1, 'FlateDecode 流应被 inflate')
  assert.equal(result.imageCount, 0)
  assert.equal(result.reason, undefined)
})

test('PDF 内置提取器：转义 \\( \\) \\\\ 与 TJ 负字距补空格、Td 换行', () => {
  const content = String.raw`BT /F1 12 Tf 72 720 Td (A \(B\) C \\ D) Tj 0 -14 Td [(Ker) -300 (ning)] TJ ET`
  const bytes = buildPdf(content)
  const result = extractPdfTextLayer(bytes)
  assert.equal(result.text, 'A (B) C \\ D\nKer ning')
})

test('PDF 内置提取器：内容流里没有 BT/Tj 时给出解释性原因', () => {
  const bytes = buildPdf('0.5 w 72 72 m 540 720 l S')
  const result = extractPdfTextLayer(bytes)
  assert.equal(result.text, '')
  assert.match(result.reason ?? '', /没有文本绘制指令|扫描件/)
})

test('PDF 内置提取器：扫描件式（只有图像）如实失败，reason 说明是扫描/图片型', () => {
  const bytes = buildPdf('q 100 0 0 100 72 600 cm /Im1 Do Q', { withImage: true })
  const result = extractPdfTextLayer(bytes)
  assert.equal(result.text, '')
  assert.ok(result.imageCount >= 1)
  assert.match(result.reason ?? '', /扫描/)
  assert.match(result.reason ?? '', /图片/)
  assert.match(result.reason ?? '', /OCR|tesseract/)
})

test('PDF 内置解析器：扫描件走管线时是「失败尝试 + 原因」，不是静默成功', async () => {
  const bytes = buildPdf('q 100 0 0 100 72 600 cm /Im1 Do Q', { withImage: true })
  const result = await runIngestPipeline({ bytes, fileName: 'scan.pdf', format: 'pdf', parsers: [pdfBuiltinParser()] })
  assert.equal(result.ok, false)
  assert.equal(result.markdown, '')
  assert.equal(result.attempts[0]?.tier, 'builtin')
  assert.equal(result.attempts[0]?.parser, 'pdf-text-layer')
  assert.equal(result.attempts[0]?.ok, false)
  assert.match(result.attempts[0]?.reason ?? '', /扫描/)
  assert.match(result.advice ?? '', /tesseract/)
})

test('PDF 内置解析器：有文本层但含图像时标记 partial 并说明未 OCR', async () => {
  const bytes = buildPdf('BT /F1 12 Tf 72 720 Td (Hello 学习) Tj ET', { withImage: true })
  const parser = pdfBuiltinParser()
  const parsed = await parser.parse({ bytes, fileName: 'mixed.pdf', format: 'pdf' })
  assert.match(parsed.markdown, /Hello 学习/)
  assert.equal(parsed.partial, true)
  assert.match(parsed.reason ?? '', /内嵌图像未做 OCR/)
})

test('PDF 能力声明：内置层不能处理扫描件，OCR 层声明 handlesScanned', () => {
  const builtin = pdfBuiltinParser()
  assert.equal(builtin.capability.tier, 'builtin')
  assert.equal(builtin.capability.handlesScanned, false)
  assert.equal(builtin.capability.available, true)

  const poppler = pdfPopplerParser()
  assert.equal(poppler.capability.tier, 'external')
  assert.equal(poppler.capability.handlesScanned, false)
  assert.deepEqual(poppler.capability.requires, ['pdftotext'])

  const ocr = pdfOcrParser()
  assert.equal(ocr.capability.tier, 'external')
  assert.equal(ocr.capability.handlesScanned, true)
  assert.deepEqual(ocr.capability.requires, ['pdftoppm', 'tesseract'])
})

test('命令探测：不存在的命令返回 false 且不抛异常', () => {
  assert.equal(commandAvailable('definitely-not-a-real-tool-xyz'), false)
  assert.doesNotThrow(() => commandAvailable('definitely-not-a-real-tool-xyz', ['--nope']))
})

test('外部解析器：依赖缺失时 capability.available=false，管线记成「依赖不可用」', async () => {
  const parser = pdfPopplerParser({ command: 'definitely-not-a-real-pdftotext' })
  assert.equal(parser.capability.available, false)
  const result = await runIngestPipeline({
    bytes: buildPdf('BT /F1 12 Tf 72 720 Td (Hello) Tj ET'),
    fileName: 'a.pdf',
    format: 'pdf',
    parsers: [parser],
  })
  assert.equal(result.ok, false)
  assert.equal(result.attempts.length, 1)
  assert.equal(result.attempts[0]?.ok, false)
  assert.match(result.attempts[0]?.reason ?? '', /^依赖不可用/)
  assert.match(result.attempts[0]?.reason ?? '', /definitely-not-a-real-pdftotext/)
})

test('OCR 解析器：缺 tesseract 时不算可用，被调用也返回依赖不可用而非抛错', async () => {
  const parser = pdfOcrParser({ command: 'nope-tesseract-xyz', rasterCommand: 'nope-pdftoppm-xyz' })
  assert.equal(parser.capability.available, false)
  assert.equal(parser.capability.handlesScanned, true)
  const parsed = await parser.parse({ bytes: buildPdf('BT /F1 12 Tf 72 720 Td (x) Tj ET'), fileName: 'a.pdf', format: 'pdf' })
  assert.equal(parsed.markdown, '')
  assert.match(parsed.reason ?? '', /依赖不可用/)
  assert.match(parsed.reason ?? '', /chi_sim/)
})

test('外部命令执行器：stdout 走文件重定向（不用管道），失败返回结果对象', () => {
  const missing = runExternalCommand('definitely-not-a-real-tool-xyz', ['-v'])
  assert.equal(missing.ok, false)
  assert.equal(missing.status, null)
  assert.ok(missing.spawnError)
  assert.match(missing.command, /definitely-not-a-real-tool-xyz/)

  if (process.platform === 'win32') {
    const ok = runExternalCommand('cmd', ['/c', 'echo hello-from-external'])
    assert.equal(ok.ok, true)
    assert.match(ok.stdout, /hello-from-external/)
    assert.match(ok.command, /echo hello-from-external/)
  }
})

test('extractTextFromContentStream：T* 也换行', () => {
  const text = extractTextFromContentStream('BT /F1 12 Tf 14 TL (first) Tj T* (second) Tj ET')
  assert.equal(text, 'first\nsecond')
})

test('外部 pdftotext：命令可用时真实执行并把完整命令写进 reason', async (t) => {
  const parser = pdfPopplerParser()
  if (!parser.capability.available) {
    t.skip('本机没有 pdftotext（poppler），跳过真实外部解析')
    return
  }
  const bytes = buildPdf('BT /F1 12 Tf 72 720 Td (Hello DSH PDF) Tj ET')
  const result = await parser.parse({ bytes, fileName: 'sample.pdf', format: 'pdf' })
  assert.match(result.reason ?? '', /^外部命令：pdftotext -layout -enc UTF-8 /)
  // 真实 poppler 能读出 ASCII 文本层
  assert.match(result.markdown, /Hello DSH PDF/)
})

test('外部 pdftotext：真的扫描件（无文本层）时返回空文本 + 提示需要 OCR', async (t) => {
  const parser = pdfPopplerParser()
  if (!parser.capability.available) {
    t.skip('本机没有 pdftotext（poppler），跳过')
    return
  }
  const bytes = buildPdf('q 100 0 0 100 72 600 cm /Im1 Do Q', { withImage: true })
  const result = await parser.parse({ bytes, fileName: 'scan.pdf', format: 'pdf' })
  assert.equal(result.markdown, '')
  assert.match(result.reason ?? '', /pdftotext/)
  assert.match(result.reason ?? '', /没有文本层|OCR/)
})

test('PDF 内置提取器：未压缩内容流（无 FlateDecode）也能取到 CJK 文本', () => {
  const content = encoder.encode(Buffer.from('BT /F1 12 Tf 72 720 Td (未压缩流) Tj ET', 'utf8'))
  const body = Buffer.concat([Buffer.from('4 0 obj\n<< /Length ', 'latin1'), Buffer.from(String(content.length), 'latin1'), Buffer.from(' >>\nstream\n', 'latin1'), Buffer.from(content), Buffer.from('\nendstream\nendobj\n', 'latin1')])
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), body, Buffer.from('trailer\n<< /Size 5 >>\n%%EOF\n', 'latin1')])
  const result = extractPdfTextLayer(new Uint8Array(pdf))
  assert.equal(result.text, '未压缩流')
  assert.equal(result.inflated, 0)
})
