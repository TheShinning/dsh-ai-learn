/**
 * `StudyStore` 的两个实现：domain 后端（生产）与内存（降级/测试）。
 *
 * 选择策略在 `index.ts` 里：能用 `ctx.storage.domain` 就用它，否则用内存
 * 并把这件事写进日志 —— **不静默降级**。原系统在这一点上的教训是把解析失败
 * 写成 220 字截断错误，调用方无法区分"能力缺失"与"文档问题"。
 */

import type { Evidence } from '../../core/src/knowledge/evidence.ts'
import type { EdgeRelation, KnowledgeEdge, KnowledgeNode, NodeType } from '../../core/src/knowledge/graph.ts'
import { INITIAL_SRS, type SrsState } from '../../core/src/review/srs.ts'
import type { LearnerState, SessionRecord, StudyCardRecord, StudyStore, TextbookRecord } from './storage.ts'

/** 新卡片的初始 SRS。 */
export function newCardSrs(): SrsState {
  return { ...INITIAL_SRS }
}

export function emptyLearnerState(textbookKey: string): LearnerState {
  return {
    textbookKey,
    currentChapterId: null,
    currentPageId: null,
    palace: {},
    probe: { nodeId: null, probeDepth: 0, lastEvidenceTone: 'unknown', streak: 0 },
    updatedAt: new Date().toISOString(),
  }
}

/** 内存实现：语义与 domain 版一致，供无 storage 服务的主机与单测使用。 */
export function createMemoryStore(): StudyStore {
  const textbooks = new Map<string, TextbookRecord>()
  const nodes = new Map<string, KnowledgeNode[]>()
  const edges = new Map<string, KnowledgeEdge[]>()
  const evidence = new Map<string, Evidence>()
  const cards = new Map<string, StudyCardRecord>()
  const learner = new Map<string, LearnerState>()
  const sessions = new Map<string, SessionRecord>()
  let active: string | null = null

  return {
    async listTextbooks() {
      return [...textbooks.values()]
    },
    async getTextbook(key) {
      return textbooks.get(key)
    },
    async putTextbook(record) {
      textbooks.set(record.key, record)
    },
    async activeTextbookKey() {
      return active ?? undefined
    },
    async setActiveTextbook(key) {
      active = key
    },
    async nodesFor(textbookKey) {
      return nodes.get(textbookKey) ?? []
    },
    async edgesFor(textbookKey) {
      const ids = new Set((nodes.get(textbookKey) ?? []).map((node) => node.id))
      return (edges.get(textbookKey) ?? []).filter((edge) => ids.has(edge.from) && ids.has(edge.to))
    },
    async replaceStructure(textbookKey, nextNodes, nextEdges) {
      nodes.set(textbookKey, [...nextNodes])
      // 结构边替换，手工语义边保留（与 core 的 rebuildStructure 语义一致）
      const manual = (edges.get(textbookKey) ?? []).filter(
        (edge) => edge.relation !== 'contains' && edge.relation !== 'prerequisite',
      )
      edges.set(textbookKey, [...nextEdges, ...manual])
    },
    async addEdge(edge) {
      for (const [key, list] of edges) {
        if (list.some((item) => item.id === edge.id)) return
        if (list.some((item) => item.from === edge.from)) {
          edges.set(key, [...list, edge])
          return
        }
      }
    },
    async evidenceFor(textbookKey) {
      const ids = new Set((nodes.get(textbookKey) ?? []).map((node) => node.id))
      return [...evidence.values()].filter((item) => ids.has(item.nodeId))
    },
    async putEvidence(item) {
      evidence.set(item.id, item)
    },
    async deleteEvidence(id) {
      evidence.delete(id)
    },
    async cardsFor(textbookKey) {
      const all = [...cards.values()]
      return textbookKey ? all.filter((card) => card.textbookKey === textbookKey) : all
    },
    async putCard(card) {
      cards.set(card.id, card)
    },
    async learnerState(textbookKey) {
      return learner.get(textbookKey) ?? emptyLearnerState(textbookKey)
    },
    async putLearnerState(state) {
      learner.set(state.textbookKey, state)
    },
    async putSession(record) {
      sessions.set(record.id, record)
    },
    async sessionsFor(textbookKey) {
      return [...sessions.values()]
        .filter((record) => (textbookKey ? record.textbookKey === textbookKey : true))
        .sort((left, right) => (left.endedAt < right.endedAt ? -1 : left.endedAt > right.endedAt ? 1 : 0))
    },
    async latestSession(textbookKey) {
      const list = await this.sessionsFor(textbookKey)
      return list[list.length - 1]
    },
  }
}

// —— domain 后端。句柄只声明本模块用到的形状，避免对 DSH 内部类型产生硬依赖。

type DomainTableHandle<T> = {
  get(key: string): T | undefined
  entries(): IterableIterator<[string, T]>
  put(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
}

export type DomainHandle = {
  table<T>(name: string): DomainTableHandle<T>
  global: {
    get(): { activeTextbookKey: string | null }
    set(value: { activeTextbookKey: string | null }): Promise<void>
  }
  close(): Promise<void>
}

type NodeRow = {
  id: string
  type: NodeType
  title: string
  textbookKey: string
  chapterId: string | null
  sectionId: string | null
  pageId: string | null
  anchor: string | null
  structureVersion: number
}
type EdgeRow = { id: string; from: string; to: string; relation: EdgeRelation; confidence: number; manual: boolean }
type EvidenceRow = {
  id: string
  nodeId: string
  kind: string
  sourceId: string
  summary: string
  detail: string | null
  result: string | null
  confidence: number | null
  mastery: Evidence['mastery'] | null
  correct: boolean | null
  bloomLevel: string | null
  srsResult: Evidence['srsResult'] | null
  errorType: string | null
  createdAt: string
}
type CardRow = StudyCardRecord

function nodeToRow(node: KnowledgeNode, structureVersion: number): NodeRow {
  return {
    id: node.id,
    type: node.type,
    title: node.title,
    textbookKey: node.textbookKey ?? '',
    chapterId: node.chapterId ?? null,
    sectionId: node.sectionId ?? null,
    pageId: node.pageId ?? null,
    anchor: node.anchor ?? null,
    structureVersion,
  }
}

function rowToNode(row: NodeRow): KnowledgeNode {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    textbookKey: row.textbookKey,
    chapterId: row.chapterId ?? undefined,
    sectionId: row.sectionId ?? undefined,
    pageId: row.pageId ?? undefined,
    anchor: row.anchor ?? undefined,
  }
}

function edgeToRow(edge: KnowledgeEdge, manual: boolean): EdgeRow {
  return { id: edge.id, from: edge.from, to: edge.to, relation: edge.relation, confidence: edge.confidence, manual }
}

function rowToEdge(row: EdgeRow): KnowledgeEdge {
  return { id: row.id, from: row.from, to: row.to, relation: row.relation, confidence: row.confidence }
}

function evidenceToRow(item: Evidence): EvidenceRow {
  return {
    id: item.id,
    nodeId: item.nodeId,
    kind: item.kind,
    sourceId: item.sourceId,
    summary: item.summary,
    detail: item.detail ?? null,
    result: item.result ?? null,
    confidence: item.confidence ?? null,
    mastery: item.mastery ?? null,
    correct: item.correct ?? null,
    bloomLevel: item.bloomLevel ?? null,
    srsResult: item.srsResult ?? null,
    errorType: item.errorType ?? null,
    createdAt: item.createdAt,
  }
}

function rowToEvidence(row: EvidenceRow): Evidence {
  return {
    id: row.id,
    nodeId: row.nodeId,
    kind: row.kind as Evidence['kind'],
    sourceId: row.sourceId,
    summary: row.summary,
    detail: row.detail ?? undefined,
    result: row.result ?? undefined,
    confidence: row.confidence ?? undefined,
    mastery: row.mastery ?? undefined,
    correct: row.correct ?? undefined,
    bloomLevel: (row.bloomLevel ?? undefined) as Evidence['bloomLevel'],
    srsResult: row.srsResult ?? undefined,
    errorType: (row.errorType ?? undefined) as Evidence['errorType'],
    createdAt: row.createdAt,
  }
}

function cardToRow(card: StudyCardRecord): CardRow {
  return {
    id: card.id,
    kind: card.kind,
    textbookKey: card.textbookKey ?? null,
    nodeId: card.nodeId ?? null,
    anchor: card.anchor ?? null,
    prompt: card.prompt,
    options: card.kind === 'choice' ? card.options.map((option) => ({ key: option.key, text: option.text })) : [],
    answerKey: card.kind === 'choice' ? card.answerKey : null,
    answer: card.kind === 'choice' ? null : card.answer,
    explanation: card.explanation ?? null,
    knowledgePoint: card.kind === 'mnemonic' ? card.knowledgePoint : null,
    scope: card.kind === 'mnemonic' ? (card.scope ?? null) : null,
    srs: {
      intervalDays: card.srs.intervalDays,
      easeFactor: card.srs.easeFactor,
      nextReviewAt: card.srs.nextReviewAt ?? null,
      practiceCount: card.srs.practiceCount,
      lastReviewedAt: card.srs.lastReviewedAt ?? null,
    },
    createdAt: card.createdAt,
  }
}

function rowToCard(row: CardRow): StudyCardRecord {
  const srs: SrsState = {
    intervalDays: row.srs.intervalDays,
    easeFactor: row.srs.easeFactor,
    nextReviewAt: row.srs.nextReviewAt ?? undefined,
    practiceCount: row.srs.practiceCount,
    lastReviewedAt: row.srs.lastReviewedAt ?? undefined,
  }
  const base = {
    id: row.id,
    textbookKey: row.textbookKey ?? null,
    nodeId: row.nodeId ?? null,
    anchor: row.anchor ?? null,
    prompt: row.prompt,
    explanation: row.explanation ?? null,
    createdAt: row.createdAt,
    srs,
  }
  switch (row.kind) {
    case 'choice':
      return { ...base, kind: 'choice', options: row.options, answerKey: row.answerKey ?? '', answer: null, knowledgePoint: null, scope: null }
    case 'cloze':
      return { ...base, kind: 'cloze', options: [], answerKey: null, answer: row.answer ?? '', knowledgePoint: null, scope: null }
    case 'short-answer':
      return { ...base, kind: 'short-answer', options: [], answerKey: null, answer: row.answer ?? '', knowledgePoint: null, scope: null }
    default:
      return {
        ...base,
        kind: 'mnemonic',
        options: [],
        answerKey: null,
        answer: row.answer ?? '',
        knowledgePoint: row.knowledgePoint ?? '',
        scope: row.scope ?? null,
      }
  }
}

/**
 * domain 实现。读取走内存视图（同步），写入串行且先落盘。
 *
 * 证据按 `nodeId` 存储，而节点 id 由教材稳定 key + 结构序号派生 ——
 * 所以结构重建不会让证据失去关联（原系统的教材 id 含正文哈希，改稿即失联）。
 */
export function createDomainStore(domain: DomainHandle): StudyStore {
  const textbooks = domain.table<TextbookRecord>('textbooks')
  const nodes = domain.table<NodeRow>('nodes')
  const edges = domain.table<EdgeRow>('edges')
  const evidence = domain.table<EvidenceRow>('evidence')
  const cards = domain.table<CardRow>('cards')
  const learner = domain.table<LearnerState>('learner_state')
  const sessions = domain.table<SessionRecord>('sessions')

  const nodesOf = (textbookKey: string): KnowledgeNode[] =>
    [...nodes.entries()]
      .map(([, row]) => row)
      .filter((row) => row.textbookKey === textbookKey)
      .map(rowToNode)

  return {
    async listTextbooks() {
      return [...textbooks.entries()].map(([, row]) => row)
    },
    async getTextbook(key) {
      return textbooks.get(key)
    },
    async putTextbook(record) {
      await textbooks.put(record.key, record)
    },
    async activeTextbookKey() {
      return domain.global.get().activeTextbookKey ?? undefined
    },
    async setActiveTextbook(key) {
      // 必须写**完整** global：domain 的 global schema 要求 activeTextbookKey 与 schemaNote 都在
      // （storage.ts 的 STUDY_DOMAIN.global.schema）。写入时不校验，但**重新 open 时**会
      // `global.schema.parse(snapshot.global)`（dsh-storage-domain/lib/index.js:383），
      // 少一个字段就抛 DomainError('invalid-record') —— 也就是"设置过一次活动教材之后，
      // 下次启动再也打不开数据域"。这里用当前 global 拼全，避免把持久态写成半截对象。
      const current = domain.global.get()
      await domain.global.set({ ...current, activeTextbookKey: key })
    },
    async nodesFor(textbookKey) {
      return nodesOf(textbookKey)
    },
    async edgesFor(textbookKey) {
      const ids = new Set(nodesOf(textbookKey).map((node) => node.id))
      return [...edges.entries()]
        .map(([, row]) => rowToEdge(row))
        .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
    },
    async replaceStructure(textbookKey, nextNodes, nextEdges) {
      const keep = new Set(nextNodes.map((node) => node.id))
      for (const [id, row] of [...nodes.entries()]) {
        if (row.textbookKey === textbookKey && !keep.has(id)) await nodes.delete(id)
      }
      for (const node of nextNodes) await nodes.put(node.id, nodeToRow(node, 1))
      // 结构边整体替换；手工语义边保留
      for (const [id, row] of [...edges.entries()]) {
        if (row.relation === 'contains' || row.relation === 'prerequisite') await edges.delete(id)
      }
      for (const edge of nextEdges) await edges.put(edge.id, edgeToRow(edge, false))
    },
    async addEdge(edge) {
      await edges.put(edge.id, edgeToRow(edge, true))
    },
    async evidenceFor(textbookKey) {
      const ids = new Set(nodesOf(textbookKey).map((node) => node.id))
      return [...evidence.entries()]
        .map(([, row]) => rowToEvidence(row))
        .filter((item) => ids.has(item.nodeId))
    },
    async putEvidence(item) {
      await evidence.put(item.id, evidenceToRow(item))
    },
    async deleteEvidence(id) {
      await evidence.delete(id)
    },
    async cardsFor(textbookKey) {
      return [...cards.entries()]
        .map(([, row]) => rowToCard(row))
        .filter((card) => (textbookKey ? card.textbookKey === textbookKey : true))
    },
    async putCard(card) {
      await cards.put(card.id, cardToRow(card))
    },
    async learnerState(textbookKey) {
      return learner.get(textbookKey) ?? emptyLearnerState(textbookKey)
    },
    async putLearnerState(state) {
      await learner.put(state.textbookKey, state)
    },
    async putSession(record) {
      await sessions.put(record.id, record)
    },
    async sessionsFor(textbookKey) {
      return [...sessions.entries()]
        .map(([, row]) => row)
        .filter((record) => (textbookKey ? record.textbookKey === textbookKey : true))
        .sort((left, right) => (left.endedAt < right.endedAt ? -1 : left.endedAt > right.endedAt ? 1 : 0))
    },
    async latestSession(textbookKey) {
      const list = await this.sessionsFor(textbookKey)
      return list[list.length - 1]
    },
  }
}
