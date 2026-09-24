/**
 * 教材身份的稳定化。
 *
 * ## 原系统的问题
 *
 * `desktop/learning_textbooks.go:146-149`：
 *
 * ```go
 * func learningTextbookID(title, body string) string {
 *     sum := sha256.Sum256([]byte(title + "\n" + body))
 *     return "book-" + hex.EncodeToString(sum[:8])
 * }
 * ```
 *
 * 教材 ID 是"标题 + 正文"的哈希，导入时命中则原地替换、未命中则 **追加**
 * （`learning_textbooks.go:798`）。而图谱节点 id 由教材 id 派生
 * （`<bookID>-ch001-sec001`）。于是：
 * **只要改一个错别字再导入，就会得到一本全新教材**，
 * 旧的证据、掌握度、闪卡锚点、宫殿坐标全部与新教材失去关联，
 * 教材库里还多出一本同名条目。PDF 路径更严重，种子是
 * `路径|size|mtime`（`:650`），文件一存盘就换身份。
 *
 * 对于"边写书边学"的用法（本项目的真实语料就是 41 章正式稿），这是必经路径上的数据丢失。
 *
 * ## 修法：把"身份"和"版本"拆成两个概念
 *
 * - **身份（key）**：由**来源引用**决定（文件路径 / 显式 id / 标题兜底）。
 *   改正文不影响身份，学习状态安全。
 * - **版本（revision）**：正文内容哈希。用于判断"是否需要重新解析结构"，
 *   以及让 UI 显示"教材已更新"。
 * - **导入计划（planTextbookImport）**：明确告诉调用方是新建、修订还是无变化，
 *   并且修订时**必须**保留既有学习状态。
 */

import type { Mastery } from '../types.ts'

/** 教材的重解析状态。 */
export type ParseStatus = 'ready' | 'parsing' | 'failed'

/**
 * 教材记录 —— **与持久层（domain `textbooks` 表）同一形状**。
 *
 * ## 为什么形状必须与持久层一致（2026-09-24 修的第三个既有 bug）
 *
 * 此前这里是一个**嵌套**形状：`revision: { revision, parsedAt, parseStatus, parseError? }`，
 * 而 `plugin-host/src/storage.ts` 的 domain schema 要求：
 * `revision: z.string()` + `parseStatus: z.enum(...)` + `parseError: z.string().nullable()`（顶层）。
 *
 * 两者被当成同一个类型使用 —— `applyImportPlan()` 的返回值**直接**传给 `store.putTextbook()`。
 * 后果：每次导入写进域的都是**结构不合法的行**（`revision` 是对象、`parseStatus` 缺失），
 * 而 `parseStatus` 在工具里读出来永远是 `undefined`；重启时 domain 按 schema 校验会抛
 * `invalid-record`（与 C4 同一条链路：写入不校验、重新 open 才校验）。
 *
 * 修法：core 的记录形状与持久层对齐（`revision` 为字符串、`parseStatus`/`parseError` 在顶层），
 * 从而"导入 → 落盘 → 重新打开"是同一个形状，不再有隐式翻译。
 */
export type TextbookRecord = {
  /** 稳定身份：改正文不变。 */
  readonly key: string
  readonly title: string
  /** 来源引用（绝对/相对路径、URL 或用户显式给定的 id）。 */
  readonly sourceRef: string
  /** 来源格式（`markdown` / `pdf` / `docx` …），供 UI 显示与降级提示。 */
  readonly sourceFormat: string
  /** 正文内容哈希，用于判断"是否需要重新解析结构"。 */
  readonly revision: string
  readonly parsedAt: string
  readonly parseStatus: ParseStatus
  /** 解析失败原因；成功时为 `null`（与持久层的 `.nullable()` 同一约定）。 */
  readonly parseError: string | null
  /** 结构版本号，随每次成功重建结构递增。 */
  readonly structureVersion: number
  readonly createdAt: string
  readonly updatedAt: string
}

/** 学习状态：与结构解耦，重建结构时**必须**原样保留。 */
export type TextbookLearnerState = {
  readonly key: string
  readonly mastery: Readonly<Record<string, Mastery>>
  readonly palace: Readonly<Record<string, { order?: number; roomId?: string }>>
  readonly currentChapterId?: string
  readonly currentPageId?: string
  readonly lastPositionAt?: string
}

export type ImportAction = 'create' | 'revise' | 'unchanged'

export type ImportPlan = {
  readonly action: ImportAction
  readonly key: string
  readonly revision: string
  /** 修订/无变化时为 true：调用方必须复用既有学习状态。 */
  readonly preservesLearnerState: boolean
  /** 结构是否需要重建（正文变了就要重建）。 */
  readonly rebuildsStructure: boolean
  readonly reason: string
}

/**
 * 轻量内容哈希（FNV-1a 64 位，输出 16 位十六进制）。
 *
 * 刻意不用 `node:crypto`：core 包要求零依赖、可在任意运行时（浏览器 /
 * Electron 渲染进程 / 插件宿主）直接加载。这里只需要"内容变了要能发现"，
 * 不需要密码学强度。
 */
export function contentHash(body: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  // 按 UTF-16 码元推进；对中文同样是确定性的
  for (let index = 0; index < body.length; index += 1) {
    hash ^= BigInt(body.charCodeAt(index))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

function slugify(value: string): string {
  const ascii = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (ascii) return ascii.slice(0, 32)
  // 纯中文标题没有 ASCII 可留，用码点哈希保证稳定且可读性尚可
  return `t${contentHash(value).slice(0, 8)}`
}

/**
 * 计算教材稳定身份。
 *
 * 优先级：显式 id > 来源引用 > 标题。
 * **正文不参与** —— 这是与 `learningTextbookID` 的根本区别。
 */
export function textbookKey(input: { title: string; sourceRef?: string; explicitId?: string }): string {
  if (input.explicitId?.trim()) return `book:${slugify(input.explicitId.trim())}`
  const ref = input.sourceRef?.trim()
  if (ref) return `book:${slugify(ref)}-${contentHash(ref).slice(0, 6)}`
  return `book:${slugify(input.title)}`
}

/**
 * 规划一次教材导入，返回明确的动作与状态保留承诺。
 *
 * 这是修掉"改稿即失忆"的落点：修订同一本教材时
 * `preservesLearnerState` 恒为 `true`。
 */
export function planTextbookImport(input: {
  title: string
  body: string
  sourceRef?: string
  explicitId?: string
  existing?: TextbookRecord
  now?: string
}): ImportPlan {
  const key = textbookKey(input)
  const revision = contentHash(input.body)
  const now = input.now ?? new Date().toISOString()

  if (!input.existing) {
    return {
      action: 'create',
      key,
      revision,
      preservesLearnerState: false,
      rebuildsStructure: true,
      reason: `新建教材 ${key}（来源：${input.sourceRef ?? '未指定'}）`,
    }
  }

  if (input.existing.key !== key) {
    // 身份不同意味着这是另一本教材；显式说明，避免调用方误当修订处理
    return {
      action: 'create',
      key,
      revision,
      preservesLearnerState: false,
      rebuildsStructure: true,
      reason: `身份不同（既有 ${input.existing.key} ≠ 本次 ${key}），按新建处理`,
    }
  }

  if (input.existing.revision === revision) {
    return {
      action: 'unchanged',
      key,
      revision,
      preservesLearnerState: true,
      rebuildsStructure: false,
      reason: '正文未变化，复用既有结构与学习状态',
    }
  }

  return {
    action: 'revise',
    key,
    revision,
    preservesLearnerState: true,
    rebuildsStructure: true,
    reason: `正文变化（${input.existing.revision.slice(0, 8)} → ${revision.slice(0, 8)}），重建结构并保留学习状态`,
  }
}

/**
 * 应用导入计划，得到新的教材记录。
 *
 * 记录构造只在这一处：`sourceFormat` 缺省沿用旧值，`structureVersion`
 * 只在实际重建结构时递增，`createdAt` 在修订时保留 —— 这些不变量散到调用方就会漂移。
 */
export function applyImportPlan(
  plan: ImportPlan,
  input: { title: string; sourceRef?: string; sourceFormat?: string; existing?: TextbookRecord; now?: string },
): TextbookRecord {
  const now = input.now ?? new Date().toISOString()
  const existing = input.existing
  return {
    key: plan.key,
    title: input.title,
    sourceRef: input.sourceRef ?? existing?.sourceRef ?? '',
    sourceFormat: input.sourceFormat ?? existing?.sourceFormat ?? 'unknown',
    revision: plan.revision,
    parsedAt: now,
    parseStatus: 'ready',
    parseError: null,
    structureVersion: plan.rebuildsStructure
      ? (existing?.structureVersion ?? 0) + 1
      : existing?.structureVersion ?? 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
}

export function emptyLearnerState(key: string): TextbookLearnerState {
  return { key, mastery: {}, palace: {} }
}
