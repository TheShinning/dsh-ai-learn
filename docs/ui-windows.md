# 伴学模式的窗口设计（加入教材 / 学习记录 / 悬浮窗保留）

> 状态：**设计已定；客户端半边已能构建，但尚未在真实浏览器里渲染过**。
> `lib/client.js` 现在由 `scripts/build.mjs` 产出（契约取证自两个真实第三方插件产物，
> 不依赖打包器），并在 `npm run check:build` 里于假 `window.__ModuleLoader__` 下求值通过。
> 未验证的部分只剩"它在真实 Web GUI 里长什么样、slot 元数据是否被接受"。
> 本文把每个窗口落到 DSH 的**具名 slot** 与**数据来源**上，使实现不需要再猜。

## 一、先厘清"模式"与"窗口"分别挂在哪

| 关注点 | 机制 | 现状 |
|---|---|---|
| **伴学模式**（与标准/PTC/极简并列） | **agent preset**：`presets/study/`（含 `preset.yml` + `agent.cordis.yml`），由 bundle 补丁的 `agent-presets.roots` 以 `trust: system` 发布 | ✅ 已交付；安装形态由 `check:install` 每次验证 |
| 伴学**工具**（8 个 `study_*`） | 宿主插件 `dsh-study-alongwith-ai`（bundle 补丁层插入 `study-alongwith-ai` 行） | ✅ 已挂载（工具全局可用，协议只在 preset 人格里） |
| 伴学**技能** | preset 自带 `skills/`（与官方 `cordis` preset 同构，不写 `customSkillDirs`） | ⚠️ 随 preset 发布；可见性取决于部署对 preset 本地技能目录的处理，未在本机实测 |
| **窗口/面板** | **客户端插件**经 slot 注册 | ⚠️ 已产出 `lib/client.js` 并通过模块契约验证，**未在浏览器渲染过** |

关键的架构事实：DSH 的 preset 组合里**没有浮窗类型**这种概念 —— 窗口属于**客户端 UI 层**，
由 slot 注册表实例化。所以"保留悬浮窗"这件事在 DSH 里不是"迁移原系统的 FloatingWindowShell"，
而是**在我的面板内部自己实现一套浮层**（DSH 允许 slot 组件渲染任意 DOM，包括 `position: fixed` 的浮层）。

## 二、窗口清单与槽位映射

| 窗口 | 用途 | DSH slot | kind / scope | 数据来源 |
|---|---|---|---|---|
| **加入教材** | 选文件 / 粘贴正文 → 导入为教材 | `conversation.input.left`（入口按钮）+ 自身浮层（表单） | list / session | 表单收集路径 → **起草消息**（见下） |
| **学习记录**（学习轨迹） | 时间线：证据、复习、课堂事件 | `sidebar.right.pane.tab` + `sidebar.right.pane.tab.title` | keyed / session | `study_progress` 的工具输出 + 会话事件 |
| **教材阅读** | 当前教材的章/节/页，可跳转 | 自身浮层（宽浮窗） | — | `study-import` 回执 + `ctx.fs` 读原文 |
| **闪卡复习** | 到期卡练习 | 自身浮层 | — | `study_review_queue` / `study_submit_review` |
| **知识图谱 / 成长档案** | 掌握度分布、统计 | `settings.section`（已有）+ 自身浮层 | list / root | `study_progress` 的带来源标注统计 |
| **伴学状态条** | 追问深度、当前知识点、到期数 | `conversation.input.dock` | list / session | `study_progress` |
| 全屏遮罩（浮层容器） | 承载上述所有浮窗 | `shell.overlay` | list / root | — |

`replaceRisk` 提醒（来自 DSH 内嵌的 slot 目录）：
`conversation.input.left/right`、`sidebar.right.pane.tab*` 的 `replaceRisk` 是
`shadows-shipped-ui` —— 也就是**同 priority 注册会遮蔽内置 UI**。所以：
- 入口按钮用 `priority: 0`、`order` 排在末尾，避免盖掉内置的附件/模型按钮；
- 右栏 tab 用 `keyed` 的 `key: 'study'`，天然不冲突（keyed 按 key 分派）；
- 需要"完全不干扰"时用 `shell.overlay`（我自己的浮层，不与任何内置 UI 争位）。

## 三、数据怎么流（关键取舍）

DSH 的客户端插件与宿主插件之间没有隐式通道：客户端要调宿主**必须**走 typert RPC
（host 加 `@Remote` + `exports["./typert"]`；client 加 `exports["./remote"]` + `ctx.remote.$mount`）。
那是一条真实但**未验证**的路（本机无法打包、无法跑）。

因此这里采用**两条腿**：

1. **MVP：起草消息（零 RPC）**。"加入教材"表单收集路径后，把一句话写进输入框
   ——`请把 <路径> 导入当教材`——由模型调用 `study_import_textbook`。
   这与原系统的 `requestLearnComposerDraft` 同构，**今天就能工作**，代价是多一跳模型。
2. **增强：typert RPC（后续）**。客户端直接调宿主 `study.importTextbook(path)`，
   不经过模型；带回执（结构摘要、节点数）直接渲染。需要按上面两条 `exports` 补齐并打包。

"学习记录"同理：MVP 用 `/study` 命令的文本输出 + 会话事件渲染；
增强走 RPC 拉结构化统计。

## 四、悬浮窗"保留"的具体设计

原系统的浮窗体验（可拖拽、可折叠、位置记忆、九类窗口）在 DSH 里的等价做法是**面板内自管浮层**：

```
StudyFloatingLayer（注册在 shell.overlay）
├─ 状态：{ [windowId]: { x, y, w, h, collapsed, z } }
├─ 持久化：localStorage（与 DSH 的 UI 侧 KV 分开，命名 `dsh.study.float.v1`）
├─ 拖拽：pointerdown/pointermove/pointerup + setPointerCapture
├─ 边界：clamp 到视口，窄宽度下改用纵向堆叠（对应原系统的 dock lane）
├─ 层级：单调整数 z，点击置顶；不做多档 z-index 令牌（避免与宿主 1300+ 的 modal/toast 争）
└─ 降级：视口 < 900px 时不再浮层，改为一个 tab 内的分节列表
```

这样做的理由（来自原系统的教训）：
- 原系统把浮窗坐标写进 localStorage 却把**布局真相源**放在组件里，重建就丢（宫殿坐标那次）；
  这里坐标由 `StudyFloatingLayer` 单一持有，窗口只读。
- 原系统有 `dock-lane` 在窄屏的贴边堆叠，但**测试只是静态断言**；这里把"窄屏改纵向堆叠"写进
  同一份状态的纯函数（`layoutFor(viewport, windows)`），可以单测，不必靠组件挂载。
- 原系统的浮窗层与宿主 modal/toast 争 z-index；这里**只在自己的 overlay 内部排序**，
  不碰宿主的层级体系。

## 五、还缺什么才能真的看见窗口

| 缺什么 | 说明 | 现状 |
|---|---|---|
| `lib/client.js` | 必须是 `window.__ModuleLoader__.load({id, factory})` 的 IIFE | ✅ **已解决**：`scripts/build.mjs` 按两个真实第三方产物的逐字契约产出，不需要打包器 |
| 模块契约 | factory 要返回 `{name, inject, apply}`，`apply` 要注册字典并注入 slot | ✅ **已验**：`npm run check:build` 在假 `window.__ModuleLoader__` 下求值并真调一次 `apply` |
| 真实浏览器渲染 | slot 元数据是否被宿主接受、面板长什么样、长文本在窄栏是否变形 | ❌ **未验**：需要一次真实的 GUI 装载 |
| 样式 | CSS Modules 会被编译成"CSS 字符串 + 哈希类名表"，在 factory 求值时插 `<style data-plugin>` | ⚠️ 当前面板不引 CSS；要做样式得自己产出那段字符串 |
| typert RPC（增强路线） | host `exports["./typert"]` + client `exports["./remote"]` + `$mount` | ❌ 生成器 `@deepseek-ai/dsh-typert-generator` 不在宿主安装里；MVP 路线（写进 composer 草稿）不需要它 |

**因此：设计可以直接照着写代码，模块层也已验证；剩下的是一节真实 GUI 的装载确认。**
在那之前，"加入教材"最实际的入口是**对话**：把材料路径发给它，或直接说
"把这份材料导入当教材"。
