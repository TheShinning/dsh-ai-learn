import { test } from 'node:test'
import assert from 'node:assert/strict'

import { runIngestPipeline } from '../../core/src/ingest/types.ts'
import type { SourceFormat } from '../../core/src/ingest/types.ts'
import {
  docxParser,
  docxToMarkdown,
  epubParser,
  epubToMarkdown,
  odtParser,
  odtToMarkdown,
  readZipEntries,
  readZipFile,
  readZipText,
  sniffOfficeFormat,
  xmlToMarkdown,
} from '../src/office.ts'
import { ingestBytes, ingestFile, sniffContainerFormat } from '../src/registry.ts'
import { crc32, makeZip, withTempFile } from './helpers/fixtures.ts'

const encoder = new TextEncoder()

/* ------------------------------ 夹具 ------------------------------ */

const DOCX_DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 绪论</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">数学 &amp; 物理是基础。</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>1.1 小节</w:t></w:r></w:p>
<w:p><w:r><w:t>第一行</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>第二行</w:t></w:r></w:p>
<w:p><w:r><w:instrText>TOC \\o "1-3" \\h</w:instrText></w:r><w:r><w:t>目录条目</w:t></w:r></w:p>
<w:p><w:r><w:delText>被删除的旧内容</w:delText></w:r></w:p>
</w:body></w:document>`

const DOCX_CORE = `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>线性代数讲义</dc:title><dc:creator>张老师</dc:creator></cp:coreProperties>`

function docxBytes(): Uint8Array {
  return makeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: '_rels/.rels', data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>' },
    { name: 'word/document.xml', data: DOCX_DOCUMENT },
    { name: 'docProps/core.xml', data: DOCX_CORE },
    { name: 'word/media/image1.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
  ])
}

const ODT_CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0">
<office:body><office:text>
<text:h text:outline-level="1">第一章 导论</text:h>
<text:p>普通段落 &amp; 实体。</text:p>
<text:p>带<text:span>行内片段</text:span>与<text:tab/>制表符<text:s text:c="3"/>以及多个空格。</text:p>
<table:table><table:table-row>
<table:table-cell><text:p>单元格A</text:p></table:table-cell>
<table:table-cell><text:p>单元格B</text:p></table:table-cell>
</table:table-row></table:table>
<office:annotation><text:p>批注不该出现在正文里</text:p></office:annotation>
</office:text></office:body></office:document-content>`

const ODT_META = `<?xml version="1.0" encoding="UTF-8"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"><office:meta><dc:title>离散数学笔记</dc:title><meta:initial-creator>李老师</meta:initial-creator></office:meta></office:document-meta>`

function odtBytes(): Uint8Array {
  return makeZip([
    { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text', store: true },
    { name: 'META-INF/manifest.xml', data: '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>' },
    { name: 'content.xml', data: ODT_CONTENT },
    { name: 'meta.xml', data: ODT_META },
  ])
}

const EPUB_CONTAINER = `<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`

const EPUB_OPF = `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>学习之道</dc:title><dc:creator>芭芭拉·奥克利</dc:creator></metadata><manifest><item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/><item id="css" href="style.css" media-type="text/css"/></manifest><spine toc="ncx"><itemref idref="c2"/><itemref idref="c1"/></spine></package>`

function chapter(title: string, heading: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body><h1>${heading}</h1><p>${body}</p></body></html>`
}

function epubBytes(): Uint8Array {
  return makeZip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: EPUB_CONTAINER },
    { name: 'OEBPS/content.opf', data: EPUB_OPF },
    { name: 'OEBPS/text/ch1.xhtml', data: chapter('第一章 专注', '专注模式', '专注让人深入。') },
    { name: 'OEBPS/text/ch2.xhtml', data: chapter('第二章 发散', '发散模式', '发散带来灵感。') },
    { name: 'OEBPS/style.css', data: 'body { font-family: serif }' },
  ])
}

/* ------------------------------ 测试 ------------------------------ */

test('ZIP 读取器：自造 stored + deflate 条目能原样读回（含独立 CRC32 交叉校验）', () => {
  const documentXml = '<w:p><w:t>中文内容 &amp; 符号</w:t></w:p>'
  const zip = makeZip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'word/document.xml', data: documentXml },
    { name: 'nested/dir/file.txt', data: '嵌套目录条目' },
  ])

  const entries = readZipEntries(zip)
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['mimetype', 'word/document.xml', 'nested/dir/file.txt'],
  )
  assert.equal(entries[0]?.method, 0, 'stored 条目方法号应为 0')
  assert.equal(entries[1]?.method, 8, 'deflate 条目方法号应为 8')
  assert.equal(entries[1]?.crc32, crc32(encoder.encode(documentXml)), '中央目录里的 CRC32 应与独立实现一致')
  assert.equal(entries[1]?.uncompressedSize, encoder.encode(documentXml).length)

  assert.equal(readZipText(zip, 'word/document.xml'), documentXml)
  assert.equal(readZipText(zip, 'mimetype'), 'application/epub+zip')
  assert.equal(readZipText(zip, 'nested/dir/file.txt'), '嵌套目录条目')
  assert.equal(readZipFile(zip, 'not-there.xml'), undefined)
  assert.deepEqual([...(readZipFile(zip, 'mimetype') ?? [])], [...encoder.encode('application/epub+zip')])
})

test('ZIP 读取器：没有中央目录时退回扫本地文件头，且支持 subarray 视图', () => {
  const zip = makeZip([
    { name: 'a.txt', data: '第一个' },
    { name: 'b/c.txt', data: '第二个条目内容' },
  ])
  // 从中央目录签名处截断，模拟「只有本地头」的截断 zip
  let centralStart = -1
  for (let index = 0; index + 4 <= zip.length; index += 1) {
    if (zip[index] === 0x50 && zip[index + 1] === 0x4b && zip[index + 2] === 0x01 && zip[index + 3] === 0x02) {
      centralStart = index
      break
    }
  }
  assert.ok(centralStart > 0, '夹具里应当存在中央目录')
  const view = zip.subarray(0, centralStart) // byteOffset 不为 0，专门覆盖 DataView 偏移处理
  const entries = readZipEntries(view)
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['a.txt', 'b/c.txt'],
  )
  assert.equal(readZipText(view, 'b/c.txt'), '第二个条目内容')
})

test('ZIP 读取器：非 ZIP 输入报出可读错误，不静默成功', () => {
  assert.throws(() => readZipEntries(encoder.encode('%PDF-1.4 这不是 zip')), /ZIP/)
  assert.throws(() => readZipEntries(new Uint8Array([1, 2, 3])), /太小|ZIP/)
})

test('docx：走管线取出正文、标题作者，并丢掉域代码/修订删除内容', async () => {
  const bytes = docxBytes()
  const result = await runIngestPipeline({ bytes, fileName: 'book.docx', format: 'docx', parsers: [docxParser()] })

  assert.equal(result.ok, true)
  assert.equal(result.format, 'docx')
  assert.equal(result.title, '线性代数讲义')
  assert.equal(result.author, '张老师')
  assert.equal(result.attempts[0]?.parser, 'docx-zip')
  assert.equal(result.attempts[0]?.tier, 'builtin')

  const markdown = result.markdown
  assert.match(markdown, /^# 第一章 绪论$/m)
  assert.match(markdown, /^## 1\.1 小节$/m)
  assert.match(markdown, /数学 & 物理是基础。/)
  assert.match(markdown, /第一行\n第二行/)
  assert.match(markdown, /目录条目/)
  assert.equal(markdown.includes('被删除的旧内容'), false, '修订删除内容不应进入正文')
  assert.equal(markdown.includes('TOC'), false, '域代码不应进入正文')
  assert.equal(result.partial, true, '含图片时标为 partial')
  assert.match(result.attempts[0]?.reason ?? '', /图片/)
})

test('odt：标题层级、行内片段、表格与批注处理', () => {
  const result = odtToMarkdown(odtBytes())
  assert.equal(result.title, '离散数学笔记')
  assert.equal(result.author, '李老师')
  assert.match(result.markdown, /^# 第一章 导论$/m)
  assert.match(result.markdown, /普通段落 & 实体。/)
  assert.match(result.markdown, /行内片段/)
  assert.match(result.markdown, /单元格A/)
  assert.match(result.markdown, /单元格B/)
  assert.equal(result.markdown.includes('批注不该出现在正文里'), false, '批注不应进入正文')
})

test('epub：按 spine 顺序拼接章节，标题作者取自 OPF', () => {
  const result = epubToMarkdown(epubBytes())
  assert.equal(result.title, '学习之道')
  assert.equal(result.author, '芭芭拉·奥克利')
  assert.equal(result.partial, false)
  const first = result.markdown.indexOf('发散模式')
  const second = result.markdown.indexOf('专注模式')
  assert.ok(first >= 0 && second >= 0, '两章都应在正文里')
  assert.ok(first < second, `spine 顺序应是 c2 → c1（实际 ${first} vs ${second}）`)
  assert.match(result.markdown, /^# 第二章 发散$/m)
  assert.match(result.markdown, /发散带来灵感。/)
  assert.equal(result.markdown.includes('font-family'), false, 'CSS 不应进入正文')
})

test('epub：spine 缺失时按文件名兜底并标 partial', () => {
  const bytes = makeZip([
    { name: 'META-INF/container.xml', data: EPUB_CONTAINER },
    { name: 'OEBPS/content.opf', data: EPUB_OPF.replace(/<spine[\s\S]*?<\/spine>/, '') },
    { name: 'OEBPS/text/ch1.xhtml', data: chapter('第一章 专注', '专注模式', '专注让人深入。') },
    { name: 'OEBPS/text/ch2.xhtml', data: chapter('第二章 发散', '发散模式', '发散带来灵感。') },
  ])
  const result = epubToMarkdown(bytes)
  assert.equal(result.partial, true)
  assert.match(result.reason ?? '', /spine/)
  assert.match(result.markdown, /专注模式/)
  assert.match(result.markdown, /发散模式/)
})

test('sniffOfficeFormat / sniffContainerFormat：扩展名不可靠时用容器内部结构判定', () => {
  assert.equal(sniffOfficeFormat(['word/document.xml', '[Content_Types].xml']), 'docx')
  assert.equal(sniffOfficeFormat(['content.xml', 'META-INF/manifest.xml']), 'odt')
  assert.equal(sniffOfficeFormat(['META-INF/container.xml', 'OEBPS/content.opf']), 'epub')
  assert.equal(sniffOfficeFormat(['random.txt']), undefined)
  assert.equal(sniffContainerFormat(docxBytes()), 'docx')
  assert.equal(sniffContainerFormat(epubBytes()), 'epub')
  assert.equal(sniffContainerFormat(encoder.encode('这不是 zip')), undefined)
})

test('ingestBytes：没有扩展名的 docx 也能被认出来（走容器嗅探）', async () => {
  const result = await ingestBytes({ bytes: docxBytes(), fileName: 'no-extension' })
  assert.equal(result.format, 'docx')
  assert.equal(result.ok, true)
  assert.ok('markdown' in result)
  if ('markdown' in result) assert.match(result.markdown, /第一章 绪论/)
})

test('ingestFile：真实落盘的 docx 走完整入口', async () => {
  await withTempFile('讲义.docx', docxBytes(), async (path) => {
    const result = await ingestFile(path)
    assert.equal(result.format, 'docx')
    assert.equal(result.ok, true)
    assert.ok('markdown' in result)
    if ('markdown' in result) {
      assert.match(result.markdown, /第一章 绪论/)
      assert.equal(result.title, '线性代数讲义')
    }
  })
})

test('docx 解析器：不是 zip 的 docx 抛出可读错误（管线会记进 attempts）', async () => {
  const result = await runIngestPipeline({
    bytes: encoder.encode('其实是一段纯文本'),
    fileName: 'broken.docx',
    format: 'docx',
    parsers: [docxParser()],
  })
  assert.equal(result.ok, false)
  assert.match(result.attempts[0]?.reason ?? '', /ZIP/)
})

test('xmlToMarkdown：空文档返回空串，交给管线判失败', () => {
  assert.equal(xmlToMarkdown('<w:document xmlns:w="x"><w:body/></w:document>', 'docx'), '')
})

test('容器解析器能力声明：builtin 层、不处理扫描件、无需外部依赖', () => {
  for (const parser of [docxParser(), odtParser(), epubParser()]) {
    assert.equal(parser.capability.tier, 'builtin')
    assert.equal(parser.capability.handlesScanned, false)
    assert.equal(parser.capability.available, true)
    assert.equal(parser.capability.formats.length, 1)
  }
  const formats = [docxParser(), odtParser(), epubParser()].map((parser) => parser.capability.formats[0] as SourceFormat)
  assert.deepEqual(formats, ['docx', 'odt', 'epub'])
})
