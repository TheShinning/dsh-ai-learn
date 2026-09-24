/**
 * 伴学持久化：cordis storage domain 的数据形状。
 *
 * ## 为什么用 domain 而不是自己写文件
 *
 * DSH 的 `ctx.storage` 是 hub（不做 IO）→ backend（`json`，落盘在
 * `DSH_HOME/storages/`）→ form（`domain`）三层。`domain.table(...).put()` 的语义是
 * **先等后端落盘成功、再改内存、最后发 `domain/changed`** —— 也就是说写失败的记录
 * 不会留在内存里。原系统自己写整库单文件 JSON 时吃过亏：`learning_assets.go` 是
 * 读-改-整文件写，跨进程 last-writer-wins，另有两处非原子直写。
 *
 * ## 与原系统的数据形状对应
 *
 * | 原系统 | 本生态 | 修复点 |
 * |---|---|---|
 * | 节点 id 派生自教材正文哈希 | `textbooks` 表按**稳定 key** | 改稿不失忆 |
 * | 证据散在 `knowledge.json` | `evidence` 表，掌握度由证据纯函数重算 | 无双路径不对称 |
 * | 宫殿坐标挂在 node.palace，重建即丢 | `learner_state` 表独立于结构 | 重建保留摆位 |
 * | `assets.json` 里 options:[] 的口诀卡 | `cards` 表用判别联合 | 口诀卡可复习 |
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import z from 'zod'

import type { Evidence } from '../../core/src/knowledge/evidence.ts'
import type { KnowledgeEdge, KnowledgeNode } from '../../core/src/knowledge/graph.ts'
import type { SrsState } from '../../core/src/review/srs.ts'

/** 域名单，必须匹配 `^[a-z][a-z0-9_]*$`。 */
export const STUDY_DOMAIN_NAME = 'study_alongwith_ai'

// —— 记录 schema 用 zod（domain 层的约定；插件 Config 才用 schemastery）。
//    字段一律可空而非可选，避免"缺字段"与"字段为 null"两种语义并存——
//    原系统正是混用这两者导致兼容分支爆炸。

const TextbookRecordSchema = z.object({
  key: z.string().min(1),
  title: z.string(),
  sourceRef: z.string(),
  sourceFormat: z.string(),
  revision: z.string(),
  structureVersion: z.number().int().nonnegative(),
  parseStatus: z.enum(['ready', 'parsing', 'failed']),
  parseError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const NodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['textbook', 'chapter', 'section', 'page', 'concept']),
  title: z.string(),
  textbookKey: z.string(),
  chapterId: z.string().nullable(),
  sectionId: z.string().nullable(),
  pageId: z.string().nullable(),
  anchor: z.string().nullable(),
  structureVersion: z.number().int().nonnegative(),
})

const EdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string(),
  to: z.string(),
  relation: z.enum(['contains', 'prerequisite', 'contrasts', 'confused-with', 'example-of']),
  confidence: z.number(),
  /** 手工建立的语义边不随结构重建丢失。 */
  manual: z.boolean(),
})

const EvidenceSchema = z.object({
  id: z.string().min(1),
  nodeId: z.string().min(1),
  kind: z.string().min(1),
  sourceId: z.string(),
  summary: z.string().min(1),
  detail: z.string().nullable(),
  result: z.string().nullable(),
  confidence: z.number().nullable(),
  mastery: z.enum(['unknown', 'partial', 'confused', 'mastered']).nullable(),
  correct: z.boolean().nullable(),
  bloomLevel: z.string().nullable(),
  srsResult: z.enum(['again', 'hard', 'good']).nullable(),
  errorType: z.string().nullable(),
  createdAt: z.string(),
})

const CardSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['choice', 'cloze', 'short-answer', 'mnemonic']),
  textbookKey: z.string().nullable(),
  nodeId: z.string().nullable(),
  anchor: z.string().nullable(),
  prompt: z.string(),
  /** 选择题的选项；非选择题恒为空数组——**不再因此被排除在复习之外**。 */
  options: z.array(z.object({ key: z.string(), text: z.string() })),
  answerKey: z.string().nullable(),
  answer: z.string().nullable(),
  explanation: z.string().nullable(),
  knowledgePoint: z.string().nullable(),
  scope: z.string().nullable(),
  srs: z.object({
    intervalDays: z.number(),
    easeFactor: z.number(),
    nextReviewAt: z.string().nullable(),
    practiceCount: z.number().int().nonnegative(),
    lastReviewedAt: z.string().nullable(),
  }),
  createdAt: z.string(),
})

/** 学习者状态：与结构解耦，结构重建时**原样保留**。 */
const LearnerStateSchema = z.object({
  textbookKey: z.string().min(1),
  currentChapterId: z.string().nullable(),
  currentPageId: z.string().nullable(),
  /** 宫殿摆位（顺序 / 房间）。 */
  palace: z.record(z.string(), z.object({ order: z.number().nullable(), roomId: z.string().nullable() })),
  /** 追问深度状态。 */
  probe: z.object({
    nodeId: z.string().nullable(),
    probeDepth: z.number().int().min(0).max(3),
    lastEvidenceTone: z.enum(['unknown', 'confused', 'partial', 'mastered']),
    streak: z.number().int().nonnegative(),
  }),
  updatedAt: z.string(),
})

/**
 * 课堂记录（v2 新增）。
 *
 * 存的是**快照**：生成后再产生的证据不会改写它 —— 历史结论必须冻结。
 * 数组字段一律必填（可为空数组），避免"缺字段"与"空值"两种语义并存。
 */
const SessionSchema = z.object({
  id: z.string().min(1),
  textbookKey: z.string(),
  title: z.string(),
  materialType: z.string(),
  mode: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  steps: z.array(z.object({ step: z.string(), at: z.string(), action: z.string() })),
  nodesTouched: z.array(
    z.object({
      nodeId: z.string(),
      title: z.string(),
      mastery: z.enum(['unknown', 'partial', 'confused', 'mastered']),
      evidenceIds: z.array(z.string()),
    }),
  ),
  evidenceIds: z.array(z.string()),
  answered: z.number().int().nonnegative(),
  explained: z.number().int().nonnegative(),
  retold: z.number().int().nonnegative(),
  retoldPassed: z.number().int().nonnegative(),
  review: z.object({
    submitted: z.number().int().nonnegative(),
    again: z.number().int().nonnegative(),
    hard: z.number().int().nonnegative(),
    good: z.number().int().nonnegative(),
  }),
  gaps: z.array(
    z.object({
      kind: z.enum(['confused-node', 'unanswered', 'material-defect', 'system-gap']),
      source: z.enum(['evidence', 'material', 'system', 'heuristic']),
      nodeId: z.string().nullable(),
      title: z.string().nullable(),
      detail: z.string(),
      nextStep: z.string(),
    }),
  ),
  summary: z.string(),
  nextEntry: z.string(),
  /** 落盘的 Markdown 路径（相对工作区）；未落盘时为空串。 */
  recordPath: z.string(),
  createdAt: z.string(),
})

export const STUDY_DOMAIN = defineDomain({
  name: STUDY_DOMAIN_NAME,
  version: 2,
  /**
   * **升级安全的关键一行**（2026-09-25 读 `dsh-storage-json` 实现后加的）。
   *
   * 本域是 `layout: 'per-record'`：一条记录一个文件，**每个文件都带版本戳**。
   * 后端读取时只接受"当前版本 + compatibleVersions"；不在集合里的戳会让该记录
   * **读作"不存在"——是丢弃，不是迁移，而且不报错**。
   *
   * 也就是说：加了 v2 的 `sessions` 表却忘了写这一行，用户升级后会看到
   * "教材、证据、复习排期全空了"，且没有任何错误提示。写了这一行，
   * v1 的记录照常读入（`sessions` 对旧数据就是空表），这就是平滑升级。
   */
  compatibleVersions: [1],
  layout: 'per-record',
  tables: {
    textbooks: domainTable(TextbookRecordSchema),
    nodes: domainTable(NodeSchema),
    edges: domainTable(EdgeSchema),
    evidence: domainTable(EvidenceSchema),
    cards: domainTable(CardSchema),
    learner_state: domainTable(LearnerStateSchema),
    sessions: domainTable(SessionSchema),
  },
  global: {
    // 注意：domain 的 global schema 不能接受 null —— null 是"从未写入"的哨兵值。
    schema: z.object({
      activeTextbookKey: z.string().nullable(),
      schemaNote: z.string().nullable(),
    }),
    initial: { activeTextbookKey: null, schemaNote: null },
  },
})

export type TextbookRecord = z.infer<typeof TextbookRecordSchema>
export type LearnerState = z.infer<typeof LearnerStateSchema>
export type StudyCardRecord = z.infer<typeof CardSchema>
export type SessionRecord = z.infer<typeof SessionSchema>

/** 存储门面：让工具实现不关心后端是 domain 还是内存。 */
export interface StudyStore {
  listTextbooks(): Promise<TextbookRecord[]>
  getTextbook(key: string): Promise<TextbookRecord | undefined>
  putTextbook(record: TextbookRecord): Promise<void>
  activeTextbookKey(): Promise<string | undefined>
  setActiveTextbook(key: string | null): Promise<void>

  nodesFor(textbookKey: string): Promise<KnowledgeNode[]>
  edgesFor(textbookKey: string): Promise<KnowledgeEdge[]>
  replaceStructure(textbookKey: string, nodes: KnowledgeNode[], edges: KnowledgeEdge[]): Promise<void>
  addEdge(edge: KnowledgeEdge): Promise<void>

  evidenceFor(textbookKey: string): Promise<Evidence[]>
  putEvidence(item: Evidence): Promise<void>
  deleteEvidence(id: string): Promise<void>

  cardsFor(textbookKey?: string): Promise<StudyCardRecord[]>
  putCard(card: StudyCardRecord): Promise<void>

  learnerState(textbookKey: string): Promise<LearnerState>
  putLearnerState(state: LearnerState): Promise<void>

  /** 课堂记录：写入快照（write-once，不做原地更新）。 */
  putSession(record: SessionRecord): Promise<void>
  /** 某本教材的课堂记录，按结束时间升序。 */
  sessionsFor(textbookKey?: string): Promise<SessionRecord[]>
  /** 最近一次课堂记录（用于进度工具与 `/socratic` 的一行摘要）。 */
  latestSession(textbookKey?: string): Promise<SessionRecord | undefined>
}

export type { KnowledgeEdge, KnowledgeNode, SrsState }
