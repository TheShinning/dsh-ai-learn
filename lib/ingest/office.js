/**
 * Office / 电子书容器解析：docx、odt、epub。
 *
 * 三种格式本质都是 ZIP + XML，所以这里自带一个最小 ZIP 读取器（本地文件头 + 中央目录，
 * 支持 stored=0 / deflate=8，另带 ZIP64 与「没有中央目录时扫本地头」的兜底），
 * 再用一个 XML 走查器把正文转成 Markdown，最后复用 `src/text.ts` 的实体解码与规整。
 *
 * 诚实边界（无依赖解析器的必然取舍）：
 * - docx 的标题识别靠 `w:pStyle` 样式名（Heading1/标题1）与 `w:outlineLvl`；样式经
 *   `styles.xml` 间接映射成标题名的情况识别不出来，会退化成普通段落；
 * - 表格线性化成 `| a | b |`，不还原合并单元格；
 * - 图片、批注、修订删除内容、域代码（TOC/页码）会被丢弃，因此 `partial` 可能为真；
 * - docx 文本框（`w:txbxContent`）里的段落会被当普通段落读出（可能顺序不完美）。
 */

import { inflateRawSync, inflateSync } from 'node:zlib'

                                                                                                  
import { decodeEntities, decodeText, htmlToMarkdown, tidyMarkdown } from './text.js'

/* ------------------------------------------------------------------ *
 * 最小 ZIP 读取器
 * ------------------------------------------------------------------ */

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_ZIP64_EOCD = 0x06064b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const SIG_DATA_DESCRIPTOR = 0x08074b50

/** ZIP 目录项。尺寸/偏移一律以中央目录为准（本地头在流式写入时可能为 0）。 */
                        
                       
                         
                        
                                 
                                   
                        
                                    
 

function fail(message        )        {
  throw new Error(message)
}

function viewOf(bytes            )           {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function readU16(view          , offset        )                     {
  if (offset < 0 || offset + 2 > view.byteLength) return undefined
  return view.getUint16(offset, true)
}

function readU32(view          , offset        )                     {
  if (offset < 0 || offset + 4 > view.byteLength) return undefined
  return view.getUint32(offset, true)
}

function readU64(view          , offset        )                     {
  if (offset < 0 || offset + 8 > view.byteLength) return undefined
  const value = view.getBigUint64(offset, true)
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(value)
}

function decodeZipName(bytes            , _flags        )         {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return decodeText(bytes).text
  }
}

function findEocd(view          )                     {
  const min = Math.max(0, view.byteLength - 22 - 0xffff)
  for (let offset = view.byteLength - 22; offset >= min; offset -= 1) {
    if (readU32(view, offset) !== SIG_EOCD) continue
    const commentLength = readU16(view, offset + 20) ?? 0
    if (offset + 22 + commentLength === view.byteLength) return offset
  }
  return undefined
}

                                                                                                    

/** 读 ZIP64 扩展字段（0x0001）：字段按「溢出的那一项」顺序排列。 */
function parseZip64Extra(bytes            , needSizes         , needOffset         )             {
  const view = viewOf(bytes)
  let cursor = 0
  const result             = {}
  while (cursor + 4 <= bytes.byteLength) {
    const id = readU16(view, cursor) ?? 0
    const size = readU16(view, cursor + 2) ?? 0
    if (id === 0x0001) {
      let inner = cursor + 4
      if (needSizes) {
        result.uncompressedSize = readU64(view, inner)
        inner += 8
        result.compressedSize = readU64(view, inner)
        inner += 8
      }
      if (needOffset) result.localHeaderOffset = readU64(view, inner)
      return result
    }
    cursor += 4 + size
  }
  return result
}

function readCentralDirectory(bytes            , view          , eocd        )             {
  let total = readU16(view, eocd + 10) ?? 0
  let cdOffset = readU32(view, eocd + 16) ?? 0
  if (total === 0xffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20
    if (readU32(view, locator) === SIG_ZIP64_LOCATOR) {
      const zip64Offset = readU64(view, locator + 8)
      if (zip64Offset !== undefined && readU32(view, zip64Offset) === SIG_ZIP64_EOCD) {
        total = readU64(view, zip64Offset + 32) ?? total
        cdOffset = readU64(view, zip64Offset + 48) ?? cdOffset
      }
    }
  }
  const entries             = []
  let cursor = cdOffset
  for (let index = 0; index < total; index += 1) {
    if (readU32(view, cursor) !== SIG_CENTRAL) break
    const flags = readU16(view, cursor + 8) ?? 0
    const method = readU16(view, cursor + 10) ?? 0
    let compressedSize = readU32(view, cursor + 20) ?? 0
    let uncompressedSize = readU32(view, cursor + 24) ?? 0
    const nameLength = readU16(view, cursor + 28) ?? 0
    const extraLength = readU16(view, cursor + 30) ?? 0
    const commentLength = readU16(view, cursor + 32) ?? 0
    let localHeaderOffset = readU32(view, cursor + 42) ?? 0
    const crc32 = readU32(view, cursor + 16) ?? 0
    const nameStart = cursor + 46
    const name = decodeZipName(bytes.subarray(nameStart, nameStart + nameLength), flags)

    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      const extra = bytes.subarray(nameStart + nameLength, nameStart + nameLength + extraLength)
      const zip64 = parseZip64Extra(extra, uncompressedSize === 0xffffffff || compressedSize === 0xffffffff, localHeaderOffset === 0xffffffff)
      if (zip64.uncompressedSize !== undefined) uncompressedSize = zip64.uncompressedSize
      if (zip64.compressedSize !== undefined) compressedSize = zip64.compressedSize
      if (zip64.localHeaderOffset !== undefined) localHeaderOffset = zip64.localHeaderOffset
    }

    entries.push({ name, method, flags, compressedSize, uncompressedSize, crc32, localHeaderOffset })
    cursor = nameStart + nameLength + extraLength + commentLength
  }
  if (!entries.length) return scanLocalHeaders(bytes, view)
  return entries
}

/** 兜底：没有可用的中央目录时，顺序扫本地文件头（截断/流式 zip 常见）。 */
function scanLocalHeaders(bytes            , view          )             {
  const entries             = []
  let cursor = 0
  while (cursor + 30 <= view.byteLength) {
    if (readU32(view, cursor) !== SIG_LOCAL) {
      cursor += 1
      continue
    }
    const flags = readU16(view, cursor + 6) ?? 0
    const method = readU16(view, cursor + 8) ?? 0
    const crc32 = readU32(view, cursor + 14) ?? 0
    let compressedSize = readU32(view, cursor + 18) ?? 0
    const uncompressedSize = readU32(view, cursor + 22) ?? 0
    const nameLength = readU16(view, cursor + 26) ?? 0
    const extraLength = readU16(view, cursor + 28) ?? 0
    const name = decodeZipName(bytes.subarray(cursor + 30, cursor + 30 + nameLength), flags)
    const dataStart = cursor + 30 + nameLength + extraLength
    if (compressedSize === 0 && (flags & 0x08) !== 0) {
      let next = -1
      for (let probe = dataStart; probe + 4 <= view.byteLength; probe += 1) {
        const signature = readU32(view, probe)
        if (signature === SIG_LOCAL || signature === SIG_CENTRAL) {
          next = probe
          break
        }
      }
      let end = next < 0 ? view.byteLength : next
      if (readU32(view, end - 16) === SIG_DATA_DESCRIPTOR) end -= 16
      else if (readU32(view, end - 12) === SIG_DATA_DESCRIPTOR) end -= 12
      compressedSize = Math.max(0, end - dataStart)
    }
    entries.push({ name, method, flags, compressedSize, uncompressedSize, crc32, localHeaderOffset: cursor })
    cursor = dataStart + (compressedSize > 0 ? compressedSize : 0)
  }
  return entries
}

/** 读取 ZIP 目录。不是 ZIP（签名对不上）时抛错，消息可直接给用户看。 */
export function readZipEntries(bytes            )             {
  if (bytes.byteLength < 22) fail('文件太小，不是有效的 ZIP 容器（docx/odt/epub 都是 ZIP）')
  const view = viewOf(bytes)
  const eocd = findEocd(view)
  if (eocd === undefined) {
    const entries = scanLocalHeaders(bytes, view)
    if (!entries.length) fail('不是有效的 ZIP 容器：找不到中央目录，也扫不到本地文件头（文件可能损坏或被加密）')
    return entries
  }
  return readCentralDirectory(bytes, view, eocd)
}

/** 解压单个条目。 */
export function readZipEntryData(bytes            , entry          )             {
  const view = viewOf(bytes)
  if (readU32(view, entry.localHeaderOffset) !== SIG_LOCAL) {
    fail(`ZIP 条目 ${entry.name} 的本地文件头签名不正确（文件可能被截断）`)
  }
  const nameLength = readU16(view, entry.localHeaderOffset + 26) ?? 0
  const extraLength = readU16(view, entry.localHeaderOffset + 28) ?? 0
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > bytes.byteLength) fail(`ZIP 条目 ${entry.name} 的数据越界（文件可能被截断）`)
  const data = bytes.subarray(dataStart, dataEnd)
  if (entry.method === 0) return data
  if (entry.method === 8) {
    try {
      return new Uint8Array(inflateRawSync(data))
    } catch {
      try {
        return new Uint8Array(inflateSync(data))
      } catch (error) {
        fail(`ZIP 条目 ${entry.name} 解压失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  fail(`ZIP 条目 ${entry.name} 使用了不支持的压缩方式 ${entry.method}（仅支持 stored/deflate）`)
}

function findZipEntry(entries                     , name        )                       {
  const wanted = name.replace(/\\/g, '/').replace(/^\.\//, '')
  return (
    entries.find((entry) => entry.name === wanted) ??
    entries.find((entry) => entry.name.toLowerCase() === wanted.toLowerCase()) ??
    entries.find((entry) => entry.name.endsWith(`/${wanted}`))
  )
}

/** 按名字取条目字节；找不到返回 undefined。 */
export function readZipFile(bytes            , name        )                         {
  const entry = findZipEntry(readZipEntries(bytes), name)
  return entry ? readZipEntryData(bytes, entry) : undefined
}

/** 按名字取条目文本（自动做编码判定）。 */
export function readZipText(bytes            , name        )                     {
  const data = readZipFile(bytes, name)
  return data ? decodeText(data).text : undefined
}

/* ------------------------------------------------------------------ *
 * 容器格式嗅探（扩展名缺失时用）
 * ------------------------------------------------------------------ */

/** 用 zip 内部结构判断 docx / odt / epub。 */
export function sniffOfficeFormat(names                   )                           {
  const lower = names.map((name) => name.toLowerCase())
  if (lower.includes('word/document.xml')) return 'docx'
  if (lower.includes('meta-inf/container.xml')) return 'epub'
  if (lower.includes('content.xml') && lower.includes('meta-inf/manifest.xml')) return 'odt'
  if (lower.includes('content.xml')) return 'odt'
  return undefined
}

/* ------------------------------------------------------------------ *
 * XML → Markdown
 * ------------------------------------------------------------------ */

                                

                 
                       
                             
                      
                  
                         
               
 

/** 只跳过「含文本但不想保留」的元素；纯属性容器（pPr/rPr/tblPr）不跳，否则会漏掉标题样式。 */
const XML_SKIP_ELEMENTS = new Set([
  'script',
  'style',
  'instrText',
  'delInstrText',
  'delText',
  'drawing',
  'pict',
  'object',
  'annotation',
  'comment',
  'scripts',
])

function localName(name        )         {
  const index = name.indexOf(':')
  return index >= 0 ? name.slice(index + 1) : name
}

function attributeValue(tag        , name        )                     {
  const match = new RegExp(`(?:^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag)
  if (!match) return undefined
  return match[1] ?? match[2]
}

function headingLevelFromStyle(value        )         {
  if (!value) return 0
  const match = /(?:heading|标题|標題)\s*([1-6])/i.exec(value) ?? /^([1-6])$/.exec(value.trim())
  return match?.[1] ? Number.parseInt(match[1], 10) : 0
}

/**
 * docx / odt 的 XML 正文 → Markdown。
 *
 * 用「标签流走查 + 帧栈」而不是正则替换整段，因为 docx 段落里嵌着大量属性元素，
 * 非贪婪正则会在第一个 `</w:p>` 上截断嵌套结构。
 */
export function xmlToMarkdown(xml        , dialect            )         {
  const parts           = []
  const frames             = []
  const skipped           = []
  const tagPattern = /<[^>]*>/g
  let lastIndex = 0
  let match                        

  const inTable = ()          => frames.some((frame) => frame.table)
  const currentParagraph = ()                       => {
    for (let index = frames.length - 1; index >= 0; index -= 1) {
      const frame = frames[index] 
      if (frame.paragraph) return frame
    }
    return undefined
  }
  const currentTable = ()                       => {
    for (let index = frames.length - 1; index >= 0; index -= 1) {
      const frame = frames[index] 
      if (frame.table) return frame
    }
    return undefined
  }
  const emit = (text        )       => {
    if (text) parts.push(text)
  }
  const emitText = (text        )       => {
    if (!text) return
    const frame = currentParagraph()
    if (frame && !frame.emitted) {
      frame.emitted = true
      if (frame.headingLevel > 0) emit(`${'#'.repeat(Math.min(frame.headingLevel, 6))} `)
    }
    emit(text)
  }
  const popFrame = (name        )                       => {
    const top = frames[frames.length - 1]
    if (top && top.name === name) return frames.pop()
    for (let index = frames.length - 1; index >= 0; index -= 1) {
      if (frames[index] .name === name) return frames.splice(index, 1)[0]
    }
    return undefined
  }
  const paragraphBreak = ()         => (inTable() ? '\n' : '\n\n')

  while ((match = tagPattern.exec(xml)) !== null) {
    const text = xml.slice(lastIndex, match.index)
    lastIndex = tagPattern.lastIndex
    if (text && skipped.length === 0 && (!/^\s*$/.test(text) || !text.includes('\n'))) emitText(text)

    const tag = match[0]
    if (tag.startsWith('<!')) continue
    const head = /^<\s*(\/?)\s*([A-Za-z_][\w.:-]*)/.exec(tag)
    if (!head) continue
    const closing = head[1] === '/'
    const name = localName(head[2] )
    const selfClosing = /\/\s*>$/.test(tag)

    if (skipped.length > 0) {
      if (!closing && !selfClosing && XML_SKIP_ELEMENTS.has(name)) skipped.push(name)
      else if (closing && skipped[skipped.length - 1] === name) skipped.pop()
      continue
    }
    if (!closing && XML_SKIP_ELEMENTS.has(name)) {
      if (!selfClosing) skipped.push(name)
      continue
    }

    if (!closing) {
      if (name === 'p' || name === 'h') {
        emit(paragraphBreak())
        const outline = name === 'h' ? Number.parseInt(attributeValue(tag, 'text:outline-level') ?? attributeValue(tag, 'outline-level') ?? '0', 10) : 0
        const frame           = {
          name,
          paragraph: true,
          headingLevel: Number.isFinite(outline) ? Math.min(Math.max(outline, 0), 6) : 0,
          emitted: false,
          table: false,
          cells: 0,
        }
        if (!selfClosing) frames.push(frame)
        continue
      }
      if (dialect === 'docx' && name === 'pStyle') {
        const frame = currentParagraph()
        const value = attributeValue(tag, 'w:val') ?? attributeValue(tag, 'val') ?? ''
        if (frame && !frame.emitted) frame.headingLevel = headingLevelFromStyle(value)
        continue
      }
      if (dialect === 'docx' && name === 'outlineLvl') {
        const frame = currentParagraph()
        const value = Number.parseInt(attributeValue(tag, 'w:val') ?? attributeValue(tag, 'val') ?? '', 10)
        if (frame && !frame.emitted && Number.isFinite(value)) frame.headingLevel = Math.min(Math.max(value + 1, 1), 6)
        continue
      }
      if (name === 'tbl' || name === 'table') {
        emit(paragraphBreak())
        if (!selfClosing) frames.push({ name, paragraph: false, headingLevel: 0, emitted: false, table: true, cells: 0 })
        continue
      }
      if (name === 'tr' || name === 'table-row') {
        const table = currentTable()
        if (table) table.cells = 0
        emit('\n')
        continue
      }
      if (name === 'tc' || name === 'th' || name === 'td' || name === 'table-cell') {
        const table = currentTable()
        if (table) {
          const first = table.cells === 0
          table.cells += 1
          emit(first ? '| ' : ' | ')
        } else {
          emit(' | ')
        }
        continue
      }
      if (name === 'br' || name === 'cr' || name === 'line-break') {
        emit('\n')
        continue
      }
      if (name === 'tab') {
        emit(' ')
        continue
      }
      if (name === 's') {
        const raw = Number.parseInt(attributeValue(tag, 'text:c') ?? attributeValue(tag, 'c') ?? '1', 10)
        emit(' '.repeat(Number.isFinite(raw) && raw > 0 ? Math.min(raw, 40) : 1))
        continue
      }
      if (name === 'noBreakHyphen') {
        emit('-')
        continue
      }
      continue
    }

    if (name === 'p' || name === 'h') {
      const frame = popFrame(name)
      if (frame?.emitted) emit(paragraphBreak())
      continue
    }
    if (name === 'tbl' || name === 'table') {
      popFrame(name)
      emit('\n\n')
      continue
    }
    if (name === 'tr' || name === 'table-row') {
      emit(' |')
      continue
    }
  }

  return tidyMarkdown(decodeEntities(parts.join('')))
}

/* ------------------------------------------------------------------ *
 * docx / odt / epub
 * ------------------------------------------------------------------ */

function pickTag(xml        , tag        )                     {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)</${escaped}>`, 'i').exec(xml)
  const text = match?.[1] ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim() : ''
  return text || undefined
}

/** docx：`word/document.xml` 正文 + `docProps/core.xml` 元数据。 */
export function docxToMarkdown(bytes            )                                                                                           {
  const entries = readZipEntries(bytes)
  const document = readZipText(bytes, 'word/document.xml')
  if (!document) fail('docx 里找不到 word/document.xml（文件可能不是 docx、已被加密或已损坏）')
  const markdown = xmlToMarkdown(document, 'docx')
  const core = readZipText(bytes, 'docProps/core.xml')
  const notes           = []
  if (!markdown) notes.push('文档正文里没有可提取的文本')
  if (entries.some((entry) => entry.name.startsWith('word/media/'))) notes.push('文档包含图片，未做 OCR')
  return {
    markdown,
    title: core ? pickTag(core, 'dc:title') : undefined,
    author: core ? (pickTag(core, 'dc:creator') ?? pickTag(core, 'cp:lastModifiedBy')) : undefined,
    partial: notes.length > 0,
    reason: notes.length ? `docx 文本层：${notes.join('；')}` : undefined,
  }
}

/** odt：`content.xml` 正文 + `meta.xml` 元数据。 */
export function odtToMarkdown(bytes            )                                                                                           {
  const entries = readZipEntries(bytes)
  const content = readZipText(bytes, 'content.xml')
  if (!content) fail('odt 里找不到 content.xml（文件可能不是 odt 或已损坏）')
  const markdown = xmlToMarkdown(content, 'odt')
  const meta = readZipText(bytes, 'meta.xml')
  const notes           = []
  if (!markdown) notes.push('文档正文里没有可提取的文本')
  if (entries.some((entry) => entry.name.startsWith('Pictures/'))) notes.push('文档包含图片，未做 OCR')
  return {
    markdown,
    title: meta ? pickTag(meta, 'dc:title') : undefined,
    author: meta ? (pickTag(meta, 'meta:initial-creator') ?? pickTag(meta, 'dc:creator')) : undefined,
    partial: notes.length > 0,
    reason: notes.length ? `odt 文本层：${notes.join('；')}` : undefined,
  }
}

function resolveZipPath(baseDirectory        , href        )         {
  const clean = href.split('#')[0] ?? ''
  let decoded = clean
  try {
    decoded = decodeURIComponent(clean)
  } catch {
    /* 保留原样 */
  }
  const segments = `${baseDirectory ? `${baseDirectory}/` : ''}${decoded}`.split('/')
  const stack           = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') stack.pop()
    else stack.push(segment)
  }
  return stack.join('/')
}

                                                                                                                               

function parseOpf(opf        )                                                     {
  const items = new Map                ()
  const properties = new Map                ()
  for (const match of opf.matchAll(/<item\b([^>]*)\/?>/gi)) {
    const attributes = match[1] ?? ''
    const id = attributeValue(attributes, 'id')
    const href = attributeValue(attributes, 'href')
    if (!id || !href) continue
    items.set(id, decodeEntities(href))
    properties.set(id, attributeValue(attributes, 'media-type') ?? '')
  }
  const spineBlock = /<spine\b[^>]*>([\s\S]*?)<\/spine>/i.exec(opf)?.[1] ?? ''
  const spine           = []
  for (const match of spineBlock.matchAll(/<itemref\b([^>]*)\/?>/gi)) {
    const idref = attributeValue(match[1] ?? '', 'idref')
    if (idref) spine.push(idref)
  }
  return { items, properties, spine, title: pickTag(opf, 'dc:title'), author: pickTag(opf, 'dc:creator') }
}

/** epub：container.xml → OPF → 按 spine 顺序拼接 XHTML 章节。 */
export function epubToMarkdown(bytes            )                                                                                           {
  const entries = readZipEntries(bytes)
  const names = entries.map((entry) => entry.name)
  const container = readZipText(bytes, 'META-INF/container.xml')
  let opfPath                    
  if (container) {
    const match = /<rootfile\b[^>]*full-path\s*=\s*"([^"]+)"/i.exec(container) ?? /<rootfile\b[^>]*full-path\s*=\s*'([^']+)'/i.exec(container)
    opfPath = match?.[1] ? decodeEntities(match[1]) : undefined
  }
  if (!opfPath) opfPath = names.find((name) => name.toLowerCase().endsWith('.opf'))
  if (!opfPath) fail('epub 里找不到 OPF 包文件（META-INF/container.xml 缺失或损坏）')

  const opf = readZipText(bytes, opfPath)
  if (!opf) fail(`epub 里读不到包文件 ${opfPath}`)
  const manifest = parseOpf(opf)
  const baseDirectory = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : ''

  const notes           = []
  let chapters = manifest.spine
    .map((idref) => (manifest.items.has(idref) ? { id: idref, href: manifest.items.get(idref)  } : undefined))
    .filter((item)                                       => item !== undefined)
  if (!chapters.length) {
    notes.push('spine 缺失或为空，已按文件名顺序拼接全部 XHTML')
    chapters = names
      .filter((name) => /\.x?html?$/i.test(name))
      .sort()
      .map((name, index) => ({ id: `fallback-${index}`, href: name.startsWith(baseDirectory) ? name.slice(baseDirectory.length + 1) : name }))
  }

  const chunks           = []
  let missing = 0
  for (const chapter of chapters) {
    const path = resolveZipPath(baseDirectory, chapter.href)
    const html = readZipText(bytes, path)
    if (html === undefined) {
      missing += 1
      continue
    }
    const markdown = htmlToMarkdown(html)
    if (markdown) chunks.push(markdown)
  }
  if (missing) notes.push(`${missing} 个章节文件在压缩包里找不到`)
  const markdown = tidyMarkdown(chunks.join('\n\n'))
  if (!markdown) notes.push('所有章节都没有可提取的正文')

  return {
    markdown,
    title: manifest.title,
    author: manifest.author,
    partial: notes.length > 0,
    reason: notes.length ? `epub 文本层：${notes.join('；')}` : undefined,
  }
}

/* ------------------------------------------------------------------ *
 * 解析器
 * ------------------------------------------------------------------ */

function containerCapability(id        , format              )                   {
  return { id, tier: 'builtin', formats: [format], handlesScanned: false, available: true }
}

/** docx 解析器（builtin 层）。 */
export function docxParser()               {
  return {
    capability: containerCapability('docx-zip', 'docx'),
    parse: async (input) => docxToMarkdown(input.bytes),
  }
}

/** odt 解析器（builtin 层）。 */
export function odtParser()               {
  return {
    capability: containerCapability('odt-zip', 'odt'),
    parse: async (input) => odtToMarkdown(input.bytes),
  }
}

/** epub 解析器（builtin 层）。 */
export function epubParser()               {
  return {
    capability: containerCapability('epub-zip', 'epub'),
    parse: async (input) => epubToMarkdown(input.bytes),
  }
}
