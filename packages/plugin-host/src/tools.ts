/**
 * 面向前模型/用户的伴学工具集。
 *
 * 设计原则：**插件壳薄，逻辑在 core**。这里只做三件事：把参数转成 core 的输入、
 * 调用 core 的纯函数、把结果渲染成模型可读文本。所有判定（掌握度、路线、SRS、
 * 卡片可练习性）都在 `packages/core` 里，并且有 `node --test` 覆盖。
 *
 * 工具 schema 用 DSH 的作者 DSL（不是 schemastery/zod）：允许的 key 只有
 * `description/title/default/examples/type/properties/additionalProperties/items/enum/const/oneOf/required`；
 * object 节点**必须显式写 `additionalProperties`**，否则报 authorError。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { EvidenceIdAllocator, evidenceKey, type Evidence } from '../../core/src/knowledge/evidence.ts'
import {
  buildMasteryIndex,
  buildRouteStops,
  masteryStats,
  nodeBloomLevel,
  rebuildStructure,
  type KnowledgeEdge,
  type KnowledgeGraph,
  type KnowledgeNode,
} from '../../core/src/knowledge/graph.ts'
import { deriveMastery, masteryWithout, positiveKindCount } from '../../core/src/knowledge/mastery.ts'
import { buildStudyStats, renderStats } from '../../core/src/growth/stats.ts'
import {
  CARD_KIND_LABEL,
  impracticableReason,
  isPracticable,
  judge,
  type StudyCard,
} from '../../core/src/review/cards.ts'
import { SRS_RESULT_LABEL, isDue, scheduleReview, srsMasterySignal, type SrsResult } from '../../core/src/review/srs.ts'
import { deriveProbeState } from '../../core/src/pedagogy/probe.ts'
import { renderMove, nextSocraticMove, type SocraticMove, type QuizOutcome } from '../../core/src/pedagogy/step.ts'
import { answerToEvidence, quizIntent, quizDirective, QUIZ_INTENT_LABEL, type AnswerKind } from '../../core/src/pedagogy/quiz.ts'
import { renderFocus, selectFocusNode, type FocusDecision } from '../../core/src/pedagogy/focus.ts'
import {
  classifyMaterial,
  decodeSourceFormat,
  encodeSourceFormat,
  isMaterialType,
  renderClassification,
  shouldAskUser,
} from '../../core/src/pedagogy/material.ts'
import { materialDirective, strategyFor, teachingModeOf, TEACHING_MODE_LABEL } from '../../core/src/pedagogy/strategy.ts'
import { buildReviewPlan, renderReviewPlan, shouldInterrupt, INTERRUPT_MAX_AGAIN } from '../../core/src/review/plan.ts'
import { capabilities } from '../../ingest/src/index.ts'
import { INGEST_TIER_LABEL } from '../../core/src/ingest/types.ts'
import { applyImportPlan, planTextbookImport, textbookKey } from '../../core/src/textbook/identity.ts'
import {
  CLASSROOM_GAP_LABEL,
  buildClassroomRecord,
  classroomRecordPath,
  renderClassroomRecord,
  type ClassroomStep,
} from '../../core/src/records.classroom.ts'
import { buildStructureGraph, describeStructure, splitTextbookStructure } from '../../core/src/textbook/structure.ts'
import { BLOOM_LABEL, MASTERY_LABEL, MATERIAL_TYPE_LABEL, normalizeBloomLevel, type MaterialType, type ErrorType, type TeachingScenario, type Mastery } from '../../core/src/types.ts'
import { ingestFile } from '../../ingest/src/index.ts'
import { buildStudyContext, teachingStateSnapshot } from './prompt.ts'
import type { StudyCardRecord, StudyStore, SessionRecord } from './storage.ts'
import { newCardSrs } from './store.ts'

const text = (value: string) => [{ type: 'text' as const, text: value }]

/** 组装某本教材的完整图谱视图。 */
async function graphOf(store: StudyStore, textbookKey?: string): Promise<{ graph: KnowledgeGraph; key?: string }> {
  const key = textbookKey ?? (await store.activeTextbookKey())
  if (!key) return { graph: { nodes: [], edges: [], evidence: [] } }
  const [nodes, edges, evidence] = await Promise.all([
    store.nodesFor(key),
    store.edgesFor(key),
    store.evidenceFor(key),
  ])
  return { graph: { nodes, edges, evidence }, key }
}

/** 持久记录 → core 的判别联合卡片视图（用于可练习性判定与判分）。 */
function recordToCard(record: StudyCardRecord): StudyCard {
  const base = {
    id: record.id,
    textbookKey: record.textbookKey ?? undefined,
    nodeId: record.nodeId ?? undefined,
    anchor: record.anchor ?? undefined,
    createdAt: record.createdAt,
  }
  switch (record.kind) {
    case 'choice':
      return {
        ...base,
        kind: 'choice',
        prompt: record.prompt,
        options: record.options.map((option) => ({ key: option.key, text: option.text })),
        answerKey: record.answerKey ?? '',
        explanation: record.explanation ?? undefined,
      }
    case 'cloze':
      return { ...base, kind: 'cloze', prompt: record.prompt, answer: record.answer ?? '', explanation: record.explanation ?? undefined }
    case 'short-answer':
      return { ...base, kind: 'short-answer', prompt: record.prompt, answer: record.answer ?? '', explanation: record.explanation ?? undefined }
    default:
      return {
        ...base,
        kind: 'mnemonic',
        prompt: record.prompt,
        answer: record.answer ?? '',
        knowledgePoint: record.knowledgePoint ?? '',
        scope: record.scope ?? undefined,
      }
  }
}

/** 取正文里第一个 Markdown 标题作为书名。 */
function firstMarkdownHeading(markdown: string): string | undefined {
  for (const line of markdown.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (match) return match[1]
  }
  return undefined
}

/** 从路径取文件名（去扩展名），作为书名兜底。 */
function baseNameOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path
  return name.replace(/\.[^.]+$/, '')
}

/**
 * 材料类型 → 教学情景（`prompt.ts` 的"材料情景"行）。
 *
 * 这一条此前**从来没有生产者**（快照唯一写入点从不赋 `scenario`），
 * 于是那个渲染分支恒不执行。苏格拉底模式是它的第一位生产者。
 */
function scenarioOf(type: MaterialType | undefined): TeachingScenario {
  switch (type) {
    case 'regulation':
      return 'regulation'
    case 'exam':
      return 'review'
    case 'answer-analysis':
      return 'review'
    case 'textbook':
    case 'lecture-notes':
      return 'course-concept'
    default:
      return 'general'
  }
}

/** 最近一条带错误类型的证据（把 `errorType` 的渲染分支真正用起来）。 */
function latestErrorType(evidence: readonly Evidence[], nodeId?: string): ErrorType | undefined {
  let latest: Evidence | undefined
  for (const item of evidence) {
    if (!item.errorType) continue
    if (nodeId && item.nodeId !== nodeId) continue
    if (!latest || latest.createdAt < item.createdAt) latest = item
  }
  return latest?.errorType
}

/**
 * 失败建议接地：把"本机实测缺什么"补进解析失败的报告。
 *
 * 起因：`ingest` 的能力清单（`capabilities()`）此前**没有任何生产调用点**，
 * 于是模型只能给模板话术（"装 tesseract"），既可能多余（已装）也可能不够具体。
 */
async function localAdviceHint(format: string): Promise<string> {
  try {
    const list = await capabilities()
    const relevant = list.filter((item) => item.formats.includes(format as never))
    if (relevant.length === 0) return ''
    const usable = relevant.filter((item) => item.available).map((item) => item.id)
    const missing = relevant
      .filter((item) => !item.available)
      .map((item) => `${item.id}（需要 ${(item.requires ?? []).join(' + ') || '外部依赖'}）`)
    const lines = ['', '', '本机实测能力：']
    lines.push(`  - 可用：${usable.length > 0 ? usable.join('、') : '（该格式没有可用解析器）'}`)
    if (missing.length > 0) lines.push(`  - 不可用：${missing.join('、')}`)
    lines.push('  说明：图片型/扫描件在缺 OCR 依赖时会如实失败，不会返回空字符串冒充成功；也可直接把图片作为附件交给视觉模型。')
    return lines.join('\n')
  } catch {
    return ''
  }
}

/**
 * 创建伴学工具集。
 *
 * @param store 存储门面（内存或 domain）。
 * @param ctx 宿主上下文；**可选**。目前只用于把课堂记录写进工作区（`ctx.fs`）——
 *   没有 ctx 时记录仍然生成并落库，只是不写 Markdown（`saved: false`，报告里如实说明）。
 */
export function createStudyTools(store: StudyStore, ctx?: { fs?: unknown }) {
  /** 证据 id 分配器：每个工具集一份，保证同毫秒内写入的多条证据不会共用 id（见 evidence.ts 的说明）。 */
  const evidenceIds = new EvidenceIdAllocator()
  /** 本节环节留痕（课堂记录用）。只记**实际做过动作**的那些调用，避免被"查看计划"灌满。 */
  const stepTrail: ClassroomStep[] = []

  // —— 0. 导入教材（多格式摄取 → 结构切分 → 建节点与先修边）
  const importTextbook = defineTool({
    name: 'study_import_textbook',
    description:
      '导入一份材料作为当前教材：Markdown / txt / html / PDF / Word(docx) / odt / epub。' +
      '解析按「运行时原生 → 内置 JS 解析 → 外部命令」分层；失败时返回完整尝试轨迹与可操作的安装建议。' +
      '图片不能作为教材正文（图片应作为附件交给视觉模型）。' +
      '同一来源重复导入是「修订」而不是新建：教材身份不变，已有证据与复习排期保留。',
    parameters: {
      path: { type: 'string', description: '文件路径（相对工作区或绝对路径）。与 text 二选一。' },
      text: { type: 'string', description: '直接粘贴的正文（优先于 path）。' },
      title: { type: 'string', description: '教材标题；省略时取正文首个标题，再退到文件名。' },
      explicit_id: { type: 'string', description: '显式身份标识，用于把身份固定到某个稳定名字上。' },
      material_type: {
        type: 'string',
        enum: ['article', 'textbook', 'regulation', 'lecture-notes', 'exam', 'answer-analysis'],
        description:
          '材料类型。省略时按标题与正文特征自动判别并标注置信度；判别不确定时会要求先问用户。' +
          '用户说"这是条例/真题/文章"时请显式传入。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          key: { type: 'string', required: true },
          action: { type: 'string', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(value.report),
    },
    async execute(args: { path?: string; text?: string; title?: string; explicit_id?: string; material_type?: string }) {
      if (!args.text?.trim() && !args.path?.trim()) {
        throw new Error('请提供 path（文件路径）或 text（粘贴正文）')
      }

      let markdown: string
      let sourceFormat: string
      let sourceRef: string
      let ingestedTitle: string | undefined

      if (args.text?.trim()) {
        markdown = args.text
        sourceFormat = 'markdown'
        sourceRef = args.explicit_id ?? 'pasted-text'
      } else {
        const path = args.path!.trim()
        const result = await ingestFile(path)
        if ('reference' in result) {
          return {
            ok: false,
            key: '',
            action: 'rejected',
            report:
              `这是一张图片（${result.mimeType}，${result.bytes} 字节），不能作为教材正文。\n` +
              '两条真实出路：① 把它作为图片附件发给我，我用视觉能力读它（不进教材库）；' +
              '② 先 OCR 成文本再导入。',
          }
        }
        if (!result.ok) {
          const attempts = result.attempts
            .map((item) => `  - [${item.tier}] ${item.parser}：${item.reason ?? (item.ok ? '成功' : '失败')}`)
            .join('\n')
          // 建议接地：把"本机实测缺什么"一起报出来，而不是只给模板话术
          const advice = await localAdviceHint(result.format)
          return {
            ok: false,
            key: '',
            action: 'failed',
            report:
              `解析失败（格式判定为 ${result.format}）。尝试轨迹：\n${attempts}\n\n` +
              `建议：${result.advice ?? '请检查文件是否损坏或改用受支持的格式。'}${advice}`,
          }
        }
        markdown = result.markdown
        sourceFormat = result.format
        sourceRef = path
        ingestedTitle = result.title
      }

      const title =
        args.title?.trim() || ingestedTitle?.trim() || firstMarkdownHeading(markdown) || baseNameOf(sourceRef)
      const key = textbookKey({ title, sourceRef, explicitId: args.explicit_id })
      const existing = await store.getTextbook(key)
      const plan = planTextbookImport({
        title,
        body: markdown,
        sourceRef,
        explicitId: args.explicit_id,
        existing,
      })

      if (plan.action === 'unchanged') {
        return {
          ok: true,
          key,
          action: 'unchanged',
          report: `「${title}」正文未变化，复用既有结构（身份 ${key}）。`,
        }
      }

      const structure = splitTextbookStructure({ textbookKey: key, markdown })
      if (structure.chapterCount === 0) {
        return {
          ok: false,
          key,
          action: 'failed',
          report:
            `取到了正文（${markdown.length} 字符，来源格式 ${sourceFormat}），但里面没有任何可识别的标题或段落，` +
            '因此**没有**建立教材。请确认文件是否为空、或是否为纯图片型（扫描件）文档。',
        }
      }

      const { nodes, edges } = buildStructureGraph({ textbookKey: key, title, structure })
      // 材料分类：决定"这份东西该怎么教"。放进 sourceFormat 的复合值（`<format>|<type>|<confidence>`），
      // 因为材料类型是**教材属性**（换教材不该丢），而该字段已是 z.string()，旧值按 `|` 切分仍可读 → 零 migration。
      const material = classifyMaterial({
        title,
        sourceRef,
        sourceFormat,
        markdown,
        explicit: isMaterialType(args.material_type) ? args.material_type : undefined,
      })
      const record = applyImportPlan(plan, {
        title,
        sourceRef,
        sourceFormat: encodeSourceFormat(String(sourceFormat), material.type, material.confidence),
        existing,
      })
      await store.putTextbook(record)
      await store.replaceStructure(key, nodes, edges)
      await store.setActiveTextbook(key)

      const sectionNodes = nodes.filter((node) => node.type === 'section').length
      const prerequisites = edges.filter((edge) => edge.relation === 'prerequisite').length
      return {
        ok: true,
        key,
        action: plan.action,
        report: [
          `${plan.action === 'revise' ? '已修订' : '已导入'}教材「${title}」（身份 ${key}，来源格式 ${sourceFormat}）`,
          `结构：${describeStructure(structure)}`,
          `图谱：${nodes.length} 个节点（${sectionNodes} 个小节）、${edges.length} 条边（先修 ${prerequisites} 条，章内相邻小节自动生成）`,
          renderClassification(material),
          materialDirective(material.type),
          shouldAskUser(material)
            ? '⚠️ 材料类型不确定：开始教学前先问用户一句"这是教材、条例、题还是文章？"，答一句即可改判（`study_import_textbook` 传 material_type）。'
            : '',
          plan.action === 'revise'
            ? '这是修订：教材身份、既有证据与复习排期都保留；原地改字不会改变小节 id。'
            : '已设为当前教材。',
          '下一步：说「开始上课」，我会按路线推荐从第一个知识点讲起。',
        ]
          .filter((line) => line.length > 0)
          .join('\n'),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `导入教材：${args.title ?? args.path ?? '粘贴正文'}`,
      kind: 'other',
      rawInput: args.path ?? 'pasted-text',
    }),
  })

  // —— 1. 记录证据（掌握度的唯一入口）
  const recordEvidence = defineTool({
    name: 'study_record_evidence',
    description:
      '记录一条学习证据并返回该知识点重算后的掌握度。掌握度是完整证据集合的纯函数，' +
      '不接受"直接把节点设为已掌握"这种绕过证据的写法（人工确认请用 kind=mastery-confirm）。',
    parameters: {
      node_id: { type: 'string', required: true, description: '知识点节点 id。' },
      kind: {
        type: 'string',
        required: true,
        enum: ['answer-quality', 'question-asked', 'metacognition', 'note', 'blackboard', 'flashcard', 'srs-review', 'code-lab', 'quote', 'mastery-confirm'],
        description: '证据种类。正向判定规则见伴学协议。',
      },
      summary: { type: 'string', required: true, description: '一句话摘要（必填，参与幂等键）。' },
      source_id: { type: 'string', description: '业务去重标识。同一 (node,kind,sourceId,summary) 覆盖而非追加；同一张卡连错两次请改这里。' },
      detail: { type: 'string', description: '证据详情（不参与幂等键）。' },
      result: { type: 'string', description: '结果标记，例如 light / consolidate / clarify / run / ask。' },
      correct: { type: 'boolean', description: '三态：不传=未作答，true=答对，false=答错。' },
      mastery: {
        type: 'string',
        enum: ['unknown', 'partial', 'confused', 'mastered'],
        description: '显式掌握度，仅在人工确认等场合使用。',
      },
      bloom_level: {
        type: 'string',
        enum: ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'],
        description: '本条证据体现的布鲁姆层级。只接受这六个 ASCII 标识，中文标签在展示层查表。',
      },
      error_type: {
        type: 'string',
        enum: ['concept-misunderstanding', 'forgetting', 'transfer-failure', 'comprehension-deviation', 'no-answer'],
        description: '错误类型，用于选择追问策略。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          node_id: { type: 'string', required: true },
          mastery: { type: 'string', required: true },
          mastery_label: { type: 'string', required: true },
          positive_kinds: { type: 'integer', required: true },
          evidence_count: { type: 'integer', required: true },
        },
      },
      render: (_args, value) =>
        text(
          `知识点 ${value.node_id} 掌握度：${value.mastery_label}` +
            `（正向证据种类 ${value.positive_kinds}，证据共 ${value.evidence_count} 条）`,
        ),
    },
    async execute(args: {
      node_id: string
      kind: Evidence['kind']
      summary: string
      source_id?: string
      detail?: string
      result?: string
      correct?: boolean
      mastery?: Mastery
      bloom_level?: string
      error_type?: Evidence['errorType']
    }) {
      const { graph } = await graphOf(store)
      const now = new Date()
      const sourceId = args.source_id ?? `${args.kind}-${Date.now()}`
      const incoming: Evidence = {
        // 由幂等键的**内容**派生（原先用 key 的长度 + 毫秒时间戳，同毫秒内的不同证据会互相覆盖）
        id: evidenceIds.next(evidenceKey({ nodeId: args.node_id, kind: args.kind, sourceId, summary: args.summary }), now),
        nodeId: args.node_id,
        kind: args.kind,
        sourceId,
        summary: args.summary,
        detail: args.detail,
        result: args.result,
        correct: args.correct,
        mastery: args.mastery,
        bloomLevel: args.bloom_level ? normalizeBloomLevel(args.bloom_level) : undefined,
        errorType: args.error_type,
        createdAt: now.toISOString(),
      }
      const history = graph.evidence.filter((item) => item.nodeId === args.node_id)
      const mastery = deriveMastery(history, incoming)
      await store.putEvidence(incoming)
      const all = [...history, incoming]
      return {
        node_id: args.node_id,
        mastery,
        mastery_label: MASTERY_LABEL[mastery],
        positive_kinds: positiveKindCount(all),
        evidence_count: all.length,
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `记录证据：${args.kind}`, kind: 'other', rawInput: args.summary }),
  })

  // —— 2. 撤销一条证据（原系统只能撤销 mastery-confirm）
  const retractEvidence = defineTool({
    name: 'study_retract_evidence',
    description:
      '撤销一条证据并重算掌握度。与旧实现不同，这里**任何**证据都可撤销：' +
      '掌握度是证据集合的纯函数，不需要 previousMastery 快照。',
    parameters: {
      evidence_id: { type: 'string', required: true, description: '要撤销的证据 id。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          node_id: { type: 'string', required: true },
          mastery: { type: 'string', required: true },
          mastery_label: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(`已撤销。${value.node_id} 现在为：${value.mastery_label}`),
    },
    async execute(args: { evidence_id: string }) {
      const { graph } = await graphOf(store)
      const target = graph.evidence.find((item) => item.id === args.evidence_id)
      if (!target) throw new Error(`找不到证据 ${args.evidence_id}`)
      const mastery = masteryWithout(graph.evidence, args.evidence_id)
      await store.deleteEvidence(args.evidence_id)
      return { node_id: target.nodeId, mastery, mastery_label: MASTERY_LABEL[mastery] }
    },
  })

  // —— 3. 学习进度（路线推荐 + 带来源标注的统计）
  const progress = defineTool({
    name: 'study_progress',
    description:
      '返回当前教材的学习进度：下一处推荐（含先修门控说明）、候选路线、以及带**来源标注**的统计。' +
      '统计里每个数字都标明是"来自证据/由证据派生/启发式估计"，不要把启发式数字当学习结论。',
    parameters: {
      textbook_key: { type: 'string', description: '教材稳定 key；省略则用当前活动教材。' },
      limit: { type: 'integer', description: '候选路线条数，默认 6。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          textbook_key: { type: 'string', required: true },
          next: { type: 'string', required: true },
          reason: { type: 'string', required: true },
          probe_depth: { type: 'integer', required: true },
          report: { type: 'string', required: true },
          // —— 以下为苏格拉底模式追加（**只增字段，不改既有五个**，保证伴学模式输出不变）
          step: { type: 'string', required: true },
          next_action: { type: 'string', required: true },
          focus_reason: { type: 'string', required: true },
          material_type: { type: 'string', required: true },
          teaching_mode: { type: 'string', required: true },
          due_cards: { type: 'integer', required: true },
          review_days: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => text(value.report),
    },
    async execute(args: { textbook_key?: string; limit?: number }) {
      const { graph, key } = await graphOf(store, args.textbook_key)
      const index = buildMasteryIndex(graph)
      const stops = buildRouteStops(graph, index, { limit: args.limit ?? 6 })
      const primary = stops[0]
      const cards = key ? await store.cardsFor(key) : await store.cardsFor()
      const now = new Date()
      const reviewPlan = buildReviewPlan(
        cards.map((card) => ({ id: card.id, nodeId: card.nodeId ?? undefined, srs: card.srs })),
        { now, evidence: graph.evidence },
      )
      const stats = buildStudyStats({
        graph,
        flashcards: cards.map((card) => ({ id: card.id, srs: card.srs })),
        // 复习口径以 srs-review 证据行为准（原先恒传 reviewHistory: [] 导致"复习天数/已复习卡"永远为 0）
        reviewEvidence: graph.evidence,
      })
      const probe = deriveProbeState(graph.evidence, primary?.node.id)
      const focus = selectFocusNode(graph, { reviewPlan })
      // 苏格拉底步骤：以证据为准判断"下一步该问、该降阶还是该直讲"
      const mastery = primary ? (index[primary.node.id] ?? 'unknown') : 'unknown'
      const move = nextSocraticMove({
        nodeId: focus.nodeId,
        mastery,
        probeState: probe,
        evidence: focus.nodeId ? graph.evidence.filter((item) => item.nodeId === focus.nodeId) : [],
        cards: reviewPlan.queue.filter((item) => item.nodeId === focus.nodeId),
      })
      const material = decodeSourceFormat(key ? (await store.getTextbook(key))?.sourceFormat : undefined)
      const strategy = strategyFor(material.materialType ?? 'textbook')
      // 最近一次课堂记录摘要：只读，不重算历史（记录是快照）
      const lastSession = key ? await store.latestSession(key) : undefined
      const lines = [
        `教材：${key ?? '（未指定）'}`,
        primary
          ? `下一处推荐：${primary.node.title}｜${MASTERY_LABEL[primary.mastery]}｜${primary.reason}`
          : '下一处推荐：（图谱中还没有可推进的学习单元）',
        renderFocus(focus),
        renderMove(move),
        `材料类型：${material.materialType ?? '未识别'}｜教学模式：${TEACHING_MODE_LABEL[strategy.mode]}`,
        renderReviewPlan(reviewPlan),
        lastSession
          ? `最近一次课堂：${lastSession.endedAt.slice(0, 10)}｜${lastSession.summary}` +
            (lastSession.gaps.length > 0 ? `｜待办 ${lastSession.gaps.length} 项：${lastSession.gaps[0]!.nextStep}` : '｜无待办缺口')
          : '最近一次课堂：（还没有课堂记录；收束时可用 study_wrap_up 生成）',
      ]
      if (stops.length > 1) {
        lines.push('候选路线：')
        for (const [position, stop] of stops.entries()) {
          lines.push(
            `  ${position + 1}. ${stop.node.title}｜${MASTERY_LABEL[stop.mastery]}｜${stop.reason}｜证据 ${stop.evidenceCount}`,
          )
        }
      }
      if (primary) {
        const bloom = nodeBloomLevel(graph, primary.node.id)
        if (bloom) lines.push(`当前节点最高层级：${BLOOM_LABEL[normalizeBloomLevel(bloom)]}`)
      }
      // 同步快照：系统提示的 context 节在装配期只能同步读，所以在这里落一份。
      // 这一处同时接通了两条**此前从来没有生产者**的渲染分支（scenario / errorType）。
      const contextInput = {
        knowledgePoint: focus.title ?? primary?.node.title,
        probeState: probe,
        hasConfusedNodes: masteryStats(graph, index).confused > 0,
        dueCards: stats.dueCards.value,
        step: move.step,
        nextAction: move.action,
        teachingMode: strategy.mode,
        sourceFormat: material.format,
        scenario: scenarioOf(material.materialType),
        errorType: latestErrorType(graph.evidence, focus.nodeId),
      }
      teachingStateSnapshot.current = contextInput

      lines.push('', '统计（每项带来源标注）：', renderStats(stats))
      lines.push('', buildStudyContext(contextInput))
      return {
        textbook_key: key ?? '',
        next: primary?.node.title ?? '',
        reason: primary?.reason ?? '',
        probe_depth: probe.probeDepth,
        report: lines.join('\n'),
        step: move.step,
        next_action: move.action,
        focus_reason: focus.reason,
        material_type: material.materialType ?? '',
        teaching_mode: strategy.mode,
        due_cards: reviewPlan.dueCards,
        review_days: stats.reviewDays.value,
      }
    },
  })

  // —— 4. 复习队列
  const reviewQueue = defineTool({
    name: 'study_review_queue',
    description:
      '列出到期复习卡。选择题可自动判分，填空/简答/口诀走自评 —— 四种卡**都可复习**' +
      '（旧实现要求必须有选项，导致口诀卡永远无法练习）。',
    parameters: {
      textbook_key: { type: 'string', description: '限定教材；省略表示全部。' },
      limit: { type: 'integer', description: '最多返回几张，默认 20。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          due: { type: 'integer', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(value.report),
    },
    async execute(args: { textbook_key?: string; limit?: number }) {
      const cards = await store.cardsFor(args.textbook_key)
      const now = new Date()
      const due = cards.filter((card) => isDue(card.srs, now)).slice(0, args.limit ?? 20)
      if (cards.length === 0) return { due: 0, report: '还没有任何卡片。讲完一个知识点后可以让我生成卡片。' }
      const lines = [`到期 ${due.length} 张 / 共 ${cards.length} 张：`]
      for (const card of due) {
        const reason = impracticableReason(recordToCard(card))
        lines.push(`- [${card.id}] ${CARD_KIND_LABEL[card.kind]}｜${card.prompt}${reason ? `（不可练习：${reason}）` : ''}`)
      }
      return { due: due.length, report: lines.join('\n') }
    },
  })

  // —— 5. 提交复习结果（唯一推进 SRS 的入口）
  const submitReview = defineTool({
    name: 'study_submit_review',
    description:
      '提交一次复习结果并推进 SRS 排期。选择题传 selected_key 自动判分；其他类型传 self_report。' +
      '复习失败会同时写入掌握度降级信号（旧实现把 srsResult 只存不读，降级依赖调用方另行传值）。',
    parameters: {
      card_id: { type: 'string', required: true, description: '卡片 id。' },
      selected_key: { type: 'string', description: '选择题所选选项 key。' },
      self_report: { type: 'string', enum: ['again', 'hard', 'good'], description: '非选择题的自评结果。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          result: { type: 'string', required: true },
          result_label: { type: 'string', required: true },
          next_review_at: { type: 'string', required: true },
          interval_days: { type: 'integer', required: true },
          mastery_signal: { type: 'string', required: true },
        },
      },
      render: (_args, value) =>
        text(
          `记录：${value.result_label}。下次复习 ${value.next_review_at.slice(0, 10)}（间隔 ${value.interval_days} 天）` +
            (value.mastery_signal ? `；掌握度信号：${value.mastery_signal}` : ''),
        ),
    },
    async execute(args: { card_id: string; selected_key?: string; self_report?: SrsResult }) {
      const cards = await store.cardsFor()
      const record = cards.find((card) => card.id === args.card_id)
      if (!record) throw new Error(`找不到卡片 ${args.card_id}`)
      const view = recordToCard(record)
      if (!isPracticable(view)) throw new Error(`这张卡不可练习：${impracticableReason(view)}`)

      const result = judge(view, { selectedKey: args.selected_key, selfReport: args.self_report })
      if (!result) {
        throw new Error(
          view.kind === 'choice'
            ? '这道题的正确答案无法对应到任何选项，已拒绝判分（请修正题面，而不是记成"勉强答对"）'
            : '请提供 self_report（again / hard / good）',
        )
      }

      const srs = scheduleReview(record.srs, result)
      await store.putCard({ ...record, srs })

      // 排期与降级信号同源写入：一次复习同时产出 SRS 状态与一条复习证据
      const signal = srsMasterySignal(result)
      if (record.nodeId) {
        const { graph } = await graphOf(store)
        const incoming: Evidence = {
          id: evidenceIds.next(evidenceKey({ nodeId: record.nodeId, kind: 'srs-review', sourceId: `${record.id}-srs-${srs.lastReviewedAt}`, summary: `复习「${record.prompt.slice(0, 40)}」：${SRS_RESULT_LABEL[result]}` }), new Date(srs.lastReviewedAt ?? Date.now())),
          nodeId: record.nodeId,
          kind: 'srs-review',
          sourceId: `${record.id}-srs-${srs.lastReviewedAt}`,
          summary: `复习「${record.prompt.slice(0, 40)}」：${SRS_RESULT_LABEL[result]}`,
          result,
          srsResult: result,
          correct: result !== 'again',
          mastery: signal,
          createdAt: srs.lastReviewedAt ?? new Date().toISOString(),
        }
        await store.putEvidence(incoming)
      }

      return {
        result,
        result_label: SRS_RESULT_LABEL[result],
        next_review_at: srs.nextReviewAt ?? '',
        interval_days: srs.intervalDays,
        mastery_signal: signal ?? '',
      }
    },
  })

  // —— 6. 建卡（含口诀卡，走同一可练习性判定）
  const createCard = defineTool({
    name: 'study_create_card',
    description:
      '为某个知识点建一张复习卡。四种类型都受支持，且都会被复习队列接纳。' +
      '口诀卡（mnemonic）天生没有选项，这是正常形态，不要伪造选项。',
    parameters: {
      kind: { type: 'string', required: true, enum: ['choice', 'cloze', 'short-answer', 'mnemonic'], description: '卡片类型。' },
      prompt: { type: 'string', required: true, description: '题面。' },
      answer: { type: 'string', description: '非选择题的答案。' },
      answer_key: { type: 'string', description: '选择题的正确选项 key。' },
      options: {
        type: 'array',
        description: '选择题选项。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            key: { type: 'string', required: true },
            text: { type: 'string', required: true },
          },
        },
      },
      node_id: { type: 'string', description: '绑定知识点，复习结果会写回该节点证据。' },
      knowledge_point: { type: 'string', description: '口诀卡服务的知识点。' },
      textbook_key: { type: 'string', description: '所属教材 key。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          card_id: { type: 'string', required: true },
          kind_label: { type: 'string', required: true },
          practicable: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) =>
        text(`已建卡 [${value.card_id}] ${value.kind_label}，可练习：${value.practicable ? '是' : '否'}`),
    },
    async execute(args: {
      kind: StudyCardRecord['kind']
      prompt: string
      answer?: string
      answer_key?: string
      options?: { key: string; text: string }[]
      node_id?: string
      knowledge_point?: string
      textbook_key?: string
    }) {
      const id = `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const textbookKey = args.textbook_key ?? (await store.activeTextbookKey())
      const isChoice = args.kind === 'choice'
      const record: StudyCardRecord = {
        id,
        kind: args.kind,
        textbookKey: textbookKey ?? null,
        nodeId: args.node_id ?? null,
        anchor: null,
        prompt: args.prompt,
        options: isChoice ? (args.options ?? []) : [],
        answerKey: isChoice ? (args.answer_key ?? '') : null,
        answer: isChoice ? null : (args.answer ?? ''),
        explanation: null,
        knowledgePoint: args.kind === 'mnemonic' ? (args.knowledge_point ?? '') : null,
        scope: null,
        srs: newCardSrs(),
        createdAt: new Date().toISOString(),
      }
      const practicable = isPracticable(recordToCard(record))
      await store.putCard(record)
      return { card_id: id, kind_label: CARD_KIND_LABEL[args.kind], practicable }
    },
  })

  // —— 7. 重建结构（保留学习状态）
  const rebuild = defineTool({
    name: 'study_rebuild_structure',
    description:
      '按当前教材结构重建节点与结构边。**证据、掌握度、手工语义边、宫殿摆位全部保留**' +
      '（旧实现从空图重建，这些都会丢失）。',
    parameters: {
      textbook_key: { type: 'string', description: '教材 key；省略用当前活动教材。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          textbook_key: { type: 'string', required: true },
          nodes: { type: 'integer', required: true },
          preserved_evidence: { type: 'integer', required: true },
          preserved_manual_edges: { type: 'integer', required: true },
        },
      },
      render: (_args, value) =>
        text(
          `已重建结构：${value.nodes} 个节点；保留证据 ${value.preserved_evidence} 条、` +
            `手工语义边 ${value.preserved_manual_edges} 条。`,
        ),
    },
    async execute(args: { textbook_key?: string }) {
      const key = args.textbook_key ?? (await store.activeTextbookKey())
      if (!key) throw new Error('没有活动教材，无法重建结构')
      const [nodes, edges, evidence] = await Promise.all([
        store.nodesFor(key),
        store.edgesFor(key),
        store.evidenceFor(key),
      ])
      const existing: KnowledgeGraph = { nodes, edges, evidence }
      const manualCount = edges.filter((edge) => edge.relation !== 'contains' && edge.relation !== 'prerequisite').length
      const structure: { nodes: KnowledgeNode[]; edges: KnowledgeEdge[] } = {
        nodes,
        edges: edges.filter((edge) => edge.relation === 'contains' || edge.relation === 'prerequisite'),
      }
      const next = rebuildStructure(structure, existing)
      await store.replaceStructure(key, next.nodes, next.edges)
      return {
        textbook_key: key,
        nodes: next.nodes.length,
        preserved_evidence: next.evidence.length,
        preserved_manual_edges: manualCount,
      }
    },
  })

  // —— 8. 苏格拉底步骤编排（苏格拉底模式的"一步一步"由系统状态驱动，而不是模型自觉）
  const steps = defineTool({
    name: 'study_steps',
    description:
      '返回"下一步该做什么"：当前环节（定向/追问/降阶/直讲与复述/测试/收束）、具体动作、' +
      '是否可以给答案、是否必须先复述、以及本次聚焦的知识点与理由。' +
      '**每一步都必须先问它，再决定怎么回复** —— 讲不讲答案由证据决定，不由模型自己觉得。' +
      '默认只读（record=false）；要把学生这次回答写成证据时传 record=true。',
    parameters: {
      textbook_key: { type: 'string', description: '教材稳定 key；省略则用当前活动教材。' },
      node_id: { type: 'string', description: '指定知识点；省略则由焦点选择决定（困惑 > 到期复习 > 先修缺口 > 未点亮）。' },
      last_answer: { type: 'string', description: '学生最近一次回答（用于归因与判分）。' },
      answer_kind: {
        type: 'string',
        enum: ['answer', 'retell', 'card'],
        description: '这次作答的性质：普通回答 / 复述 / 卡片作答。复述会单独记账，便于区分"答错"与"复述未通过"。',
      },
      correct: { type: 'boolean', description: '选择题等可自动判分时传入；不传表示未作答。' },
      self_report: { type: 'string', enum: ['again', 'hard', 'good'], description: '非选择题的自评结果。' },
      source_id: { type: 'string', description: '证据去重标识；同一张卡连错两次请改这里。省略时自动生成。' },
      record: { type: 'boolean', description: '是否写入证据（默认 false，只做编排不落盘）。' },
      textbook_finished: { type: 'boolean', description: '是否已走完本教材的可推进节点（用于收束环节判断）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          step: { type: 'string', required: true },
          action: { type: 'string', required: true },
          question_budget: { type: 'integer', required: true },
          may_reveal_answer: { type: 'boolean', required: true },
          must_retell: { type: 'boolean', required: true },
          focus_node_id: { type: 'string', required: true },
          focus_title: { type: 'string', required: true },
          focus_reason: { type: 'string', required: true },
          quiz_intent: { type: 'string', required: true },
          recorded_evidence_id: { type: 'string', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(value.report),
    },
    async execute(args: {
      textbook_key?: string
      node_id?: string
      last_answer?: string
      answer_kind?: AnswerKind
      correct?: boolean
      self_report?: SrsResult
      source_id?: string
      record?: boolean
      textbook_finished?: boolean
    }) {
      const { graph, key } = await graphOf(store, args.textbook_key)
      const index = buildMasteryIndex(graph)
      const cards = key ? await store.cardsFor(key) : await store.cardsFor()
      const now = new Date()
      const reviewPlan = buildReviewPlan(
        cards.map((card) => ({ id: card.id, nodeId: card.nodeId ?? undefined, srs: card.srs })),
        { now, evidence: graph.evidence },
      )
      // 材料类型 → 教法：**每轮追问都要看到它**，否则"按材料换教法"只停留在导入报告里
      const material = decodeSourceFormat(key ? (await store.getTextbook(key))?.sourceFormat : undefined)
      const strategy = strategyFor(material.materialType ?? 'textbook')

      // 焦点：显式 node_id 优先，否则走焦点选择（可解释的硬优先级）
      const focus: FocusDecision = args.node_id
        ? {
            reason: 'unlit',
            nodeId: args.node_id,
            title: graph.nodes.find((node) => node.id === args.node_id)?.title,
            mastery: index[args.node_id] ?? 'unknown',
            evidenceCount: graph.evidence.filter((item) => item.nodeId === args.node_id).length,
            unresolvedPrerequisites: [],
            detail: '用户/调用方指定的知识点。',
            directive: '',
          }
        : selectFocusNode(graph, { reviewPlan })

      const nodeEvidence = focus.nodeId ? graph.evidence.filter((item) => item.nodeId === focus.nodeId) : []
      const probe = deriveProbeState(graph.evidence, focus.nodeId)

      // 连续答错次数：由证据推出（末段连续 clarify / correct=false），用于 "打断去复习" 的判定
      const consecutiveAgain = nodeEvidence
        .slice()
        .reverse()
        .findIndex((item) => !(item.result === 'clarify' || item.correct === false)) 
      const againCount = consecutiveAgain === -1 ? nodeEvidence.length : consecutiveAgain
      const interrupt = shouldInterrupt(reviewPlan, { nodeId: focus.nodeId, consecutiveAgain: againCount })

      const move = nextSocraticMove({
        nodeId: focus.nodeId,
        mastery: focus.mastery ?? 'unknown',
        probeState: probe,
        evidence: nodeEvidence,
        cards: reviewPlan.queue.filter((item) => item.nodeId === focus.nodeId),
      })

      // 可选：把这次作答写成证据（掌握度仍是证据的纯函数，由 study_record_evidence / 进度工具重算）
      let recordedId = ''
      if (args.record) {
        const incoming = answerToEvidence({
          nodeId: focus.nodeId ?? '',
          sourceId: args.source_id ?? `${args.answer_kind ?? 'answer'}-${Date.now().toString(36)}`,
          answer: args.last_answer ?? '',
          kind: args.answer_kind ?? 'answer',
          correct: args.correct,
          selfReport: args.self_report,
          now,
        })
        await store.putEvidence(incoming as never)
        recordedId = `${incoming.kind}｜${incoming.summary}`
      }

      const bloom = focus.nodeId ? nodeBloomLevel(graph, focus.nodeId) : undefined
      const intent = quizIntent({
        mastery: focus.mastery ?? 'unknown',
        bloom: normalizeBloomLevel(bloom),
        hasCard: reviewPlan.queue.some((item) => item.nodeId === focus.nodeId) || cards.some((card) => card.nodeId === focus.nodeId),
      })

      const report = [
        renderFocus(focus),
        renderMove(move),
        interrupt
          ? `⏸ 建议此刻插入复习：${INTERRUPT_MAX_AGAIN} 次连续答错，或该节点有到期卡（${renderReviewPlan(reviewPlan)}）。`
          : `复习计划：${renderReviewPlan(reviewPlan)}`,
        // 教法：这一节是"按材料类型换教法"的落点 —— 模型每轮都会看到该问什么、怎么降阶
        `${MATERIAL_TYPE_LABEL[material.materialType ?? 'textbook']}｜${TEACHING_MODE_LABEL[strategy.mode]}`,
        `这一轮该问的是：${strategy.questionBias.join('；')}`,
        `降阶阶梯（按顺序，不要即兴发明）：${strategy.scaffoldLadder.join(' → ')}`,
        `验收方式：${QUIZ_INTENT_LABEL[intent]}｜${quizDirective(intent, focus.mastery ?? 'unknown')}`,
        `一次只问一个问题：本轮问题预算 ${move.questionBudget} 个；可以给答案：${move.mayRevealAnswer ? '可以（追问深度已到）' : '不可以'}。`,
        recordedId ? `已记录证据：${recordedId}` : '（本次未写入证据；需要记账时传 record=true）',
      ].join('\n')

      // 同步快照：让 context 节每轮都能看到环节、下一步与**材料形态**
      teachingStateSnapshot.current = {
        knowledgePoint: focus.title,
        probeState: probe,
        step: move.step,
        nextAction: move.action,
        dueCards: reviewPlan.dueCards,
        teachingMode: strategy.mode,
        sourceFormat: material.format,
        scenario: scenarioOf(material.materialType),
        errorType: latestErrorType(graph.evidence, focus.nodeId),
        hasConfusedNodes: graph.evidence.some((item) => item.mastery === 'confused' || item.correct === false),
      }

      // 环节留痕：只有**实际产生教学动作**的调用才记（且同一环节连续重复不重复记），
      // 这样课堂记录的"课堂过程"反映真实走过什么，而不是被"查看计划"灌满。
      const last = stepTrail[stepTrail.length - 1]
      if (!last || last.step !== move.step || last.action !== move.action) {
        stepTrail.push({ step: move.step, action: move.action, at: now.toISOString() })
      }

      return {
        step: move.step,
        action: move.action,
        question_budget: move.questionBudget,
        may_reveal_answer: move.mayRevealAnswer,
        must_retell: move.mustRetell,
        focus_node_id: focus.nodeId ?? '',
        focus_title: focus.title ?? '',
        focus_reason: focus.reason,
        quiz_intent: intent,
        recorded_evidence_id: recordedId,
        report,
      }
    },
    presentCall: (args) => ({ card: 'generic', title: '教学下一步', kind: 'other', rawInput: args.last_answer ?? '' }),
  })

  // —— 9. 格式能力（把 ingest 的能力清单真正接到生产上：模型不再对用户许下做不到的承诺）
  const formats = defineTool({
    name: 'study_formats',
    description:
      '列出本机当前能解析的输入格式（哪一层、是否可用、缺哪个依赖），以及明确**不支持**的格式。' +
      '导入失败或用户问"能不能读 PDF"时先查它，再给建议；不要凭印象承诺。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          report: { type: 'string', required: true },
          available: { type: 'integer', required: true },
          unavailable: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => text(value.report),
    },
    async execute() {
      let list: Awaited<ReturnType<typeof capabilities>> = []
      let failure = ''
      try {
        list = await capabilities()
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
      if (failure) {
        return { report: `无法探测解析能力：${failure}（不影响已导入材料的学习）`, available: 0, unavailable: 0 }
      }
      const available = list.filter((item) => item.available)
      const unavailable = list.filter((item) => !item.available)
      const lines = ['本机可用的输入格式（按解析层）：']
      for (const tier of ['native', 'builtin', 'external'] as const) {
        const inTier = available.filter((item) => item.tier === tier)
        if (inTier.length === 0) continue
        lines.push(`  [${INGEST_TIER_LABEL[tier]}] ${inTier.map((item) => `${item.id}（${item.formats.join('/')}${item.handlesScanned ? '，含扫描件' : ''}）`).join('、')}`)
      }
      if (unavailable.length > 0) {
        lines.push('', '本机缺失的解析器（这些格式会**如实失败**，不会返回空串冒充成功）：')
        for (const item of unavailable) {
          lines.push(`  - ${item.id}（${item.formats.join('/')}）：需要 ${(item.requires ?? []).join(' + ') || '外部依赖'}`)
        }
      }
      lines.push('', '明确不支持：pptx / xlsx / rtf / 音视频 / 手写体（`SourceFormat` 是封闭集合，不猜）。')
      lines.push('图片（png/jpg/webp/gif）：只能作为**附件**交给视觉模型，不能当教材正文。')
      lines.push('路径要求：PDF/docx 等必须给**文件路径**（工作区相对或绝对）；只给附件句柄时我拿到的是路径文本，不是正文。')
      return { report: lines.join('\n'), available: available.length, unavailable: unavailable.length }
    },
  })

  // —— 10. 收束与课堂记录（学了什么、走过哪些环节、还不完善的点）
  const wrapUp = defineTool({
    name: 'study_wrap_up',
    description:
      '收束一节课并生成**课堂记录**：本节学了哪些知识点、学生作答/复述/复习了多少次、' +
      '以及**还不完善的点**（混淆未澄清 / 问了没答上 / 材料残缺 / 该建卡却没建），每条都带下一步。' +
      '记录是**快照**，生成后不会被后来的证据改写；成功时同时把 Markdown 写进工作区并返回路径。' +
      '到阶段性收束时先问学生要不要留下记录，得到同意再调用。',
    parameters: {
      textbook_key: { type: 'string', description: '教材稳定 key；省略则用当前活动教材。' },
      note: { type: 'string', description: '可选的当堂补充（例如学生自己说的一句话），会附在记录里。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          record_path: { type: 'string', required: true },
          gaps: { type: 'integer', required: true },
          saved: { type: 'boolean', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(value.report),
    },
    async execute(args: { textbook_key?: string; note?: string }) {
      const key = args.textbook_key ?? (await store.activeTextbookKey())
      if (!key) {
        throw new Error('还没有选中的教材：先导入一份材料再收束本节课。')
      }
      const textbook = await store.getTextbook(key)
      const [nodes, evidence, cards] = await Promise.all([store.nodesFor(key), store.evidenceFor(key), store.cardsFor(key)])
      const material = decodeSourceFormat(textbook?.sourceFormat)
      const strategy = strategyFor(material.materialType ?? 'textbook')

      const record = buildClassroomRecord({
        textbookKey: key,
        title: textbook?.title ?? key,
        materialType: material.materialType ?? '',
        mode: strategy.mode,
        steps: stepTrail,
        evidence,
        nodes,
        cards: cards.map((card) => ({ id: card.id, nodeId: card.nodeId })),
        parseStatus: textbook?.parseStatus,
        parseError: textbook?.parseError ?? null,
      })
      const markdown = args.note?.trim()
        ? `${renderClassroomRecord(record)}\n\n## 当堂补充\n\n${args.note.trim()}\n`
        : renderClassroomRecord(record)

      // 先落盘记录（快照），再写 Markdown —— 任一步失败都**不**报告"已保存"
      const relativePath = classroomRecordPath(record)
      const stored: SessionRecord = {
        ...record,
        gaps: record.gaps.map((gap) => ({ ...gap, nodeId: gap.nodeId ?? null, title: gap.title ?? null })),
        recordPath: relativePath,
        createdAt: new Date().toISOString(),
      }
      await store.putSession(stored)

      let saved = false
      let savedPath = relativePath
      try {
        const fs = ctx?.fs as
          | { resolve(path: string, opts?: { cwd?: string }): Promise<unknown>; writeText?(target: unknown, content: string): Promise<unknown> }
          | undefined
        if (fs?.writeText) {
          const target = await fs.resolve(relativePath)
          // 目录不存在时 writeText 会失败，而 fs 服务没有 mkdir：先用 node:fs 建目录（仅建目录、不写文件）
          const absolute = String((target as { path?: string })?.path ?? '')
          if (absolute) mkdirSync(dirname(absolute), { recursive: true })
          await fs.writeText(target, markdown)
          saved = true
          savedPath = absolute || relativePath
        }
      } catch (error) {
        saved = false
        savedPath = `${relativePath}（写入失败：${error instanceof Error ? error.message : String(error)}）`
      }

      const gapLines = record.gaps.length
        ? record.gaps
            .map((gap, index) => `${index + 1}. [${CLASSROOM_GAP_LABEL[gap.kind]}] ${gap.detail}\n   下一步：${gap.nextStep}`)
            .join('\n')
        : '（无：没有未澄清的困惑、没有悬空提问、材料与卡片都齐）'
      const report = [
        `课堂记录已生成：${record.title}（${record.id}）`,
        record.summary,
        saved ? `已写入：${savedPath}` : `⚠️ 未能写入工作区（记录已存入库内）：${savedPath}`,
        '',
        '还不完善的点：',
        gapLines,
        '',
        record.nextEntry,
      ].join('\n')

      // 生成记录即视为本节收束：清空留痕，下一节从零开始
      stepTrail.length = 0

      return {
        session_id: record.id,
        record_path: saved ? savedPath : '',
        gaps: record.gaps.length,
        saved,
        report,
      }
    },
    presentCall: () => ({ card: 'generic', title: '课堂记录', kind: 'other', rawInput: '' }),
  })

  return [
    importTextbook,
    recordEvidence,
    retractEvidence,
    progress,
    reviewQueue,
    submitReview,
    createCard,
    rebuild,
    steps,
    formats,
    wrapUp,
  ]
}
