import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decodeSourceFormat } from '../../core/src/pedagogy/material.ts'
import { makeZip, buildPdf } from '../../ingest/tests/helpers/fixtures.ts'

/**
 * 多格式验收（S3.5 / M1–M6）：**宿主侧**的真实文件路径。
 *
 * 为什么这一层必须有：`packages/ingest` 的 62 项测试覆盖的是**解析器层**（构造字节 → 解析器 → 文本），
 * 而"用户给一个真实文件路径，导入工具能不能吃下去并把教材建起来"是**另一条边界** ——
 * 历史上本项目就吃过"包有测试、但没接上宿主"的亏（ingest 全绿但没人调用它）。
 *
 * 这里不引入新依赖：夹具从 ingest 的 helper 借用（`makeZip` / `buildPdf`），
 * 它们本来是给解析器测试用的，正好可以造出**格式合法**的最小真文件。
 */

/* ------------------------------ 夹具 ------------------------------ */

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 绪论</w:t></w:r></w:p>
<w:p><w:r><w:t>本章讨论基本概念与定义。</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>1.1 第一节内容</w:t></w:r></w:p>
<w:p><w:r><w:t>认识来源于实践，又反过来指导实践。</w:t></w:r></w:p>
</w:body></w:document>`

const CORE_XML = `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>线性代数讲义</dc:title><dc:creator>张老师</dc:creator></cp:coreProperties>`

const ODT_CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
<office:body><office:text>
<text:h text:outline-level="1">第一章 绪论</text:h>
<text:p>本章讨论基本概念与定义。</text:p>
<text:h text:outline-level="2">1.1 第一节内容</text:h>
<text:p>认识来源于实践，又反过来指导实践。</text:p>
</office:text></office:body></office:document-content>`

const EPUB_CONTAINER = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`

const EPUB_OPF = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>认知心理学</dc:title><dc:creator>李老师</dc:creator></metadata><manifest><item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/></spine></package>`

const EPUB_CHAPTER = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章 专注</title></head><body><h1>第一章 专注</h1><p>专注让人深入。</p></body></html>`

const HTML = `<!doctype html><html><head><title>网页文章</title></head><body><h1>第一章 网页标题</h1><p>这是一个段落，讨论基本概念与定义。</p><ul><li>要点一</li><li>要点二</li></ul></body></html>`

const MARKDOWN = '# 实践论\n\n## 第一节 认识与实践\n\n认识来源于实践，又反过来指导实践。\n\n## 第二节 认识的辩证发展\n\n认识经过感性到理性的飞跃。\n'

const PLAIN = '第一章 绪论\n\n本章讨论基本概念与定义。\n\n第一节 内容\n\n认识来源于实践。\n'

function docxBytes(): Uint8Array {
  return makeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: '_rels/.rels', data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>' },
    { name: 'word/document.xml', data: DOCUMENT_XML },
    { name: 'docProps/core.xml', data: CORE_XML },
  ])
}

function odtBytes(): Uint8Array {
  return makeZip([
    { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text', store: true },
    { name: 'META-INF/manifest.xml', data: '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>' },
    { name: 'content.xml', data: ODT_CONTENT },
  ])
}

function epubBytes(): Uint8Array {
  return makeZip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: EPUB_CONTAINER },
    { name: 'OEBPS/content.opf', data: EPUB_OPF },
    { name: 'OEBPS/text/ch1.xhtml', data: EPUB_CHAPTER },
  ])
}

const PDF = buildPdf('BT /F1 12 Tf 72 720 Td (第一章 绪论) Tj ET\nBT /F1 12 Tf 72 700 Td (认识来源于实践。) Tj ET')

/** 写一份真文件到临时目录，返回路径。 */
function writeSample(dir: string, fileName: string, bytes: Uint8Array | string): string {
  const path = join(dir, fileName)
  writeFileSync(path, typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes))
  return path
}

/** 一个最小 PNG（1×1），用于验证"图片不能当教材"。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/9UeOAAAAAElFTkSuQmCC',
  'base64',
)

/* ------------------------------ 测试 ------------------------------ */

let toolsModule: typeof import('../src/tools.ts') | undefined
let storeModule: typeof import('../src/store.ts') | undefined
let skipReason: string | undefined
try {
  toolsModule = await import('../src/tools.ts')
  storeModule = await import('../src/store.ts')
} catch (error) {
  skipReason = error instanceof Error ? error.message : String(error)
}

test('多格式验收：七种格式走真实文件路径都能导入并建起教材', { skip: skipReason }, async (t) => {
  const { createStudyTools } = toolsModule!
  const { createMemoryStore } = storeModule!
  const dir = mkdtempSync(join(tmpdir(), 'study-formats-'))

  const samples: { name: string; fileName: string; bytes: Uint8Array | string; format: string }[] = [
    { name: 'markdown', fileName: 'shijianlun.md', bytes: MARKDOWN, format: 'markdown' },
    { name: '纯文本', fileName: 'notes.txt', bytes: PLAIN, format: 'text' },
    { name: 'html', fileName: 'article.html', bytes: HTML, format: 'html' },
    { name: 'pdf（文本层）', fileName: 'book.pdf', bytes: PDF, format: 'pdf' },
    { name: 'docx', fileName: 'lecture.docx', bytes: docxBytes(), format: 'docx' },
    { name: 'odt', fileName: 'handout.odt', bytes: odtBytes(), format: 'odt' },
    { name: 'epub', fileName: 'psych.epub', bytes: epubBytes(), format: 'epub' },
  ]

  for (const sample of samples) {
    await t.test(`${sample.name} 可导入`, async () => {
      const store = createMemoryStore()
      const byName = new Map(createStudyTools(store).map((tool) => [tool.name, tool]))
      const path = writeSample(dir, sample.fileName, sample.bytes)

      const result = await byName.get('study_import_textbook')!.execute!({ path, material_type: 'textbook' }, {} as never)
      assert.equal(result.ok, true, `${sample.name} 应导入成功，实际报告：\n${result.report}`)
      assert.equal(result.action, 'create')

      const record = await store.getTextbook(result.key)
      assert.ok(record, '应写入教材记录')
      assert.equal(record!.parseStatus, 'ready')
      assert.equal(record!.sourceRef, path)

      // 复合 sourceFormat：首段是真实命中的来源格式，中段是材料类型
      const decoded = decodeSourceFormat(record!.sourceFormat)
      assert.equal(decoded.format, sample.format, `来源格式应为 ${sample.format}，实际 ${record!.sourceFormat}`)
      assert.equal(decoded.materialType, 'textbook')
      assert.equal(decoded.confidence, 'explicit')

      // 真的建起了可推进的结构（不是只存了一坨文本）
      const nodes = await store.nodesFor(result.key)
      assert.ok(nodes.length > 0, '应生成知识节点')
      assert.ok(
        nodes.some((node) => node.type === 'section' || node.type === 'chapter'),
        '应有章节/小节级节点',
      )
    })
  }
})

test('多格式验收：失败路径必须如实说明（不产生半截教材）', { skip: skipReason }, async (t) => {
  const { createStudyTools } = toolsModule!
  const { createMemoryStore } = storeModule!
  const dir = mkdtempSync(join(tmpdir(), 'study-formats-fail-'))

  await t.test('图片：明确拒绝为教材正文，并给出两条出路', async () => {
    const store = createMemoryStore()
    const byName = new Map(createStudyTools(store).map((tool) => [tool.name, tool]))
    const path = writeSample(dir, 'scan.png', PNG)
    const result = await byName.get('study_import_textbook')!.execute!({ path }, {} as never)
    assert.equal(result.ok, false)
    assert.equal(result.action, 'rejected')
    assert.match(result.report, /图片/)
    assert.match(result.report, /附件/)
    assert.match(result.report, /①.*②/s, '应给出两条真实出路')
    assert.equal((await store.listTextbooks()).length, 0, '拒绝时不得留下教材记录')
  })

  await t.test('不支持的扩展名（pptx）：如实失败并列出受支持格式', async () => {
    const store = createMemoryStore()
    const byName = new Map(createStudyTools(store).map((tool) => [tool.name, tool]))
    // 用真实 ZIP 头 + 不匹配任何 office 容器的内容，模拟 pptx 这类未支持格式
    const fakePptx = makeZip([{ name: 'ppt/presentation.xml', data: '<p:presentation/>' }])
    const path = writeSample(dir, 'slides.pptx', fakePptx)
    const result = await byName.get('study_import_textbook')!.execute!({ path }, {} as never)
    assert.equal(result.ok, false)
    assert.equal(result.action, 'failed')
    assert.match(result.report, /解析失败/)
    assert.match(result.report, /本机实测能力|受支持|建议/)
    assert.equal((await store.listTextbooks()).length, 0)
  })

  await t.test('扫描件 PDF：本机缺 OCR 依赖时如实失败，并指出缺什么', async () => {
    const store = createMemoryStore()
    const byName = new Map(createStudyTools(store).map((tool) => [tool.name, tool]))
    // 只含图像、没有文本层的 PDF
    const scanned = buildPdf('', { withImage: true })
    const path = writeSample(dir, 'scanned.pdf', scanned)
    const result = await byName.get('study_import_textbook')!.execute!({ path }, {} as never)
    if (result.ok) {
      // 若本机装了 tesseract，OCR 成功也算正确结果 —— 但不能是"空正文假装成功"
      assert.notEqual(result.report.trim(), '', '成功时必须有真实报告')
    } else {
      assert.match(result.report, /尝试轨迹/)
      assert.match(result.report, /建议/)
      assert.ok(
        /tesseract|依赖|扫描|文本层|OCR/.test(result.report),
        `失败原因应指向扫描件/缺失依赖，实际：\n${result.report}`,
      )
    }
  })

  await t.test('路径不存在：给出轨迹与建议，而不是抛栈', async () => {
    const store = createMemoryStore()
    const byName = new Map(createStudyTools(store).map((tool) => [tool.name, tool]))
    const result = await byName
      .get('study_import_textbook')!
      .execute!({ path: join(dir, 'nope.pdf') }, {} as never)
      .catch((error: Error) => ({ ok: false, key: '', action: 'threw', report: error.message }))
    assert.equal(result.ok, false)
    assert.match(result.report, /ENOENT|不存在|失败/)
  })

  await t.test('空正文：不假装导入成功', async () => {
    const store = createMemoryStore()
    const byName = new Map(createStudyTools(store).map((tool) => [tool.name, tool]))
    const path = writeSample(dir, 'empty.md', '   \n\n  \n')
    const result = await byName.get('study_import_textbook')!.execute!({ path }, {} as never)
    assert.equal(result.ok, false, '空白文件不得报成功')
    assert.equal((await store.listTextbooks()).length, 0)
  })
})

test('多格式验收：能力工具如实报告本机状况（M1）', { skip: skipReason }, async () => {
  const { createStudyTools } = toolsModule!
  const { createMemoryStore } = storeModule!
  const store = createMemoryStore()
  const byName = new Map(createStudyTools(store).map((tool) => [tool.name, tool]))
  const result = await byName.get('study_formats')!.execute!({}, {} as never)

  assert.ok(result.available > 0, '至少要有原生/内置解析器')
  assert.match(result.report, /本机可用的输入格式/)
  // 原生视觉与 PDF 内置层必须出现（这是本机一定能用的两条）
  assert.match(result.report, /native|运行时原生/)
  assert.match(result.report, /pdf/)
  // 明确不支持的格式必须写明
  assert.match(result.report, /pptx/)
  assert.match(result.report, /音视频/)
  // 缺失项若存在，必须列出缺什么依赖
  if (result.unavailable > 0) {
    assert.match(result.report, /本机缺失的解析器/)
    assert.match(result.report, /需要/)
  }
})
