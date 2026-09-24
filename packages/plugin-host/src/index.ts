/**
 * 伴学插件宿主入口。
 *
 * ## 契约遵守要点（来自 cordis v4.0.2 源码取证，非猜测）
 *
 * 1. **只用具名导出，绝不 `export default`**。DSH 的 `Loader.unwrapExports`
 *    会取走 default 函数（`cordis-plugin-loader/src/index.ts:192-199`），
 *    导致 `name` / `inject` / `Config` 元数据丢失 —— 插件会被挂载但注入表为空。
 * 2. **可选依赖走 `ctx.get()`，不写进 `inject`**。cordis v4 的对象形式 `inject`
 *    是"服务名 → intercept 配置"，**不是** `{required, optional}`；
 *    把可选服务写成数组项会让 fiber 永远停在 PENDING（`fiber.ts:611-639`）。
 * 3. **清理只走 `ctx.effect` / `ctx.on`**。`export function apply(){}` 的返回值会被
 *    `new` 调用路径丢弃（`fiber.ts:251-260`），所以不依赖 return disposer。
 * 4. **不要 inject 内建属性**（logger/events/reflect/registry）——
 *    它们不是 provide 出来的服务，注入会让插件永不激活。
 *
 * ## 这一层刻意很薄
 *
 * 所有判定逻辑都在 `@dsh-study/core`（有测试），本文件只负责：
 * 拿到存储 → 注册工具 → 贡献系统提示节 → 注册技能与命令。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import {
  STUDY_CONTEXT_ORDER,
  STUDY_CONTEXT_SECTION,
  STUDY_PROMPT_ORDER,
  STUDY_PROMPT_SECTION,
  STUDY_PROTOCOL,
  buildStudyContext,
  teachingStateSnapshot,
} from './prompt.ts'
import { STUDY_DOMAIN, STUDY_DOMAIN_NAME, type StudyStore } from './storage.ts'
import { createDomainStore, createMemoryStore, type DomainHandle } from './store.ts'
import { createStudyTools } from './tools.ts'
import { decodeSourceFormat } from '../../core/src/pedagogy/material.ts'
import { TEACHING_MODE_LABEL, materialDirective, strategyFor } from '../../core/src/pedagogy/strategy.ts'
import { MATERIAL_TYPE_LABEL } from '../../core/src/types.ts'

export const name = 'study-alongwith-ai'

/**
 * 硬依赖：这三个都是宿主 provide 出来的服务，代码里用 `ctx.<name>.xxx()` 直接访问。
 * cordis 的服务代理对未在 inject 声明的服务会抛
 * `cannot get property "<name>" without inject`，并让整棵插件树加载失败。
 * - tools：注册伴学工具；
 * - systemPrompt：写伴学协议节与课堂状态 context；
 * - commands：注册 /study 斜杠命令。
 * 可选的 storage 不在此列——它走 `ctx.get('storage')`（见 resolveStore）。
 */
export const inject = ['tools', 'systemPrompt', 'commands']

export interface Config {
  /** 是否把伴学协议写进系统提示（默认开）。 */
  protocol: boolean
  /** 是否注册 `study-progress` 斜杠命令（默认开）。 */
  command: boolean
  /** 伴学数据域版本，用于将来的迁移。 */
  domainVersion: number
}

export const Config = z.object({
  protocol: z.boolean().default(true),
  command: z.boolean().default(true),
  domainVersion: z.natural().default(1),
})

/**
 * 选择存储实现，并让**本插件的 fiber 拥有数据域的生命周期**。
 *
 * 两处必须做对，都是真机踩出来的：
 *
 * 1. **open 必须配对 close**。DSH profile 是 `patchReload: live`：保存
 *    `cordis.patch.yml` 会先卸载插件再挂载一次。旧 fiber 不关域、新 fiber 再 open
 *    同一个域就会抛「已打开」；而我原先用 `void promise.then(...)` 吞掉了它 ——
 *    未处理的 rejection 直接变成 `dsh: fatal load failure`，宿主退出 1。
 *    现在把 open/close 放进一个 `ctx.effect`：卸载时反向执行，先 close，
 *    下一次 open 才可能成功。
 * 2. **任何失败都不得掀翻宿主**。域打不开就降级为内存存储并明确记日志 ——
 *    一个教学插件没有资格让整个 DSH 起不来。
 */
function resolveStore(ctx: Context): { store: StudyStore; storageKind: () => 'domain' | 'memory' } {
  const storage = ctx.get('storage') as { domain?: { open(spec: unknown): Promise<unknown> } } | undefined

  if (!storage?.domain?.open) {
    ctx.logger(name).warn(
      '主机未提供 storage.domain（需要 @deepseek-ai/dsh-storage-domain），伴学数据将只存在于本次运行内存中。' +
        '这不会影响教学逻辑，但重启后教材与复习排期会丢失。',
    )
    return { store: createMemoryStore(), storageKind: () => 'memory' }
  }

  let handle: DomainHandle | undefined

  ctx.effect(async () => {
    try {
      const opened = (await storage.domain!.open(STUDY_DOMAIN)) as DomainHandle
      handle = opened
      ctx.logger(name).info('伴学数据域已就绪：%s', STUDY_DOMAIN_NAME)
      return async () => {
        try {
          await opened.close()
        } catch (error) {
          ctx.logger(name).warn('关闭伴学数据域失败：%s', describeError(error))
        }
      }
    } catch (error) {
      // 降级而不是抛出：宿主必须活着。
      ctx.logger(name).warn('伴学数据域打开失败，本次运行降级为内存存储：%s', describeError(error))
      return () => {}
    }
  }, 'study-alongwith-ai: storage domain')

  return { store: createDomainStoreLazy(() => handle), storageKind: () => (handle ? 'domain' : 'memory') }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 域句柄是异步取得的，用惰性代理避免把 `apply()` 变成异步。
 *
 * 未就绪前走内存；就绪后把读写转发给 domain 实现。
 * `cached` 记住"句柄 → store"的映射：早先每读一个属性就新建一个 store，
 * 既浪费又会让每次调用都重新遍历域表。
 */
function createDomainStoreLazy(getHandle: () => DomainHandle | undefined): StudyStore {
  const memory = createMemoryStore()
  let cached: { handle: DomainHandle; store: StudyStore } | undefined
  return new Proxy(memory, {
    get(target, property, receiver) {
      const handle = getHandle()
      if (handle) {
        if (cached?.handle !== handle) cached = { handle, store: createDomainStore(handle) }
        const value = Reflect.get(cached.store as object, property)
        if (typeof value === 'function') return value.bind(cached.store)
        return value
      }
      return Reflect.get(target, property, receiver)
    },
  }) as StudyStore
}

export function apply(ctx: Context, config: Config): void {
  const { store, storageKind } = resolveStore(ctx)

  // —— 工具注册：返回的 disposer 交给 ctx.effect 持有，插件卸载即注销
  ctx.effect(() => {
    const disposers = createStudyTools(store, ctx as unknown as { fs?: unknown }).map((tool) => ctx.tools.register(tool))
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // 单个工具注销失败不应阻断其余清理
        }
      }
    }
  }, 'study-alongwith-ai: tools')

  // —— 系统提示：稳定协议走 section（文本不变则 DSH 一个事件都不写，前缀 cache 自然保持）
  if (config.protocol) {
    ctx.effect(
      () => ctx.systemPrompt.section({ name: STUDY_PROMPT_SECTION, order: STUDY_PROMPT_ORDER, text: STUDY_PROTOCOL }),
      'study-alongwith-ai: protocol section',
    )
    // 易变状态走 context：它是独立的 user 消息快照，且内容未变时同样不重复提交。
    // 文本从同步快照读取——装配期不能 await 存储，所以由工具在执行时更新快照。
    ctx.effect(
      () =>
        ctx.systemPrompt.context({
          name: STUDY_CONTEXT_SECTION,
          order: STUDY_CONTEXT_ORDER,
          text: () => {
            const snapshot = teachingStateSnapshot.current
            return Object.keys(snapshot).length === 0 ? '' : buildStudyContext(snapshot)
          },
        }),
      'study-alongwith-ai: teaching state context',
    )
  }

  // —— 斜杠命令：让用户显式查看进度，而不是靠往输入里塞 `/learn`
  if (config.command) {
    ctx.effect(
      () =>
        ctx.commands.register({
          name: 'study',
          description: '查看当前教材的学习进度与下一处推荐（伴学插件）',
          input: { hint: '[status]', attachments: false },
          handler: async (invocation: { agent?: unknown }) => {
            const key = await store.activeTextbookKey()
            if (!key) {
              return {
                kind: 'success' as const,
                text:
                  '还没有选中的教材。让我先导入一份材料（支持 Markdown / txt / PDF / Word / 图片），' +
                  '或直接说"用某份材料开始上课"。',
              }
            }
            const textbook = await store.getTextbook(key)
            const [nodes, evidence, cards] = await Promise.all([
              store.nodesFor(key),
              store.evidenceFor(key),
              store.cardsFor(key),
            ])
            const due = cards.filter((card) => !card.srs.nextReviewAt || card.srs.nextReviewAt.slice(0, 10) <= new Date().toISOString().slice(0, 10))
            return {
              kind: 'success' as const,
              text: [
                `教材：${textbook?.title ?? key}（${nodes.length} 个节点，${evidence.length} 条证据）`,
                `到期复习：${due.length} 张 / 共 ${cards.length} 张`,
                storageKind() === 'domain' ? '存储：已落盘' : '存储：仅本次运行（域未打开或主机未提供 storage.domain）',
                '需要具体推荐时问一句"下一步学什么"，我会给出带先修门控说明的路线。',
              ].join('\n'),
            }
          },
        }),
      'study-alongwith-ai: /study command',
    )

    // `/socratic` —— 与 /study 同构，但输出的是"当前环节 + 下一步动作 + 材料形态"，供苏格拉底模式使用。
    ctx.effect(
      () =>
        ctx.commands.register({
          name: 'socratic',
          description: '查看当前的教学环节与下一步动作（苏格拉底模式）',
          input: { hint: '[status]', attachments: false },
          handler: async () => {
            const key = await store.activeTextbookKey()
            if (!key) {
              return {
                kind: 'success' as const,
                text:
                  '还没有选中的教材。先锁定一份材料：导入文件（Markdown / txt / html / PDF / Word / odt / epub）、' +
                  '粘贴正文，或直接说一个想学的知识点。',
              }
            }
            const textbook = await store.getTextbook(key)
            const [nodes, cards] = await Promise.all([store.nodesFor(key), store.cardsFor(key)])
            const material = decodeSourceFormat(textbook?.sourceFormat)
            const strategy = strategyFor(material.materialType ?? 'textbook')
            const today = new Date().toISOString().slice(0, 10)
            const due = cards.filter((card) => !card.srs.nextReviewAt || card.srs.nextReviewAt.slice(0, 10) <= today)
            return {
              kind: 'success' as const,
              text: [
                `教材：${textbook?.title ?? key}（${nodes.length} 个节点，${cards.length} 张卡）`,
                `材料形态：${material.format ?? '未知'}｜${MATERIAL_TYPE_LABEL[material.materialType ?? 'textbook']}`,
                `教学模式：${TEACHING_MODE_LABEL[strategy.mode]}`,
                materialDirective(material.materialType ?? 'textbook'),
                `到期复习：${due.length} 张`,
                storageKind() === 'domain' ? '存储：已落盘' : '存储：仅本次运行（域未打开或主机未提供 storage.domain）',
                '想知道"下一步做什么"，直接问一句，或让我调用 study_steps。',
              ].join('\n'),
            }
          },
        }),
      'study-alongwith-ai: /socratic command',
    )
  }

  // 存储是否落盘由异步的域打开决定，成功与降级各自在 effect 里记了日志；
  // 这里只报能力，不谎报结果（域可能仍在打开中，也可能已降级）。
  ctx.logger(name).info('伴学插件已挂载（数据域 %s，当前存储：%s）', STUDY_DOMAIN_NAME, storageKind())
}
