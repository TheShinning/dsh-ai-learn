/**
 * PDF 分层解析。
 *
 * ## 分层理由
 * 原系统的 PDF 导入是「Go 库 → pdftotext → pdftoppm + tesseract」三级回退，失败时只把
 * 截断的错误写进 `parseStatus: "failed"`，用户分不清「工具没装」和「这是扫描件」。
 * 这里把两层显式建模：
 * - `builtin`：`pdf-text-layer`，纯 JS 抠文本层，零依赖，装没装 poppler 都能跑；
 * - `external`：`pdftotext`（文本层，快）与 `pdftoppm-tesseract`（扫描件 OCR，慢）。
 *
 * ## 内置提取器到底能做什么（诚实边界）
 * 它按「内容流扫描」而非完整 PDF 解析工作：不做 xref 解析、不做对象图遍历、不做字体
 * ToUnicode CMap 映射、不解析压缩对象流（`ObjStm`）。因此：
 * - 能覆盖绝大多数「内容流未加密、文本用 Tj/TJ 绘制」的 PDF；
 * - CID 字体用自定义编码时，取出的可能是字形码而非真实文本（会如实标注 partial）；
 * - 加密 PDF、`ObjStm` 打包的内容流取不到 → 返回空文本 + 说明原因，交给外部层。
 *
 * ## 子进程 stdio
 * 外部命令一律用**文件描述符**重定向 stdout/stderr，不走管道：受限沙箱下 Node 的
 * `stdio: 'pipe'` 可能因无法创建命名管道而 EPERM，重定向到临时文件则始终可用，
 * 同时也能把「完整命令」原样记进 `attempt.reason`。
 */

import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { constants as zlibConstants, inflateRawSync, inflateSync } from 'node:zlib'

                                                                                    
import { decodeText, tidyMarkdown } from './text.js'

/* ------------------------------------------------------------------ *
 * 外部命令探测与执行
 * ------------------------------------------------------------------ */

const probeCache = new Map                 ()

/**
 * 探测外部命令是否存在。`spawnSync` 抛错/返回 error 才算「不可用」，
 * 命令存在但参数不被接受（退出码非 0）仍算「可用」。
 */
export function commandAvailable(command        , args                    = ['-v'])          {
  const key = `${command}\u0000${args.join('\u0000')}`
  const cached = probeCache.get(key)
  if (cached !== undefined) return cached
  let available = false
  try {
    const result = spawnSync(command, [...args], { stdio: 'ignore', windowsHide: true, timeout: 10_000 })
    available = !result.error
  } catch {
    available = false
  }
  probeCache.set(key, available)
  return available
}

/** 清空探测缓存（测试用）。 */
export function resetCommandProbeCache()       {
  probeCache.clear()
}

function messageOf(error         )         {
  return error instanceof Error ? error.message : String(error)
}

function quoteArg(arg        )         {
  return /[\s"']/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg
}

function safeReadText(file        )         {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 外部命令执行结果；`command` 是可原样展示/记录的命令行。 */
                           
                      
                                
                         
                         
                          
                              
 

/**
 * 执行外部命令：stdout/stderr 落临时文件（不用管道），返回完整命令行。
 * 任何失败都转成「结果对象」而不是异常，调用方据此写 `reason`。
 */
export function runExternalCommand(command        , args                   , timeoutMs = 180_000)              {
  const display = [command, ...args].map(quoteArg).join(' ')
  let workDir        
  try {
    workDir = mkdtempSync(join(tmpdir(), 'dsh-ingest-run-'))
  } catch (error) {
    return { ok: false, status: null, stdout: '', stderr: '', command: display, spawnError: `无法创建临时目录：${messageOf(error)}` }
  }
  const outFile = join(workDir, 'stdout.txt')
  const errFile = join(workDir, 'stderr.txt')
  let result              = { ok: false, status: null, stdout: '', stderr: '', command: display, spawnError: '未执行' }
  try {
    const outFd = openSync(outFile, 'w')
    const errFd = openSync(errFile, 'w')
    try {
      const spawned = spawnSync(command, [...args], { stdio: ['ignore', outFd, errFd], windowsHide: true, timeout: timeoutMs })
      const stdout = safeReadText(outFile)
      const stderr = safeReadText(errFile)
      result = spawned.error
        ? { ok: false, status: null, stdout, stderr, command: display, spawnError: spawned.error.message }
        : { ok: spawned.status === 0, status: spawned.status, stdout, stderr, command: display }
    } finally {
      try {
        closeSync(outFd)
      } catch {
        /* ignore */
      }
      try {
        closeSync(errFd)
      } catch {
        /* ignore */
      }
    }
  } catch (error) {
    result = { ok: false, status: null, stdout: '', stderr: '', command: display, spawnError: messageOf(error) }
  }
  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  return result
}

/** 临时目录句柄。 */
                                                               

/** 建一个临时工作目录；失败时抛错（调用方转成 reason）。 */
export function createWorkDir(prefix        )          {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    dispose: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    },
  }
}

/** 落盘后的输入文件；`temporary` 为 true 时 `dispose` 会清掉临时目录。 */
                                                                                                       

/**
 * 外部命令需要真实路径，而 `SourceParser.parse` 只拿到 bytes。
 * 已经是磁盘文件就直接用，否则写进临时目录。
 */
export function materializeInput(input                                         )                    {
  if (isAbsolute(input.fileName) && existsSync(input.fileName)) {
    return { file: input.fileName, temporary: false, dispose: () => undefined }
  }
  const safeName = basename(input.fileName).replace(/[^\w.-]+/g, '_') || 'input.bin'
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ingest-in-'))
  const file = join(dir, safeName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, input.bytes)
  return {
    file,
    temporary: true,
    dispose: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    },
  }
}

/* ------------------------------------------------------------------ *
 * 内置：内容流扫描 + FlateDecode + BT/ET 文本算子
 * ------------------------------------------------------------------ */

/** 内置提取结果。`text` 为空时 `reason` 一定说明原因（扫描件/结构不支持等）。 */
                                  
                       
                        
                          
                           
                             
                          
 

                                                                       

/** 收集 `stream ... endstream` 段。按规范 `stream` 后必须紧跟 EOL，借此排除二进制里的假信号。 */
function collectStreams(raw        )                    {
  const streams                    = []
  let cursor = 0
  while (cursor < raw.length) {
    const index = raw.indexOf('stream', cursor)
    if (index < 0) break
    const after = raw.slice(index + 6, index + 8)
    let dataStart        
    if (after.startsWith('\r\n')) dataStart = index + 8
    else if (after.startsWith('\n') || after.startsWith('\r')) dataStart = index + 7
    else {
      cursor = index + 6
      continue
    }
    const end = raw.indexOf('endstream', dataStart)
    if (end < 0) break
    let dataEnd = end
    if (raw[dataEnd - 1] === '\n') dataEnd -= 1
    if (raw[dataEnd - 1] === '\r') dataEnd -= 1
    if (dataEnd > dataStart) {
      streams.push({ dict: raw.slice(Math.max(0, index - 1200), index), data: raw.slice(dataStart, dataEnd) })
    }
    cursor = end + 'endstream'.length
  }
  return streams
}

function inflateMaybe(buffer        )                     {
  try {
    return inflateSync(buffer, { finishFlush: zlibConstants.Z_SYNC_FLUSH })
  } catch {
    /* try raw deflate below */
  }
  try {
    return inflateRawSync(buffer, { finishFlush: zlibConstants.Z_SYNC_FLUSH })
  } catch {
    return undefined
  }
}

               
                                                           
                                                       
                                                     
                                                     
                                   
                                    
                                  
                                   

function isPdfWhitespace(char        )          {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f' || char === '\0'
}

function isPdfDelimiter(char        )          {
  return isPdfWhitespace(char) || '()<>[]{}/%'.includes(char)
}

function readLiteralString(source        , start        )                                      {
  const out           = []
  let depth = 1
  let i = start + 1
  while (i < source.length) {
    const char = source[i] 
    if (char === '\\') {
      const next = source[i + 1]
      i += 2
      switch (next) {
        case 'n':
          out.push(0x0a)
          break
        case 'r':
          out.push(0x0d)
          break
        case 't':
          out.push(0x09)
          break
        case 'b':
          out.push(0x08)
          break
        case 'f':
          out.push(0x0c)
          break
        case '(':
        case ')':
        case '\\':
          out.push(next.charCodeAt(0) & 0xff)
          break
        case '\n':
          break
        case '\r':
          if (source[i] === '\n') i += 1
          break
        default: {
          if (next !== undefined && /[0-7]/.test(next)) {
            let octal = next
            while (octal.length < 3 && i < source.length && /[0-7]/.test(source[i] )) {
              octal += source[i] 
              i += 1
            }
            out.push(Number.parseInt(octal, 8) & 0xff)
          } else if (next !== undefined) {
            out.push(next.charCodeAt(0) & 0xff)
          }
        }
      }
      continue
    }
    if (char === '(') {
      depth += 1
      out.push(0x28)
      i += 1
      continue
    }
    if (char === ')') {
      depth -= 1
      if (depth === 0) return { bytes: new Uint8Array(out), next: i + 1 }
      out.push(0x29)
      i += 1
      continue
    }
    out.push(char.charCodeAt(0) & 0xff)
    i += 1
  }
  return { bytes: new Uint8Array(out), next: source.length }
}

function readHexString(source        , start        )                                      {
  const out           = []
  let digits = ''
  let i = start + 1
  while (i < source.length && source[i] !== '>') {
    const char = source[i] 
    if (/[0-9a-fA-F]/.test(char)) {
      digits += char
      if (digits.length === 2) {
        out.push(Number.parseInt(digits, 16))
        digits = ''
      }
    }
    i += 1
  }
  if (digits.length === 1) out.push(Number.parseInt(`${digits}0`, 16))
  return { bytes: new Uint8Array(out), next: i + 1 }
}

function tokenizePdf(source        )             {
  const tokens             = []
  let i = 0
  while (i < source.length) {
    const char = source[i] 
    if (isPdfWhitespace(char)) {
      i += 1
      continue
    }
    if (char === '%') {
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i += 1
      continue
    }
    if (char === '(') {
      const read = readLiteralString(source, i)
      tokens.push({ kind: 'string', bytes: read.bytes })
      i = read.next
      continue
    }
    if (char === '<') {
      if (source[i + 1] === '<') {
        tokens.push({ kind: 'dict-open' })
        i += 2
        continue
      }
      const read = readHexString(source, i)
      tokens.push({ kind: 'string', bytes: read.bytes })
      i = read.next
      continue
    }
    if (char === '>') {
      if (source[i + 1] === '>') {
        tokens.push({ kind: 'dict-close' })
        i += 2
      } else {
        i += 1
      }
      continue
    }
    if (char === '[') {
      tokens.push({ kind: 'array-open' })
      i += 1
      continue
    }
    if (char === ']') {
      tokens.push({ kind: 'array-close' })
      i += 1
      continue
    }
    if (char === '/' ) {
      let end = i + 1
      while (end < source.length && !isPdfDelimiter(source[end] )) end += 1
      tokens.push({ kind: 'name', value: source.slice(i + 1, end) })
      i = end
      continue
    }
    if (char === '{' || char === '}') {
      i += 1
      continue
    }
    if (/[0-9+\-.]/.test(char)) {
      let end = i
      while (end < source.length && /[0-9eE+\-.]/.test(source[end] )) end += 1
      const value = Number.parseFloat(source.slice(i, end))
      tokens.push({ kind: 'number', value: Number.isFinite(value) ? value : 0 })
      i = end
      continue
    }
    let end = i
    while (end < source.length && !isPdfDelimiter(source[end] )) end += 1
    if (end === i) {
      i += 1
      continue
    }
    tokens.push({ kind: 'word', value: source.slice(i, end) })
    i = end
  }
  return tokens
}

function decodeStringToken(token                      )         {
  if (!token || token.kind !== 'string') return ''
  return decodeText(token.bytes).text
}

function lastString(operands                     )                       {
  for (let i = operands.length - 1; i >= 0; i -= 1) {
    const token = operands[i] 
    if (token.kind === 'string') return token
  }
  return undefined
}

function lastArrayElements(operands                     )             {
  let close = -1
  for (let i = operands.length - 1; i >= 0; i -= 1) {
    if (operands[i] .kind === 'array-close') {
      close = i
      break
    }
  }
  if (close < 0) return []
  let open = -1
  for (let i = close - 1; i >= 0; i -= 1) {
    if (operands[i] .kind === 'array-open') {
      open = i
      break
    }
  }
  return operands.slice(open + 1, close)
}

function numericOperands(operands                     )           {
  return operands.filter((token)                                             => token.kind === 'number').map((token) => token.value)
}

/**
 * 从一个内容流里抠出文本。
 *
 * 连接启发式：
 * - `Tj` / `'` / `"` 直接落文本（`'`/`"` 先换行）；
 * - `TJ` 数组里字符串依次拼接，数字 ≤ −100 视为词间距补一个空格；
 * - `Td` / `TD`：y 位移非 0 → 换行；纯 x 位移小 → 补空格，位移大 → 换行；
 * - `T*` 换行；`Tm` 的 y 与上一次不同 → 换行。
 */
export function extractTextFromContentStream(content        )         {
  // 内联图像 BI ... ID ... EI 里的二进制会污染词法分析，先整段丢掉
  const cleaned = content.replace(/\bBI\b[\s\S]*?\bEI\b/g, ' ')
  const tokens = tokenizePdf(cleaned)
  const parts           = []
  let operands             = []
  let lastMatrixY                    

  const emit = (text        )       => {
    if (text) parts.push(text)
  }
  const emitSpace = ()       => {
    const tail = parts.length ? parts[parts.length - 1]  : ''
    if (tail && !/[\s]$/.test(tail)) emit(' ')
  }
  const emitNewline = ()       => {
    emit('\n')
  }

  for (const token of tokens) {
    if (token.kind !== 'word') {
      operands.push(token)
      if (operands.length > 128) operands.shift()
      continue
    }
    switch (token.value) {
      case 'Tj': {
        emit(decodeStringToken(lastString(operands)))
        break
      }
      case "'":
      case '"': {
        emitNewline()
        emit(decodeStringToken(lastString(operands)))
        break
      }
      case 'TJ': {
        for (const element of lastArrayElements(operands)) {
          if (element.kind === 'string') emit(decodeStringToken(element))
          else if (element.kind === 'number' && element.value <= -100) emitSpace()
        }
        break
      }
      case 'Td':
      case 'TD': {
        const values = numericOperands(operands)
        const ty = values.length >= 2 ? values[values.length - 1]  : Number.NaN
        const tx = values.length >= 2 ? values[values.length - 2]  : Number.NaN
        if (Number.isFinite(ty) && Math.abs(ty) < 0.01) {
          if (Number.isFinite(tx) && Math.abs(tx) < 0.01) break
          if (Number.isFinite(tx) && Math.abs(tx) < 20) emitSpace()
          else emitNewline()
          break
        }
        emitNewline()
        break
      }
      case 'Tm': {
        const values = numericOperands(operands)
        if (values.length >= 6) {
          const y = values[values.length - 1] 
          if (lastMatrixY !== undefined && Math.abs(y - lastMatrixY) > 1) emitNewline()
          lastMatrixY = y
        }
        break
      }
      case 'T*': {
        emitNewline()
        break
      }
      case 'ET': {
        emitNewline()
        break
      }
      default:
        break
    }
    operands = []
  }

  return parts
    .join('')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function countPages(raw        )         {
  return raw.match(/\/Type\s*\/Page(?![sA-Za-z])/g)?.length ?? 0
}

function countImages(raw        )         {
  const subtype = raw.match(/\/Subtype\s*\/Image\b/g)?.length ?? 0
  const filters = raw.match(/\/Filter\s*\/(?:DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)\b/g)?.length ?? 0
  return Math.max(subtype, filters)
}

/**
 * 内置文本层提取（零依赖）。
 * 取不到文本时不抛错，而是返回空 `text` + 解释性 `reason`。
 */
export function extractPdfTextLayer(bytes            )                     {
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1')
  const pages = countPages(raw)
  const imageCount = countImages(raw)
  const streams = collectStreams(raw)
  let inflated = 0
  const chunks           = []

  for (const stream of streams) {
    const data = Buffer.from(stream.data, 'latin1')
    const isFlate = /\/FlateDecode\b/.test(stream.dict) || /\/Filter\s*\/Fl\b/.test(stream.dict)
    let content                    
    if (isFlate) {
      const result = inflateMaybe(data)
      if (result) {
        inflated += 1
        content = result.toString('latin1')
      }
    } else if (!/\/Filter\b/.test(stream.dict)) {
      content = stream.data
    }
    if (!content || !content.includes('BT')) continue
    const text = extractTextFromContentStream(content)
    if (text) chunks.push(text)
  }

  const text = chunks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()

  if (!text) {
    const reason = imageCount > 0
      ? `未提取到文本层：该 PDF 看起来是扫描件/图片型 PDF（检测到 ${imageCount} 张内嵌图像，页面只有图片没有文字），需要 OCR（pdftoppm + tesseract）`
      : streams.length === 0
        ? '未提取到文本层：找不到内容流（stream），文件可能已加密、损坏或使用了压缩对象流（ObjStm）'
        : '未提取到文本层：内容流里没有文本绘制指令（BT/Tj），可能是纯图形页面或扫描件'
    return { text: '', pages, streams: streams.length, inflated, imageCount, reason }
  }

  return {
    text: tidyMarkdown(text),
    pages,
    streams: streams.length,
    inflated,
    imageCount,
    reason: imageCount > 0 ? `已取到文本层，但页面内还有 ${imageCount} 张内嵌图像未做 OCR` : undefined,
  }
}

/* ------------------------------------------------------------------ *
 * 解析器
 * ------------------------------------------------------------------ */

/** 内置 PDF 文本层解析器（builtin 层）。不能处理扫描件，如实声明 `handlesScanned: false`。 */
export function pdfBuiltinParser()               {
  const capability                   = {
    id: 'pdf-text-layer',
    tier: 'builtin',
    formats: ['pdf'],
    handlesScanned: false,
    available: true,
  }
  return {
    capability,
    parse: async (input) => {
      const result = extractPdfTextLayer(input.bytes)
      if (!result.text) return { markdown: '', reason: result.reason ?? '未提取到文本层' }
      return { markdown: result.text, partial: result.imageCount > 0, reason: result.reason }
    },
  }
}

/** 外部 PDF 解析器选项：`command` / `commandArgs` 可替换，便于自定义安装路径与离线测试。 */
                                  
                           
                                          
                             
 

/**
 * `pdftotext -layout -enc UTF-8 <file> -`（external 层，文本型 PDF）。
 * `reason` 里记录完整命令行，失败时记录退出码与 stderr 摘要。
 */
export function pdfPopplerParser(options                     = {})               {
  const command = options.command ?? 'pdftotext'
  const commandArgs = options.commandArgs ?? []
  const available = commandAvailable(command, [...commandArgs, '-v'])
  const capability                   = {
    id: 'pdftotext',
    tier: 'external',
    formats: ['pdf'],
    handlesScanned: false,
    available,
    requires: [command],
  }
  return {
    capability,
    parse: async (input) => {
      if (!commandAvailable(command, [...commandArgs, '-v'])) {
        return { markdown: '', reason: `依赖不可用：未找到外部命令 ${command}（需要 poppler 的 pdftotext）` }
      }
      const source = materializeInput(input)
      try {
        const run = runExternalCommand(command, [...commandArgs, '-layout', '-enc', 'UTF-8', source.file, '-'], options.timeoutMs)
        if (run.spawnError) return { markdown: '', reason: `外部命令 ${run.command} 无法启动：${run.spawnError}` }
        if (!run.ok) {
          return { markdown: '', reason: `外部命令 ${run.command} 执行失败（退出码 ${run.status ?? 'null'}）${run.stderr.trim().slice(0, 200)}` }
        }
        const text = tidyMarkdown(run.stdout)
        if (!text) return { markdown: '', reason: `外部命令 ${run.command} 未取到文本：该 PDF 没有文本层（扫描件需 OCR）` }
        return { markdown: text, reason: `外部命令：${run.command}` }
      } finally {
        source.dispose()
      }
    },
  }
}

/** OCR 解析器选项。`*Args` 用于在命令前插入固定参数（自定义安装路径 / 离线替身命令）。 */
                             
                           
                                          
                                 
                                         
                             
                                     
                       
                            
                             
 

function naturalPageOrder(name        )         {
  const match = /(\d+)(?=\.[a-z]+$)/i.exec(name)
  return match ? Number.parseInt(match[1] , 10) : 0
}

/**
 * 扫描件 OCR：`pdftoppm -r <dpi> -png <file> <prefix>` 逐页转图，
 * 再用 `tesseract <png> <out> -l chi_sim+eng --psm 6` 识别；中文语言包缺失时退回 `-l eng`。
 * `reason` 里记录实际执行的两条命令。
 */
export function pdfOcrParser(options                = {})               {
  const command = options.command ?? 'tesseract'
  const commandArgs = options.commandArgs ?? []
  const rasterCommand = options.rasterCommand ?? 'pdftoppm'
  const rasterArgs = options.rasterArgs ?? []
  const languages = options.languages ?? 'chi_sim+eng'
  const fallbackLanguages = options.fallbackLanguages ?? 'eng'
  const dpi = options.dpi ?? 200
  const maxPages = options.maxPages ?? 40
  const probe = (spec        , args                   )          => commandAvailable(spec, [...args, '-v'])
  const available = probe(command, commandArgs) && probe(rasterCommand, rasterArgs)
  const capability                   = {
    id: 'pdftoppm-tesseract',
    tier: 'external',
    formats: ['pdf'],
    handlesScanned: true,
    available,
    requires: [rasterCommand, command],
  }
  return {
    capability,
    parse: async (input) => {
      const missing = [rasterCommand, command].filter((item) => !probe(item, item === command ? commandArgs : rasterArgs))
      if (missing.length) {
        return { markdown: '', reason: `依赖不可用：未找到外部命令 ${missing.join(', ')}（扫描件 OCR 需要 poppler 的 pdftoppm 与 tesseract，中文还需 chi_sim 语言包）` }
      }
      const source = materializeInput(input)
      let work                     
      try {
        work = createWorkDir('dsh-ingest-ocr-')
        const prefix = join(work.dir, 'page')
        const raster = runExternalCommand(rasterCommand, [...rasterArgs, '-r', String(dpi), '-png', source.file, prefix], options.timeoutMs)
        if (raster.spawnError) return { markdown: '', reason: `外部命令 ${raster.command} 无法启动：${raster.spawnError}` }
        if (!raster.ok) {
          return { markdown: '', reason: `外部命令 ${raster.command} 执行失败（退出码 ${raster.status ?? 'null'}）${raster.stderr.trim().slice(0, 200)}` }
        }
        const pages = readdirSync(work.dir)
          .filter((name) => /^page.*\.png$/i.test(name))
          .sort((a, b) => naturalPageOrder(a) - naturalPageOrder(b))
        if (!pages.length) {
          return { markdown: '', reason: `外部命令 ${raster.command} 没有生成任何页面图像（可能是加密或损坏的 PDF）` }
        }

        const usedCommands           = [raster.command]
        const chunks           = []
        let language = languages
        for (const [index, page] of pages.slice(0, maxPages).entries()) {
          const imagePath = join(work.dir, page)
          const outBase = join(work.dir, `ocr-${index + 1}`)
          let run = runExternalCommand(command, [...commandArgs, imagePath, outBase, '-l', language, '--psm', '6'], options.timeoutMs)
          if (!run.ok && language !== fallbackLanguages) {
            language = fallbackLanguages
            run = runExternalCommand(command, [...commandArgs, imagePath, outBase, '-l', language, '--psm', '6'], options.timeoutMs)
          }
          usedCommands.push(run.command)
          if (!run.ok) continue
          const text = safeReadText(`${outBase}.txt`).trim()
          if (text) chunks.push(text)
        }

        const markdown = tidyMarkdown(chunks.join('\n\n'))
        const pageNote = pages.length > maxPages ? `（仅 OCR 前 ${maxPages} 页，共 ${pages.length} 页）` : ''
        if (!markdown) {
          return { markdown: '', reason: `OCR 未取到文本${pageNote}。已执行：${usedCommands[usedCommands.length - 1]}` }
        }
        return {
          markdown,
          partial: true,
          reason: `外部命令（OCR，语言包 ${language}）：${usedCommands[0]}；${usedCommands[usedCommands.length - 1]}${pageNote}`,
        }
      } finally {
        work?.dispose()
        source.dispose()
      }
    },
  }
}
