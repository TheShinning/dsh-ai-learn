import { test } from 'node:test'
import assert from 'node:assert/strict'

import { detectFormat, runIngestPipeline } from '../../core/src/ingest/types.ts'
import { decodeText, htmlParser, htmlToMarkdown, markdownParser, plainTextParser, tidyMarkdown } from '../src/text.ts'

const encoder = new TextEncoder()
const bytesOf = (text: string): Uint8Array => encoder.encode(text)

test('detectFormat：先按扩展名（大小写不敏感）', () => {
  assert.equal(detectFormat('notes.md'), 'markdown')
  assert.equal(detectFormat('notes.MARKDOWN'), 'markdown')
  assert.equal(detectFormat('notes.mdx'), 'markdown')
  assert.equal(detectFormat('a.txt'), 'text')
  assert.equal(detectFormat('a.log'), 'text')
  assert.equal(detectFormat('a.html'), 'html')
  assert.equal(detectFormat('a.xhtml'), 'html')
  assert.equal(detectFormat('a.pdf'), 'pdf')
  assert.equal(detectFormat('a.docx'), 'docx')
  assert.equal(detectFormat('a.odt'), 'odt')
  assert.equal(detectFormat('a.epub'), 'epub')
  assert.equal(detectFormat('a.PNG'), 'image')
  assert.equal(detectFormat('a.jpeg'), 'image')
  assert.equal(detectFormat('a.webp'), 'image')
  assert.equal(detectFormat('a.unknown-ext'), 'unknown')
})

test('detectFormat：无扩展名时看魔数', () => {
  assert.equal(detectFormat('blob', bytesOf('%PDF-1.7\n')), 'pdf')
  assert.equal(detectFormat('blob', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image')
  assert.equal(detectFormat('blob', new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image')
  // PK 开头是 zip 容器（docx/odt/epub），契约里刻意返回 unknown，细化交给 ingest 层
  assert.equal(detectFormat('blob', new Uint8Array([0x50, 0x4b, 0x03, 0x04])), 'unknown')
  assert.equal(detectFormat('blob', bytesOf('\u0000\u0001\u0002\u0003')), 'unknown')
})

test('markdown：剥 BOM、CRLF 归一、提取标题', async () => {
  const parser = markdownParser()
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf('# 第一章 绪论\r\n\r\n正文第一段。\r\n正文第二行。\r\n')])
  const result = await parser.parse({ bytes: bom, fileName: 'chapter.md', format: 'markdown' })
  assert.equal(result.markdown.includes('\r'), false, 'CRLF 必须归一成 LF')
  assert.equal(result.markdown.includes('\uFEFF'), false, 'BOM 必须剥掉')
  assert.equal(result.markdown.startsWith('# 第一章 绪论'), true)
  assert.equal(result.title, '第一章 绪论')
  assert.equal(result.reason, undefined)
})

test('markdown：front matter 里的 title/author 优先', async () => {
  const parser = markdownParser()
  const source = '---\ntitle: 线性代数讲义\nauthor: 张老师\n---\n\n# 封面\n\n正文。\n'
  const result = await parser.parse({ bytes: bytesOf(source), fileName: 'notes.md', format: 'markdown' })
  assert.equal(result.title, '线性代数讲义')
  assert.equal(result.author, '张老师')
  assert.equal(result.markdown.startsWith('# 封面'), true)
})

test('markdown：空文件不返回「成功的空串」，管线给出诚实失败', async () => {
  const result = await runIngestPipeline({
    bytes: new Uint8Array(0),
    fileName: 'empty.md',
    format: 'markdown',
    parsers: [markdownParser()],
  })
  assert.equal(result.ok, false)
  assert.equal(result.markdown, '')
  assert.equal(result.attempts.length, 1)
  assert.equal(result.attempts[0]?.ok, false)
  assert.match(result.attempts[0]?.reason ?? '', /空/)
  assert.match(result.advice ?? '', /未/)
})

test('markdown：只有空白字符也如实失败', async () => {
  const parser = markdownParser()
  const result = await parser.parse({ bytes: bytesOf('   \n\n\t\n'), fileName: 'blank.md', format: 'markdown' })
  assert.equal(result.markdown, '')
  assert.match(result.reason ?? '', /空白/)
})

test('纯文本：CRLF 归一，标题取首个非空行；控制字符过多则拒绝按文本读', async () => {
  const parser = plainTextParser()
  const ok = await parser.parse({ bytes: bytesOf('  学习笔记  \r\n第二行\r\n'), fileName: 'a.txt', format: 'text' })
  assert.equal(ok.markdown, '学习笔记\n第二行')
  assert.equal(ok.title, '学习笔记')

  const binary = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04, 0x00])
  const rejected = await parser.parse({ bytes: binary, fileName: 'fake.txt', format: 'text' })
  assert.equal(rejected.markdown, '')
  assert.match(rejected.reason ?? '', /二进制/)
})

test('编码判定：非 UTF-8 的文件被如实标注，不静默读成乱码', () => {
  // 「中文测试」的 GBK 字节
  const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4])
  const decoded = decodeText(gbk)
  assert.equal(decoded.lossy, true)
  assert.match(decoded.note ?? '', /UTF-8/)
  assert.equal(decoded.text.includes('\uFFFD'), false, '不该产生替换字符')
  // Node 官方构建带完整 ICU，GB18030 可用时应还原中文
  if (decoded.encoding === 'gb18030') assert.equal(decoded.text, '中文测试')

  const utf16 = new Uint8Array([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65])
  const wide = decodeText(utf16)
  assert.equal(wide.encoding, 'utf-16le')
  assert.equal(wide.text, '中文')
  assert.match(wide.note ?? '', /UTF-16/)
})

test('html：标签剥离、标题与列表映射、实体解码', async () => {
  const html = [
    '<!DOCTYPE html>',
    '<html><head><title>教材第一章</title><style>p { color: red }</style></head>',
    '<body>',
    '  <h1>绪论</h1>',
    '  <p>数学 &amp; 物理 &lt;基础&gt; &nbsp; &#65;&#x42;</p>',
    '  <ul><li>要点一</li><li>要点二</li></ul>',
    '  <ol><li>第一步</li><li>第二步</li></ol>',
    '  <script>var x = 1 < 2</script>',
    '  <div>尾段&hellip;</div>',
    '</body></html>',
  ].join('\n')

  const parser = htmlParser()
  const result = await parser.parse({ bytes: bytesOf(html), fileName: 'chapter.html', format: 'html' })
  assert.equal(result.title, '教材第一章')
  const markdown = result.markdown

  assert.match(markdown, /^# 教材第一章/m)
  assert.match(markdown, /^# 绪论$/m)
  assert.match(markdown, /数学 & 物理 <基础> AB/)
  assert.match(markdown, /^- 要点一$/m)
  assert.match(markdown, /^- 要点二$/m)
  assert.match(markdown, /^1\. 第一步$/m)
  assert.match(markdown, /^2\. 第二步$/m)
  assert.match(markdown, /尾段…/)
  assert.equal(/<\/?(?:p|h1|ul|ol|li|body|html|div)\b/i.test(markdown), false, '不应残留标签')
  assert.equal(markdown.includes('color: red'), false, 'style 内容应被丢弃')
  assert.equal(markdown.includes('var x'), false, 'script 内容应被丢弃')
})

test('html：围栏代码块保留缩进，行内标签与链接转换', () => {
  const markdown = htmlToMarkdown(
    '<p>见 <a href="https://example.com/a?x=1&amp;y=2">文档</a> 与 <strong>加粗</strong>、<em>斜体</em>、<code>f(x)</code>。</p><pre><code>def f(x):\n    return x &lt; 2</code></pre>',
  )
  assert.match(markdown, /\[文档\]\(https:\/\/example\.com\/a\?x=1&y=2\)/)
  assert.match(markdown, /\*\*加粗\*\*/)
  assert.match(markdown, /\*斜体\*/)
  assert.match(markdown, /`f\(x\)`/)
  assert.match(markdown, /```\ndef f\(x\):\n {4}return x < 2\n```/)
})

test('html：没有任何正文时如实失败', async () => {
  const parser = htmlParser()
  const result = await parser.parse({ bytes: bytesOf('<html><head><style>a{}</style></head><body></body></html>'), fileName: 'x.html', format: 'html' })
  assert.equal(result.markdown, '')
  assert.match(result.reason ?? '', /没有可提取|只有/)
})

test('tidyMarkdown：折叠多余空行、保留代码缩进', () => {
  const tidied = tidyMarkdown('a\n\n\n\n\nb\n\n```\n    indented\n```\n')
  assert.equal(tidied, 'a\n\nb\n\n```\n    indented\n```')
})
