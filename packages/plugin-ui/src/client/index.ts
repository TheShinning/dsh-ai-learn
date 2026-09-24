/**
 * 伴学客户端插件（浏览器半边）—— **构建前源码形态**。
 *
 * ## 交付形态说明（重要）
 *
 * DSH 的客户端插件是**双面包**：
 * - `lib/index.js`（宿主半边）= 空 `apply`，只为让包里有一个 Loader entry；
 * - `lib/client.js`（浏览器半边）= 一个 IIFE，执行时只做一件事：
 *   `window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => {...} })`，
 *   由 tsdown 之类把本文件打包成那个形状（DSH 自己用 tsdown + `\0dsh-css:` 虚拟模块）。
 *
 * 也就是说：**本文件是源码，不是可直接被浏览器加载的产物**。要真正跑起来，
 * 需要按仓库 README 的"构建"小节把它打包成 `lib/client.js`。这一点我如实标注，不假装已完成。
 *
 * ## 与原系统的关系（这条修复对应"组件未挂载但验收通过"）
 *
 * 原伴学系统有一整棵未挂载的重复 UI 树：`LearningWorkspace.tsx` 无 importer，
 * 连带 `LearningHeader` / `LearningToolbar` / `LearningFocusHud` / `ClassroomPanel` /
 * `LearningStudioPanel` / `LearningAssetsPanel` 全部不可达 —— 于是"节奏条统一"与
 * "证据点亮脉冲"两项能力有事件发射、没有接收者。
 *
 * DSH 的 slot 机制从结构上排除了这类问题：UI **只能**经 `ctx.slots.register` 注册，
 * 由宿主负责实例化与渲染。注册表会拒绝未声明的 slot、拒绝同 cell 同优先级重复注册，
 * 崩溃的 entry 会被边界捕获并让位。
 */

import { createElement as h, type ReactNode } from 'react'

export const name = 'study-alongwith-ai'

/**
 * 客户端服务依赖（**服务名**，不是包名 —— 这两者体系不同，不能互抄）。
 * `slots` 提供扩展点，`locale` 提供文案，`theme` 用于跟随明暗主题。
 */
export const inject = ['slots', 'locale', 'theme']

const NS = 'study-alongwith-ai'

/** 字典必须扁平：`"panel.empty"` 是一个完整 key，点号只是命名约定。 */
const zh: Record<string, string> = {
  section: '伴学',
  'panel.empty': '还没有选中的教材。把 Markdown / txt / PDF / Word / 图片 拖进来即可开始。',
  'panel.hint': '在对话里说「下一步学什么」，我会给出带先修门控说明的推荐。',
  'panel.storage': '存储',
  'panel.storage.persistent': '已落盘',
  'panel.storage.memory': '仅本次运行（宿主未提供 storage.domain）',
}

const en: Record<string, string> = {
  section: 'Study',
  'panel.empty': 'No textbook selected yet. Drop in Markdown / txt / PDF / Word / image to start.',
  'panel.hint': 'Ask "what should I study next" in the chat for a prerequisite-gated recommendation.',
  'panel.storage': 'Storage',
  'panel.storage.persistent': 'Persisted',
  'panel.storage.memory': 'This run only (host provides no storage.domain)',
}

interface ThemeService {
  getTheme(): { active: { colorScheme: 'light' | 'dark' } } | null
}

interface SlotsService {
  /** 在 slot 被声明前先 inject 是合法的：声明提交后回调才跑，重声明会再跑一次。 */
  inject(slot: string, register: () => unknown): unknown
  register(meta: Record<string, unknown>, component: (props: Record<string, unknown>) => ReactNode): unknown
}

interface LocaleService {
  register(namespace: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): () => void
  bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
}

interface StudyClientContext {
  effect(callback: () => unknown, label?: string): void
  slots: SlotsService
  locale: LocaleService
  theme: ThemeService
}

/** 面板组件。`t` 由 slot 注册时的 `locale: NS` 选项注入，其余是标准 props + 自己的 inject 面。 */
function StudyPanel(props: { t: (key: string) => string; persistent?: boolean }): ReactNode {
  const { t, persistent } = props
  return h('div', { className: 'dsh-study-panel', 'data-dsh-study-panel': '' }, [
    h('p', { key: 'empty' }, t('panel.empty')),
    h('p', { key: 'hint' }, t('panel.hint')),
    h('p', { key: 'storage' }, `${t('panel.storage')}：${persistent ? t('panel.storage.persistent') : t('panel.storage.memory')}`),
  ])
}

export function apply(ctx: StudyClientContext): void {
  // 字典注册是 fiber effect：插件卸载 / HMR 重载时自动摘除，不泄漏。
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${name}: dictionaries`)
  const t = ctx.locale.bind(NS)

  // `settings.section` 是 list 型 slot（root scope），因此需要 `id`。
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'study-alongwith-ai',
        order: 45,
        label: () => t('section'),
        locale: NS,
        inject: () => ({ t }),
      },
      (ownerProps: Record<string, unknown>) => StudyPanel({ t, persistent: ownerProps.persistent as boolean | undefined }),
    ),
  )
}
