/**
 * 文本类格式解析：Markdown / 纯文本 / HTML。
 *
 * 设计要点（均为「诚实降级」服务）：
 * - 解码永远返回**编码判定**与**是否有损**：GBK/UTF-16 这类非 UTF-8 文件不会被静默
 *   当成 UTF-8 读出满屏乱码，而是换成可用编码并把「非 UTF-8」写进 `reason`，最终进入
 *   `IngestAttempt.reason` 让用户看到。
 * - HTML 去标签不引入任何依赖：先处理块级/列表/标题，再走一遍「带引号的标签」剥离，
 *   最后解码实体（顺序很关键：先剥标签再解实体，否则 `&lt;b&gt;` 会被当成真标签）。
 * - 空文件不返回「成功的空字符串」：宁可让 `runIngestPipeline` 继续降级。
 */

                                                                                                              

/** 解码结果：正文 + 编码判定 + 是否有损（有损时 `note` 说明原因）。 */
                           
                       
                           
                         
                        
 

/** 把 CRLF / CR 统一成 LF，并去掉前导 BOM 字符。 */
export function normalizeNewlines(input        )         {
  return input.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
}

function tryDecode(label        , bytes            , fatal         )                     {
  try {
    return new TextDecoder(label, { fatal }).decode(bytes)
  } catch {
    return undefined
  }
}

/** 全角/宽字符计数：GBK 判定用（汉字、中日韩标点、全角形式）。 */
function wideCharCount(text        )         {
  let count = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if ((code >= 0x3000 && code <= 0x303f) || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xff00 && code <= 0xffef) || (code >= 0x3040 && code <= 0x30ff)) {
      count += 1
    }
  }
  return count
}

/**
 * GBK/GB18030 候选判定：能解出足够多的宽字符才认。
 * 反例：windows-1252 的英文文本混几个重音字母，GBK 解码也能「成功」但会解出垃圾汉字，
 * 这里用「宽字符 × 2 ≈ 非 ASCII 字节数」把它筛掉。
 */
function looksLikeGbk(bytes            , decoded        )          {
  let nonAscii = 0
  for (const byte of bytes) if (byte >= 0x80) nonAscii += 1
  if (nonAscii < 2) return false
  return wideCharCount(decoded) * 2 >= nonAscii * 0.8
}

function guessBomlessUtf16(bytes            )                                      {
  const sample = bytes.subarray(0, Math.min(bytes.length, 1024))
  if (sample.length < 4) return undefined
  let evenZeros = 0
  let oddZeros = 0
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) {
      if (i % 2 === 0) evenZeros += 1
      else oddZeros += 1
    }
  }
  const half = Math.floor(sample.length / 2)
  if (oddZeros > half * 0.6) return 'utf-16le'
  if (evenZeros > half * 0.6) return 'utf-16be'
  return undefined
}

function latin1(bytes            )         {
  let out = ''
  const chunk = 8192
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return out
}

/**
 * 字节 → 文本。UTF-8 优先，BOM 优先于内容探测，其次 UTF-16 / GB18030 / windows-1252。
 * 任何情况下都返回结果（不抛异常），有损时置 `lossy` 并给出 `note`。
 */
export function decodeBytes(bytes            )              {
  if (bytes.length === 0) return { text: '', encoding: 'utf-8', lossy: false }

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: normalizeNewlines(tryDecode('utf-8', bytes.subarray(3), false) ?? ''), encoding: 'utf-8-bom', lossy: false }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    const text = tryDecode('utf-16le', bytes.subarray(2), true)
    if (text !== undefined) {
      return { text: normalizeNewlines(text), encoding: 'utf-16le', lossy: false, note: '文件为 UTF-16LE 编码（非 UTF-8），已自动换码' }
    }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const text = tryDecode('utf-16be', bytes.subarray(2), true)
    if (text !== undefined) {
      return { text: normalizeNewlines(text), encoding: 'utf-16be', lossy: false, note: '文件为 UTF-16BE 编码（非 UTF-8），已自动换码' }
    }
  }

  const utf8 = tryDecode('utf-8', bytes, true)
  if (utf8 !== undefined) return { text: normalizeNewlines(utf8), encoding: 'utf-8', lossy: false }

  const guess = guessBomlessUtf16(bytes)
  if (guess !== undefined) {
    const text = tryDecode(guess, bytes, true)
    if (text !== undefined && wideCharCount(text) + (text.match(/[\u0000-\u001f]/g)?.length ?? 0) < text.length * 0.2) {
      return { text: normalizeNewlines(text), encoding: guess, lossy: true, note: `文件不是 UTF-8 编码，已按 ${guess.toUpperCase()} 解码` }
    }
  }

  const gb = tryDecode('gb18030', bytes, true)
  if (gb !== undefined && looksLikeGbk(bytes, gb)) {
    return { text: normalizeNewlines(gb), encoding: 'gb18030', lossy: true, note: '文件不是 UTF-8 编码，已按 GB18030/GBK 解码（中文材料常见的 ANSI 编码）' }
  }

  const cp = tryDecode('windows-1252', bytes, false) ?? latin1(bytes)
  return {
    text: normalizeNewlines(cp),
    encoding: 'windows-1252',
    lossy: true,
    note: '文件不是 UTF-8 编码，已按 windows-1252 近似解码：中文可能显示为乱码，建议另存为 UTF-8 后重试',
  }
}

/** 文件级解码：与 `decodeBytes` 相同，语义上是「文件正文」入口。 */
export function decodeText(bytes            )              {
  return decodeBytes(bytes)
}

/* ------------------------------------------------------------------ *
 * Markdown 规整
 * ------------------------------------------------------------------ */

/** 去掉行尾空白、折叠 3 个以上换行、去掉首尾空白。**不**折叠行内空格（会破坏缩进代码块）。 */
export function tidyMarkdown(input        )         {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** HTML 里的空白无语义：折叠行内空格，但保护 ``` 围栏内的代码。 */
function collapseHtmlWhitespace(input        )         {
  const lines = input.replace(/\r\n?/g, '\n').split('\n')
  let inFence = false
  const output = lines.map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      return line.trim()
    }
    if (inFence) return line.replace(/[ \t]+$/, '')
    return line.replace(/[\u00a0\t ]+/g, ' ').trim()
  })
  return output.join('\n')
}

/* ------------------------------------------------------------------ *
 * HTML → Markdown
 * ------------------------------------------------------------------ */

const NAMED_ENTITIES                         = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  minus: '−',
  times: '×',
  divide: '÷',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  deg: '°',
  plusmn: '±',
  ne: '≠',
  le: '≤',
  ge: '≥',
  infin: '∞',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  pi: 'π',
  sigma: 'σ',
  omega: 'ω',
  lambda: 'λ',
  mu: 'μ',
  sup2: '²',
  sup3: '³',
  frac12: '½',
  frac14: '¼',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  dagger: '†',
  permil: '‰',
  prime: '′',
  Prime: '″',
  arrow: '→',
  rarr: '→',
  larr: '←',
  harr: '↔',
  rArr: '⇒',
  hArr: '⇔',
  forall: '∀',
  exist: '∃',
  isin: '∈',
  sum: '∑',
  prod: '∏',
  radic: '√',
  int: '∫',
  part: '∂',
  nabla: '∇',
  asymp: '≈',
  equiv: '≡',
  prop: '∝',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  zwj: '',
  zwnj: '',
}

/** 解码 HTML/XML 实体（命名实体 + `&#NNN;` + `&#xHH;`）。 */
export function decodeEntities(input        )         {
  return input.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{0,31});/g, (match, body        ) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()]
    return named ?? match
  })
}

/** 已在回调里解过实体的片段，重新转义 `&`，避免最后一遍全局解码重复处理。 */
function deferEntityDecode(input        )         {
  return input.replace(/&/g, '&amp;')
}

function attributeValue(attributes        , name        )                     {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attributes)
  if (!match) return undefined
  return match[1] ?? match[2] ?? match[3]
}

const DROPPED_CONTENT_TAGS = ['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'math', 'select', 'option', 'button', 'textarea', 'form']

const BLOCK_TAGS = [
  'address', 'article', 'aside', 'body', 'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'header', 'hgroup', 'html', 'legend', 'main', 'nav', 'section', 'summary', 'tbody',
  'tfoot', 'thead',
]

function stripRemainingTags(input        )         {
  // 带引号的属性里可能出现 '>'，所以属性部分要能吃下引号片段
  return input.replace(/<\/?[a-zA-Z][a-zA-Z0-9:_.-]*(?:\s+(?:"[^"]*"|'[^']*'|[^>"'])*)?\s*\/?>/g, '')
}

/** 抽取 `<title>`；没有则退回第一个 `<h1>`。 */
export function extractHtmlTitle(html        )                     {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (title?.[1]) {
    const text = decodeEntities(stripRemainingTags(title[1])).replace(/\s+/g, ' ').trim()
    if (text) return text
  }
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)
  if (h1?.[1]) {
    const text = decodeEntities(stripRemainingTags(h1[1])).replace(/\s+/g, ' ').trim()
    if (text) return text
  }
  return undefined
}

/**
 * HTML → Markdown（零依赖近似转换）。
 *
 * 已知取舍（无依赖解析器的必然代价，故意写在明面上）：
 * - 源码里的硬换行会保留成换行，不合并成空格；
 * - 引用块只加 `> ` 前缀，块内多行不会逐行加前缀；
 * - 嵌套列表会丢层级缩进；表格只做 `| a | b |` 的线性化。
 */
export function htmlToMarkdown(html        )         {
  let source = html
  source = source.replace(/<!DOCTYPE[^>]*>/gi, '')
  source = source.replace(/<\?[\s\S]*?\?>/g, '')
  source = source.replace(/<!--[\s\S]*?-->/g, '')
  source = source.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  // `<head>` 里的元数据整段丢弃，但其中的 <title> 要留成分章标题（epub 章节常用）
  source = source.replace(/<head[^>]*>[\s\S]*?<\/head\s*>/gi, (head        ) => {
    const titles           = []
    for (const match of head.matchAll(/<title[^>]*>([\s\S]*?)<\/title\s*>/gi)) {
      const text = decodeEntities(stripRemainingTags(match[1] ?? '')).replace(/\s+/g, ' ').trim()
      if (text) titles.push(text)
    }
    return titles.length ? `\n\n${titles.map((title) => `# ${title}`).join('\n\n')}\n\n` : '\n\n'
  })
  // head 之外残留的 <title>（HTML 片段）同样当标题
  source = source.replace(/<title[^>]*>([\s\S]*?)<\/title\s*>/gi, (_match, inner        ) => {
    const text = decodeEntities(stripRemainingTags(inner)).replace(/\s+/g, ' ').trim()
    return text ? `\n\n# ${text}\n\n` : ' '
  })
  for (const tag of DROPPED_CONTENT_TAGS) {
    source = source.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ')
    source = source.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), ' ')
  }

  // 预格式化块：内部先剥标签再解实体，避免被后续行内规则二次加工
  source = source.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_match, inner        ) => {
    const code = decodeEntities(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')).replace(/^\n+|\n+$/g, '')
    return `\n\n\`\`\`\n${deferEntityDecode(code)}\n\`\`\`\n\n`
  })

  for (let level = 1; level <= 6; level += 1) {
    const hashes = '#'.repeat(level)
    source = source.replace(new RegExp(`<h${level}\\b[^>]*>`, 'gi'), `\n\n${hashes} `)
    source = source.replace(new RegExp(`</h${level}\\s*>`, 'gi'), '\n\n')
  }

  // 有序列表先编号，再统一处理 <li>（无序列表）
  source = source.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol\s*>/gi, (_match, inner        ) => {
    let index = 0
    return `\n${inner.replace(/<li\b[^>]*>/gi, () => {
      index += 1
      return `\n${index}. `
    })}\n`
  })
  source = source.replace(/<li\b[^>]*>/gi, '\n- ')
  source = source.replace(/<\/li\s*>/gi, '')
  source = source.replace(/<\/?(?:ul|ol)\b[^>]*>/gi, '\n')

  source = source.replace(/<p\b[^>]*>/gi, '\n\n')
  source = source.replace(/<\/p\s*>/gi, '\n\n')
  source = source.replace(/<br\s*\/?>/gi, '\n')
  source = source.replace(/<hr\s*\/?>/gi, '\n\n---\n\n')

  source = source.replace(/<tr\b[^>]*>/gi, '\n| ')
  source = source.replace(/<\/t[dh]\s*>/gi, ' | ')

  source = source.replace(/<(strong|b)\b[^>]*>/gi, '**')
  source = source.replace(/<\/(strong|b)\s*>/gi, '**')
  source = source.replace(/<(em|i)\b[^>]*>/gi, '*')
  source = source.replace(/<\/(em|i)\s*>/gi, '*')
  source = source.replace(/<(code|kbd|samp|tt)\b[^>]*>/gi, '`')
  source = source.replace(/<\/(code|kbd|samp|tt)\s*>/gi, '`')

  source = source.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_match, attributes        , inner        ) => {
    const text = decodeEntities(stripRemainingTags(inner)).replace(/\s+/g, ' ').trim()
    const href = attributeValue(attributes, 'href')
    if (!href) return deferEntityDecode(text)
    const url = decodeEntities(href).trim()
    if (!text || text === url) return deferEntityDecode(url)
    return `[${deferEntityDecode(text)}](${deferEntityDecode(url)})`
  })
  source = source.replace(/<img\b([^>]*)\/?>/gi, (_match, attributes        ) => {
    const alt = decodeEntities(attributeValue(attributes, 'alt') ?? '').trim()
    const src = decodeEntities(attributeValue(attributes, 'src') ?? '').trim()
    if (!src) return alt ? deferEntityDecode(alt) : ''
    return `![${deferEntityDecode(alt)}](${deferEntityDecode(src)})`
  })

  source = source.replace(/<blockquote\b[^>]*>/gi, '\n\n> ')
  source = source.replace(/<\/blockquote\s*>/gi, '\n\n')
  source = source.replace(new RegExp(`</?(?:${BLOCK_TAGS.join('|')})\\b[^>]*>`, 'gi'), '\n\n')

  source = stripRemainingTags(source)
  source = decodeEntities(source)
  return tidyMarkdown(collapseHtmlWhitespace(source))
}

/* ------------------------------------------------------------------ *
 * 解析器
 * ------------------------------------------------------------------ */

function capabilityOf(id        , tier            , formats                , handlesScanned = false)                   {
  return { id, tier, formats, handlesScanned, available: true }
}

/** 解析 YAML front matter 里的 title/author（只认最简单的 `key: value`）。 */
export function parseFrontMatter(markdown        )                                                    {
  if (!markdown.startsWith('---\n')) return { body: markdown }
  const end = markdown.indexOf('\n---', 3)
  if (end < 0) return { body: markdown }
  const head = markdown.slice(4, end)
  const body = markdown.slice(end + 4).replace(/^\n+/, '')
  const read = (key        )                     => {
    const match = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'im').exec(head)
    const value = match?.[1]?.trim().replace(/^["']|["']$/g, '')
    return value ? value : undefined
  }
  return { title: read('title'), author: read('author'), body }
}

/** 取第一个 Markdown 标题（`# ...`）作为标题。 */
export function firstHeading(markdown        )                     {
  for (const line of markdown.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (match?.[1]) return match[1]
    if (line.trim()) return undefined
  }
  return undefined
}

function firstLine(markdown        , maxLength = 120)                     {
  for (const line of markdown.split('\n')) {
    const text = line.replace(/^#+\s*/, '').trim()
    if (text) return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
  }
  return undefined
}

/** 通过率检查：控制字符过多说明是二进制，不该当成「纯文本」硬读。 */
function looksBinary(text        )          {
  if (!text) return false
  const control = text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g)?.length ?? 0
  return control / text.length > 0.02
}

const EMPTY_REASON = '文件只包含空白字符，没有可导入的正文'

/** Markdown 直通解析（native 层）：能读就不改内容，只做换行规整。 */
export function markdownParser()               {
  return {
    capability: capabilityOf('markdown-passthrough', 'native', ['markdown']),
    parse: async (input) => {
      const decoded = decodeText(input.bytes)
      const raw = tidyMarkdown(decoded.text)
      if (!raw) {
        return { markdown: '', reason: input.bytes.length === 0 ? '文件为空（0 字节）' : EMPTY_REASON }
      }
      // front matter 是元数据不是正文：title/author 提到结果字段里，正文里不再保留
      const front = parseFrontMatter(raw)
      const markdown = tidyMarkdown(front.body)
      if (!markdown) return { markdown: '', reason: '文件只有 front matter 元数据，没有可导入的正文' }
      return {
        markdown,
        title: front.title ?? firstHeading(markdown) ?? firstLine(markdown),
        author: front.author,
        reason: decoded.note,
      }
    },
  }
}

/** 纯文本直通解析（native 层）。 */
export function plainTextParser()               {
  return {
    capability: capabilityOf('text-passthrough', 'native', ['text']),
    parse: async (input) => {
      const decoded = decodeText(input.bytes)
      const markdown = tidyMarkdown(decoded.text)
      if (!markdown) {
        return { markdown: '', reason: input.bytes.length === 0 ? '文件为空（0 字节）' : EMPTY_REASON }
      }
      if (looksBinary(markdown)) {
        return { markdown: '', reason: '文件扩展名是纯文本，但内容像二进制（控制字符过多），已拒绝按文本读取' }
      }
      const head = firstLine(markdown, 100)
      return { markdown, title: head, reason: decoded.note }
    },
  }
}

/** HTML 去标签解析（builtin 层）。 */
export function htmlParser()               {
  return {
    capability: capabilityOf('html-strip', 'builtin', ['html']),
    parse: async (input) => {
      const decoded = decodeText(input.bytes)
      const markdown = htmlToMarkdown(decoded.text)
      if (!markdown) {
        return { markdown: '', reason: input.bytes.length === 0 ? '文件为空（0 字节）' : 'HTML 里没有可提取的正文（可能只有脚本或样式）' }
      }
      return { markdown, title: extractHtmlTitle(decoded.text) ?? firstHeading(markdown) ?? firstLine(markdown), reason: decoded.note }
    },
  }
}

/**
 * 未知格式兜底（builtin 层）：只有在看起来确实是文本时才认，否则如实失败。
 * 目的是让「无扩展名的 .md / .txt」能用，同时不把二进制文件读成乱码文本。
 */
export function textFallbackParser()               {
  return {
    capability: capabilityOf('text-fallback', 'builtin', ['unknown']),
    parse: async (input) => {
      const decoded = decodeText(input.bytes)
      const markdown = tidyMarkdown(decoded.text)
      if (!markdown) return { markdown: '', reason: EMPTY_REASON }
      if (looksBinary(markdown)) {
        return { markdown: '', reason: '无法识别的格式：内容看起来是二进制（需要专用解析器，例如 docx/epub 的容器解析）' }
      }
      return { markdown, title: firstLine(markdown, 100), reason: `按纯文本兜底读取（编码判定：${decoded.encoding}）${decoded.note ? `；${decoded.note}` : ''}` }
    },
  }
}
