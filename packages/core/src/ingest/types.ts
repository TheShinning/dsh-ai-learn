/**
 * 多格式摄取契约。
 *
 * ## 分层解析策略
 *
 * 用户选择的策略是「原生能力优先 → 内置 JS 解析 → 外部命令回退」。本文件只定义
 * 契约与降级轨迹，不绑定任何具体解析器实现（实现在 `packages/ingest`）。
 *
 * 之所以把「用了哪一层」显式建模成 `IngestTrace`，是因为原系统在这件事上踩过坑：
 * `desktop/learning_textbook_importers.go:172-184` 的 PDF 三级回退
 * （Go 库 → `pdftotext` → `pdftoppm` + `tesseract`）失败时只把错误截断 220 字写进
 * `parseStatus: "failed"`（`:442-451`），调用方无法区分
 * 「解析器不可用」和「文档本身是扫描件且 OCR 未装」。
 * 结果用户看到的是"教材导入失败"，而不是"缺 tesseract，请安装或改用文本版"。
 *
 * 这里要求每次摄取都返回**完整轨迹**：尝试过哪些层、哪一层成功、降级原因是什么。
 */

/** 支持的输入格式。 */
export type SourceFormat =
  | 'markdown'
  | 'text'
  | 'html'
  | 'pdf'
  | 'docx'
  | 'odt'
  | 'epub'
  | 'image'
  | 'unknown'

/** 解析层：越靠前越优先。 */
export type IngestTier = 'native' | 'builtin' | 'external'

export const INGEST_TIER_LABEL: Record<IngestTier, string> = {
  native: '运行时原生',
  builtin: '内置解析',
  external: '外部命令',
}

/** 单次解析尝试的结果。 */
export type IngestAttempt = {
  readonly tier: IngestTier
  /** 解析器标识，例如 `markdown-passthrough` / `pdf-text-layer` / `pdftotext`。 */
  readonly parser: string
  readonly ok: boolean
  /** 失败或降级原因（成功且有降级时也要填，例如"仅取到文本层，无图片 OCR"）。 */
  readonly reason?: string
  readonly durationMs?: number
}

/** 摄取输出：结构化正文 + 可复现的轨迹。 */
export type IngestResult = {
  readonly ok: boolean
  readonly format: SourceFormat
  /** 归一化后的 Markdown 正文（章节切分由 core 的结构解析负责）。 */
  readonly markdown: string
  readonly title?: string
  readonly author?: string
  /** 得到的内容是否为"部分内容"（例如扫描件未 OCR 只拿到标题）。 */
  readonly partial: boolean
  readonly attempts: readonly IngestAttempt[]
  /** 给用户看的下一步建议（例如"安装 tesseract 以支持扫描件"）。 */
  readonly advice?: string
}

/** 图像摄取：不返回文本，而是交给模型原生视觉。 */
export type ImageIngestResult = {
  readonly ok: boolean
  readonly format: 'image'
  /** 传给模型的可引用路径或 data URL。 */
  readonly reference: string
  readonly mimeType: string
  readonly bytes: number
  readonly width?: number
  readonly height?: number
  readonly attempts: readonly IngestAttempt[]
  readonly advice?: string
}

/** 解析器能力声明，用于编排与 UI 提示。 */
export type ParserCapability = {
  readonly id: string
  readonly tier: IngestTier
  readonly formats: readonly SourceFormat[]
  /** 是否支持扫描件这类"无文本层"的输入。 */
  readonly handlesScanned: boolean
  /** 依赖是否就绪（外部命令探测结果 / 可选依赖是否安装）。 */
  readonly available: boolean
  readonly requires?: readonly string[]
}

/** 单个解析器。实现方只需实现 `parse`，编排与降级由 `runIngestPipeline` 负责。 */
export type SourceParser = {
  readonly capability: ParserCapability
  parse(input: { bytes: Uint8Array; fileName: string; format: SourceFormat }): Promise<{
    markdown: string
    title?: string
    author?: string
    partial?: boolean
    reason?: string
  }>
}

/** 推断格式：优先用扩展名，再用魔数（magic bytes）。 */
export function detectFormat(fileName: string, head?: Uint8Array): SourceFormat {
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  switch (ext) {
    case 'md':
    case 'markdown':
    case 'mdx':
      return 'markdown'
    case 'txt':
    case 'text':
    case 'log':
      return 'text'
    case 'html':
    case 'htm':
    case 'xhtml':
      return 'html'
    case 'pdf':
      return 'pdf'
    case 'docx':
      return 'docx'
    case 'odt':
      return 'odt'
    case 'epub':
      return 'epub'
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'webp':
    case 'gif':
    case 'bmp':
    case 'tif':
    case 'tiff':
      return 'image'
    default:
      break
  }
  if (head && head.length >= 4) {
    const magic = String.fromCharCode(head[0]!, head[1]!, head[2]!, head[3]!)
    if (magic.startsWith('%PDF')) return 'pdf'
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image'
    if (head[0] === 0xff && head[1] === 0xd8) return 'image'
    if (magic.startsWith('PK')) {
      // zip 容器：docx / odt / epub 都走这里，细化交给调用方看扩展名
      return 'unknown'
    }
  }
  return 'unknown'
}

/**
 * 按 tier 顺序编排解析，返回首个成功结果；全部失败时返回带完整轨迹的失败结果。
 *
 * 契约要点：
 * - **不做静默降级**：每次尝试都记入 `attempts`，失败也要留下 `reason`；
 * - **部分成功也算成功**：`partial: true` 时调用方应提示用户内容不完整；
 * - **不给空成功**：`markdown` 去空白后为空一律视为该层失败，继续降级。
 */
export async function runIngestPipeline(input: {
  bytes: Uint8Array
  fileName: string
  format: SourceFormat
  parsers: readonly SourceParser[]
}): Promise<IngestResult> {
  const attempts: IngestAttempt[] = []
  const tierOrder: IngestTier[] = ['native', 'builtin', 'external']
  const candidates = [...input.parsers].sort(
    (a, b) => tierOrder.indexOf(a.capability.tier) - tierOrder.indexOf(b.capability.tier),
  )

  for (const parser of candidates) {
    if (!parser.capability.formats.includes(input.format)) continue
    if (!parser.capability.available) {
      attempts.push({
        tier: parser.capability.tier,
        parser: parser.capability.id,
        ok: false,
        reason: `依赖不可用${parser.capability.requires?.length ? `：${parser.capability.requires.join(', ')}` : ''}`,
      })
      continue
    }
    const startedAt = Date.now()
    try {
      const parsed = await parser.parse(input)
      const markdown = parsed.markdown.trim()
      if (!markdown) {
        attempts.push({
          tier: parser.capability.tier,
          parser: parser.capability.id,
          ok: false,
          reason: parsed.reason ?? '未取到任何文本内容',
          durationMs: Date.now() - startedAt,
        })
        continue
      }
      attempts.push({
        tier: parser.capability.tier,
        parser: parser.capability.id,
        ok: true,
        reason: parsed.reason,
        durationMs: Date.now() - startedAt,
      })
      return {
        ok: true,
        format: input.format,
        markdown,
        title: parsed.title,
        author: parsed.author,
        partial: parsed.partial ?? false,
        attempts,
        advice: parsed.partial ? '内容可能不完整，建议核对原文档或提供文本版' : undefined,
      }
    } catch (error) {
      attempts.push({
        tier: parser.capability.tier,
        parser: parser.capability.id,
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      })
    }
  }

  return {
    ok: false,
    format: input.format,
    markdown: '',
    partial: false,
    attempts,
    advice: adviceFor(input.format, attempts),
  }
}

function adviceFor(format: SourceFormat, attempts: readonly IngestAttempt[]): string {
  const unavailable = attempts.filter((item) => item.reason?.startsWith('依赖不可用')).map((item) => item.parser)
  if (format === 'pdf') {
    return unavailable.length
      ? `PDF 解析全部失败（不可用：${unavailable.join(', ')}）。安装 poppler 的 pdftotext 可解析文本型 PDF；扫描件另需 tesseract 与中文语言包。`
      : 'PDF 解析全部失败。若为扫描件，请安装 tesseract（含 chi_sim）后重试，或先转换为文本。'
  }
  if (format === 'docx' || format === 'odt' || format === 'epub') {
    return `${format.toUpperCase()} 解析失败。可先另存为 Markdown/txt 再导入。`
  }
  return '未能解析该文件，请检查文件是否损坏或改用受支持的格式。'
}
