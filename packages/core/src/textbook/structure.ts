/**
 * 教材结构切分：Markdown 正文 → 章 / 节 / 页 / 段。
 *
 * ## 对齐原系统
 *
 * 语义取自 `desktop/learning_textbooks.go:494-629` 的 `splitTextbookMarkdown`
 * 与 `buildLearningTextbookChapters`：
 * - 只在**非代码围栏**内按 `^(#{1,6})\s+(.+)$` 切分（围栏里的 `#` 是注释不是标题）；
 * - `#` / `##`（level ≤ 2）开新**章**；`###` 及以上开新**节**；
 * - 空行 flush 一个段落；无正文的章 / 节被剔除；
 * - 页按约 1600 个字符切（原 `learningTextbookPageTargetChars = 1600`）；
 * - 段落的教材锚点形如 `P<全局页号>`。
 *
 * ## 与原文的差异（有意为之）
 *
 * 1. **节点 id 由稳定教材 key 派生**，而不是由"标题+正文"的哈希派生。
 *    原系统 `learningTextbookID(title, body)`（`:146-149`）让改一个字就换整本教材，
 *    连带节点 id 全变、证据与掌握度全部失联。这里 id 形如
 *    `book:xxx#ch001-sec002-p003`，只与**位置**有关。
 * 2. **空结构不再伪造兜底内容**：原文"全空则整篇落到兜底章/第 1 节"会让一份
 *    解析失败的教材看起来"导入成功"。这里返回空 `chapters`，由调用方如实报失败。
 *
 * ## 已知限制（如实记录）
 *
 * 位置派生的 id 在**中间插入或删除小节**时会使其后小节的 id 位移，
 * 那些节点上的证据会留在旧 id 上。原系统有同样的问题（且更严重，因为连改错别字都换 id）。
 * 若要彻底消除，需要给节点加"内容指纹"并在重建时做迁移映射 —— 属于后续增量，
 * 不在本次范围内。原地编辑（改字、改句）不受影响。
 */

import type { KnowledgeEdge, KnowledgeNode } from '../knowledge/graph.ts'

export type Paragraph = {
  readonly id: string
  readonly text: string
  /** 教材锚点，形如 `P12`。 */
  readonly anchor: string
}

export type Page = {
  readonly id: string
  /** 全篇全局页号，从 1 开始。 */
  readonly number: number
  readonly anchor: string
  readonly paragraphs: readonly Paragraph[]
}

export type Section = {
  readonly id: string
  readonly title: string
  readonly chapterId: string
  readonly pages: readonly Page[]
}

export type Chapter = {
  readonly id: string
  readonly title: string
  readonly sections: readonly Section[]
}

export type TextbookStructure = {
  readonly textbookKey: string
  readonly chapters: readonly Chapter[]
  readonly chapterCount: number
  readonly sectionCount: number
  readonly pageCount: number
  readonly paragraphCount: number
}

export const DEFAULT_PAGE_TARGET_CHARS = 1600

/** 兜底标题：正文出现在任何标题之前时使用。 */
const FALLBACK_CHAPTER_TITLE = '开篇'
/**
 * 章下直接写正文且**同时**还有 `###` 小节时，这些导语文字自成一节。
 * 若该章只有这一节（没有 `###`），小节名会被替换成章标题 —— 见 `flushChapter`。
 */
const FALLBACK_SECTION_TITLE = '本章导语'
const UNTITLED_CHAPTER = '未命名章节'
const UNTITLED_SECTION = '未命名小节'

type RawBlock =
  | { kind: 'heading'; level: number; title: string }
  | { kind: 'paragraph'; text: string }

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/
const FENCE_RE = /^\s*(?:```|~~~)/

/** 把正文切成"标题 / 段落"的原始序列（围栏内一律视为段落）。 */
function toRawBlocks(markdown: string): RawBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: RawBlock[] = []
  let inFence = false
  let buffer: string[] = []

  const flush = () => {
    const text = buffer.join('\n').trim()
    if (text) blocks.push({ kind: 'paragraph', text })
    buffer = []
  }

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      // 围栏整体归入正文，避免把代码里的 # 当标题
      inFence = !inFence
      buffer.push(line)
      continue
    }
    if (inFence) {
      buffer.push(line)
      continue
    }
    const heading = HEADING_RE.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'heading', level: heading[1]!.length, title: heading[2]!.trim() })
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    buffer.push(line)
  }
  flush()
  return blocks
}

/** 按字符数（码点计）把段落聚成页。单段超长时独占一页，不切断段落。 */
function paginate(
  sectionId: string,
  paragraphs: readonly string[],
  startPageNumber: number,
  pageTargetChars: number,
): { pages: Page[]; nextPageNumber: number } {
  const pages: Page[] = []
  let current: string[] = []
  let currentChars = 0
  let pageNumber = startPageNumber

  const pushPage = () => {
    if (current.length === 0) return
    const id = `${sectionId}-p${String(pages.length + 1).padStart(3, '0')}`
    pages.push({
      id,
      number: pageNumber,
      anchor: `P${pageNumber}`,
      paragraphs: current.map((text, index) => ({
        id: `${id}-para${String(index + 1).padStart(3, '0')}`,
        text,
        anchor: `P${pageNumber}`,
      })),
    })
    pageNumber += 1
    current = []
    currentChars = 0
  }

  for (const paragraph of paragraphs) {
    const size = [...paragraph].length
    if (current.length > 0 && currentChars + size > pageTargetChars) pushPage()
    current.push(paragraph)
    currentChars += size
  }
  pushPage()

  return { pages, nextPageNumber: pageNumber }
}

/**
 * 切分教材结构。
 *
 * @param input.markdown 归一化后的 Markdown（通常是 ingest 层的输出）。
 * @param input.textbookKey 稳定教材 key（见 `identity.ts`），节点 id 由它派生。
 * @param input.pageTargetChars 单页目标字符数，默认 1600。
 */
export function splitTextbookStructure(input: {
  textbookKey: string
  markdown: string
  pageTargetChars?: number
}): TextbookStructure {
  const pageTargetChars = input.pageTargetChars ?? DEFAULT_PAGE_TARGET_CHARS
  const blocks = toRawBlocks(input.markdown)

  type DraftSection = { title: string; paragraphs: string[]; implicit: boolean }
  type DraftChapter = { title: string; sections: DraftSection[] }

  const chapters: DraftChapter[] = []
  let chapter: DraftChapter | null = null
  let section: DraftSection | null = null

  const flushSection = () => {
    if (!chapter || !section) return
    if (section.paragraphs.length > 0) chapter.sections.push(section)
    section = null
  }
  const flushChapter = () => {
    flushSection()
    if (chapter && chapter.sections.length > 0) {
      // 章下直接写正文（没有 `###` 小节）时，用章标题当小节名 ——
      // 小节是路线推荐与复习的**单位**，叫"正文"对学习者没有信息量。
      if (chapter.sections.length === 1 && chapter.sections[0]!.implicit) {
        chapter.sections[0] = { ...chapter.sections[0]!, title: chapter.title }
      }
      chapters.push(chapter)
    }
    chapter = null
  }

  for (const block of blocks) {
    if (block.kind === 'heading') {
      if (block.level <= 2) {
        flushChapter()
        chapter = { title: block.title || UNTITLED_CHAPTER, sections: [] }
        continue
      }
      if (!chapter) chapter = { title: FALLBACK_CHAPTER_TITLE, sections: [] }
      flushSection()
      section = { title: block.title || UNTITLED_SECTION, paragraphs: [], implicit: false }
      continue
    }
    // 段落：没有章节时先起兜底章与兜底节
    if (!chapter) chapter = { title: FALLBACK_CHAPTER_TITLE, sections: [] }
    if (!section) section = { title: FALLBACK_SECTION_TITLE, paragraphs: [], implicit: true }
    section.paragraphs.push(block.text)
  }
  flushChapter()

  const built: Chapter[] = []
  let pageNumber = 1
  let sectionCount = 0
  let paragraphCount = 0

  chapters.forEach((draft, chapterIndex) => {
    const chapterId = `${input.textbookKey}#ch${String(chapterIndex + 1).padStart(3, '0')}`
    const sections: Section[] = []
    draft.sections.forEach((draftSection, sectionIndex) => {
      const sectionId = `${chapterId}-sec${String(sectionIndex + 1).padStart(3, '0')}`
      const { pages, nextPageNumber } = paginate(sectionId, draftSection.paragraphs, pageNumber, pageTargetChars)
      pageNumber = nextPageNumber
      sectionCount += 1
      paragraphCount += draftSection.paragraphs.length
      sections.push({ id: sectionId, title: draftSection.title, chapterId, pages })
    })
    built.push({ id: chapterId, title: draft.title, sections })
  })

  return {
    textbookKey: input.textbookKey,
    chapters: built,
    chapterCount: built.length,
    sectionCount,
    pageCount: pageNumber - 1,
    paragraphCount,
  }
}

/**
 * 由结构派生图谱节点与边。
 *
 * 节点层级：`textbook → chapter → section → page`（`contains` 边）。
 *
 * **自动先修规则**（对齐原系统 `learning_knowledge_graph.go:652-663`）：
 * 同一章内按出现顺序，前一个小节 → 当前小节生成 `prerequisite` 边，置信度 0.8；
 * **不跨章**（跨章的先修应由人/模型显式建立，机器猜不准阅读顺序）。
 */
export function buildStructureGraph(input: {
  textbookKey: string
  title: string
  structure: TextbookStructure
}): { nodes: KnowledgeNode[]; edges: KnowledgeEdge[] } {
  const { textbookKey, title, structure } = input
  const nodes: KnowledgeNode[] = []
  const edges: KnowledgeEdge[] = []

  const bookNodeId = `${textbookKey}#book`
  nodes.push({ id: bookNodeId, type: 'textbook', title, textbookKey })

  for (const chapter of structure.chapters) {
    nodes.push({
      id: chapter.id,
      type: 'chapter',
      title: chapter.title,
      textbookKey,
      chapterId: chapter.id,
    })
    edges.push({
      id: `${bookNodeId}->${chapter.id}`,
      from: bookNodeId,
      to: chapter.id,
      relation: 'contains',
      confidence: 1,
    })

    let previousSectionId: string | undefined
    for (const section of chapter.sections) {
      nodes.push({
        id: section.id,
        type: 'section',
        title: section.title,
        textbookKey,
        chapterId: chapter.id,
        sectionId: section.id,
      })
      edges.push({
        id: `${chapter.id}->${section.id}`,
        from: chapter.id,
        to: section.id,
        relation: 'contains',
        confidence: 1,
      })
      if (previousSectionId) {
        edges.push({
          id: `${previousSectionId}~>${section.id}`,
          from: previousSectionId,
          to: section.id,
          relation: 'prerequisite',
          confidence: 0.8,
        })
      }
      previousSectionId = section.id

      for (const page of section.pages) {
        nodes.push({
          id: page.id,
          type: 'page',
          title: `${section.title} · ${page.anchor}`,
          textbookKey,
          chapterId: chapter.id,
          sectionId: section.id,
          pageId: page.id,
          anchor: page.anchor,
        })
        edges.push({
          id: `${section.id}->${page.id}`,
          from: section.id,
          to: page.id,
          relation: 'contains',
          confidence: 1,
        })
      }
    }
  }

  return { nodes, edges }
}

/** 结构摘要，用于工具回执与 UI 提示。 */
export function describeStructure(structure: TextbookStructure): string {
  if (structure.chapterCount === 0) return '结构为空（正文里没有任何可识别的标题或段落）'
  return `${structure.chapterCount} 章 / ${structure.sectionCount} 节 / ${structure.pageCount} 页 / ${structure.paragraphCount} 段`
}
