# dsh-study-alongwith-AI

把 **Reasonix 伴学系统**的教学框架与域逻辑，迁移为 **DeepSeek Harness（DSH）的 cordis 插件生态**。
迁移不是搬运代码，而是**把原系统已被证实的缺陷在新架构里结构性消掉**——每一条修法都在下面有对应的 `file:line` 出处与回归测试。

```
dsh-study-alongwith-AI/
├─ package.json          ★ 可发布 bundle 清单：dsh.bundle.patch / dsh.client / exports / files
├─ cordis.patch.yml      ★ bundle 补丁层：插入插件行 + 发布伴学模式 preset 根
├─ presets/study/        伴学模式（agent preset）：教学人格 + 收窄的工具面 + skills/
├─ lib/                  构建产物（gitignore）：宿主半边 + 客户端半边
├─ packages/             源码（不单独发布）
│  ├─ core/              零依赖纯 TS 域逻辑（有测试，node --test 直接跑）
│  ├─ ingest/            多格式摄取：md / txt / html / pdf / docx / odt / epub / 图片
│  ├─ plugin-host/       宿主半边源码：工具 + 系统提示节 + 命令 + 存储域
│  └─ plugin-ui/         客户端半边源码（构建前形态）：伴学面板（经 slot 注册）
├─ scripts/              build / verify-build / verify-install / selfcheck / check-encoding / dev-link
└─ docs/
```

> 本包**本身就是 DSH bundle**：`package.json` 里声明了 `dsh.bundle.patch`，
> 所以它可以被 `dsh plugin add` 装进任意 profile，与 `dshmarket`、`dsh-better-sidebar`
> 这些第三方 bundle 同构。安装与验证见下文。

## 为什么是 cordis 插件，而不是继续改原仓库

DSH 本身就是一棵 cordis 插件树：`@deepseek-ai/cordis@4.0.2` 是底座，
两百多个 `@deepseek-ai/dsh-*` 包（tools / systemPrompt / sessions / skills / commands /
storage / settings / subagents …）全是插件。把伴学做进来意味着：

- **教学协议有正规投递渠道**（system prompt 节 / 技能 / 命令），不必再劫持用户文本；
- **UI 只能通过 slot 注册**，宿主负责实例化，从结构上排除"组件没挂载但测试通过"；
- **持久化有 domain 层**（先落盘、再改内存、最后广播），不必自己写整库单文件 JSON；
- **订阅/事件由 fiber 托管**，插件卸载自动清理，不会留下"事件有人发没人收"。

## 已修复的原系统缺陷 → 新架构修法

每一条都是我在原仓库里**核对过代码**的（出处为原仓库路径），并附新架构的落点与测试。

| # | 原系统缺陷（证据） | 新架构修法 | 落点 |
|---|---|---|---|
| 1 | **教学协议被内核改写**。`/learn ` 前缀使 `submit()`（`internal/control/controller.go:1093`）走 slash 分支，`%APPDATA%\reasonix\commands\learn.md` 命中 `CustomCommand` 后用 `Command.Render()` 把整段注入当 `$ARGUMENTS` 空格拼接替换，`[SOCRATIC_STRATEGY]` 等块结构全丢 | 协议改走 **system prompt 稳定节**（DSH 在渲染文本未变时不写事件，前缀 cache 自然保持），易变状态走 `context()`；用户输入不再被污染 | `plugin-host/src/prompt.ts`、`skills/study-companion/SKILL.md` |
| 2 | **bloomLevel 整体失效**：节点级 Go 侧从未赋值；证据级前端写入字面转义串 `"\\u8bb0\\u5fc6"`（`learning.masteryEvaluator.ts:230/233/236` 漏了解码器） | `BloomLevel` 是**封闭联合类型**；值（ASCII）与标签（中文）分离；`normalizeBloomLevel()` 兼容历史脏数据；`nodeBloomLevel()` 从证据聚合节点层级 | `core/src/types.ts`、`core/src/knowledge/graph.ts`；测试 `tests/bloom.test.ts` |
| 3 | **改稿即失忆**。教材 ID = `sha256(title+body)`（`learning_textbooks.go:146`），改一个字再导入就是一本新教材并 **append**（`:798`）；学习状态全挂在教材 id 派生的节点 id 上 | 拆成 **身份 key**（由来源引用决定，改正文不变）+ **版本 revision**（内容哈希）；`planTextbookImport()` 返回 create/revise/unchanged，修订**承诺保留学习状态** | `core/src/textbook/identity.ts`；测试 `tests/identity.test.ts` |
| 4 | **图谱重建摧毁用户状态**。`LearningRebuildKnowledgeGraphFromTextbooks` 从 `emptyLearningKnowledgeGraph()` 重建（`learning_knowledge_graph.go:975`），证据 / 掌握度 / 手工语义边 / 宫殿坐标全丢——而任务书 F.2 明确要求"先确认全量重建不清空手工摆位" | `rebuildStructure()` 只重建结构节点与 contains/prerequisite 边，**证据与手工边按 key 原样带过**；掌握度因是证据纯函数而自动保留 | `core/src/knowledge/graph.ts`、`plugin-host/src/tools.ts`（`study_rebuild_structure`） |
| 5 | **mastery 双路径不对称**。写入路径对 `flashcard/code-lab/note/blackboard` 不校验 `correct`/`result` 即计正向（`:388-393`），重放路径用严格 `isPositiveEvidence`（`:313-327`）→ 同一组证据两个结论 | 掌握度定义为**证据集合的纯函数** `masteryFromEvidence()`；增量推导与重放推导是同一个函数，**按构造相等**；正向判定只有一处 | `core/src/knowledge/mastery.ts`；测试 `tests/mastery.test.ts`（含 200 轮随机序列的增量=整体一致性断言） |
| 6 | **口诀卡不可复习**。`learning.mnemonicAssets.ts:21` 产出 `options: []`，而三处闸门都要求 `options.length > 0`（`flashcardWindow.ts:52`、`LearningFlashcardFloatingWindow.tsx:62`、`assetsBridge.ts:394`） | 卡片是**判别联合**（choice / cloze / short-answer / mnemonic）；`isPracticable()` 四种都返回 true，判定方式由类型决定（选择题自动、其余自评） | `core/src/review/cards.ts`；测试 `tests/cards.test.ts` |
| 7 | **复习失败不降级**。Go 侧 `srsResult` 只存不读（`learning_knowledge_graph.go:82,732` 之外无引用），"遗忘是系统状态"实际依赖前端另传 `mastery` | `srsMasterySignal()` 在 core 显式定义；`study_submit_review` 一次写入同源的 SRS 排期 + 复习证据 + 降级信号 | `core/src/review/srs.ts`、`plugin-host/src/tools.ts` |
| 8 | **成长数字与证据脱节**。图谱关系按 `index % 5` 轮流赋语义（`growthModel.ts:314-320`）、"连续追问"成就门槛是 `userTurns >= 5`（`:352`）、教师记忆首条是常量（`:448`），却渲染成"基于 M 条真实证据" | 每个指标都是 `Metric<T>`，`source` 必填（evidence / derived / **heuristic**）；启发式指标**必须**给 note，否则构造时抛错；`renderStats()` 强制标注来源 | `core/src/growth/stats.ts` |
| 9 | **组件未挂载但验收通过**。`LearningWorkspace.tsx` 无 importer，连带 Header / Toolbar / FocusHud / ClassroomPanel / StudioPanel / AssetsPanel 不可达 → 节奏条与证据点亮脉冲"有发射无接收" | UI 只能经 cordis **slot 注册表**挂载（`ctx.slots.inject(slot, register)`），宿主负责实例化 | `plugin-ui/src/client/index.ts` |
| 10 | **复盘事件静默丢失**。`requestLearningReplay` 只有数据中心一个订阅者，而数据中心是条件渲染的 | 事件走 cordis `ctx.on/ctx.emit`，订阅由 fiber 托管，不依赖某个组件是否挂载 | 设计约束（见 `core/src/knowledge/graph.ts` 顶部说明） |

## 关于"迁移"的范围与边界

**已实测**：`packages/core`（域逻辑）与 `packages/ingest`（多格式解析）的全部行为有
`node --test` 覆盖（core 64 + ingest 62），零依赖、离线可跑。
解析器测试是**真解析真字节**：在测试里现场构造最小 PDF（含 FlateDecode 与未压缩两种内容流）、
手写 PNG 头、内存 zip（stored/deflate 两种条目），断言取出的文本与尺寸；扫描件必须**如实失败**
并说明"这是图片型 PDF"，而不是返回空字符串冒充成功。

**已验到"装进真实 DSH 会怎样"这一层**：本包作为 bundle 被真实 DSH 的 profile 装载器
解析成一层、两处补丁都落进组合树 —— 这是 `scripts/verify-install.mjs` 每次 `npm run check`
都会重跑的证据，不是声明（详见下文"四道门"）。

**仍未验证**：客户端半边在**真实浏览器**里的渲染；以及存储域生命周期修复后的**实机复挂载**
（见"已知的不可验证边界"）。这两条我如实标注，不当作已完成。

## 测试与自检

六道门，全部离线、零依赖（Node 原生 TS 类型剥离 + `node:test`）：

```powershell
cd H:\winmove\project\AI\reasonix-learn-AI-idea\dsh-study-alongwith-AI
npm run check              # = 编码 + 结构 + 构建 + 产物 + 安装形态 + preset 形态 + 全量测试
```

| 门 | 命令 | 查什么 |
|---|---|---|
| 编码体检 | `npm run check:encoding` | BOM / U+FFFD / GBK 误解码指纹 / 私用区字符。**起因**：本项目作者曾用 PowerShell 的 `Get-Content`+`Set-Content` 改写文件，在中文 Windows 上把 UTF-8 当 GBK 读回，造成不可逆损坏（非 GBK 字符被吞）。这类损坏肉眼只是"乱码"，但会让模型读到错误提示词，必须机器检查 |
| 结构自检 | `npm run check:structure` | ① 相对导入是否都真实存在（层级写错在编辑器里看不出来）；② 冒烟导入每个模块，暴露 Node 类型剥离**不支持**的语法（`enum`、带运行时代码的 `namespace`、参数属性、装饰器）；③ **接线自检**：值导出若既没被 barrel 再导出、也没被其它文件引用，即报"未接线"——这正是原系统最贵的病（`LearningWorkspace` 整棵树没 importer、`recordMetacognitionReflection()` 只有定义、`_llmScorer` 从未被调用） |
| 产物验证 | `npm run check:build` | `lib/` 里**每个**模块能否被原生 Node `import`。专抓"只作类型用的导入没写 `import type`"——剥离类型会保留 `import { SomeType }`，运行时要一个不存在的具名导出就 SyntaxError，**构建期完全看不见**。另外在假 `window.__ModuleLoader__` 里求值 `lib/client.js`，断言工厂返回 `{name, inject, apply}` 并真的调用一次 `apply` 看它注册了什么 |
| 安装形态验证 | `npm run check:install` | 在**临时 `DSH_HOME`** 里真的装一遍：让真实 DSH 的装载器解析本包 → 读 `dsh.bundle.patch` → 应用补丁 → `dsh --dump-config` 检查组合树。另外把 `roots` 的 `!!js` 表达式按 loader 的**逐字求值方式**跑一遍，断言它解析到本包 `presets/` 目录，并断言 `baseUrl` 缺失时优雅退化成空 roots。找不到 DSH 时**跳过并说明**，不假装通过 |
| preset 形态验证 | `npm run check:preset` | 用 **DSH 自己的解析方言**（从安装里取 `entryListSchema`）读 `presets/study/agent.cordis.yml`，检查：顶层数组、每行有 `name`、行 id 不重复、每个包名都能在安装里解析到、persona 里的教学协议不是空壳、工具面确实收窄（不含 shell / 子代理 / 工作流 / plan-mode）、技能文件在位。这一门是补的，理由见下 |
| 全量测试 | `npm test` | `packages/*/tests/*.test.ts` |
| 孤立包自检 | （内含在 `check:structure`） | 某个 `packages/*` 写完了却**没有任何包引用它**。这一门是补的：本项目真发生过一次——`ingest` 62 项测试全绿，但没接到宿主插件上，"多格式摄取"等于不存在。前一道门抓不到它，因为该包的 `index.ts` 是 barrel，被判成"已对外公开"就放过了 |

> **为什么要有 preset 形态验证**：preset 组合文件是**唯一不被其它闸门覆盖的交付物** ——
> 它不是 TypeScript（构建与产物验证看不见它），也不是插件代码（测试碰不到它）。
> 而它写错的后果是用户在模式选择器里看到一个"损坏"条目。
> 本项目差点就这么交付了：`skill-filesystem` 行上曾写着 `customSkillDirs: [- !!js ...]`，
> 依赖 `baseUrl` 在组合文件行的作用域里可用 —— 没有任何先例支持这一点，
> 一旦求值抛错，整行加载失败会把伴学模式一起带走。现在这一门会把这类问题拦下来。

当前状态（本仓库自检口径）：

```
编码体检    通过（无 BOM / 无替换字符 / 无乱码指纹；扫描 82 个文件）
结构自检    源码模块 32   相对导入通过   冒烟 32 通过 / 0 抛错   未接线值导出 0   孤立包 0
构建        30 个服务端模块 + 1 个客户端半边
产物验证    30 个服务端模块可 import，宿主入口与客户端半边形状正确
安装形态    真实 DSH 解析成一层 bundle，两处补丁都落进组合树；preset 根含 study + socratic；卸载→重装幂等
preset 形态 2 个模式（study / socratic），组合文件用 loader 方言可解析
全量测试    248 通过 / 0 失败
```

> 上表是**实测输出**，随每批改动重跑并更新；它同时也是"六道门"的门禁口径。
> `npm run check` 一次跑完这六道门。

> `npm run typecheck` 需要 `typescript`，但它不在本仓库依赖里（宿主安装中也没有）。
> 这不是遗漏：插件的宿主半边依赖 `@deepseek-ai/*`，其 `.d.ts` **未随包发布**
> （所有包都声明了 `types` 字段，但磁盘上只有 `lib/index.js`），
> 所以离线环境里 `tsc` 无法解析这些类型。类型层面的验证请在 DSH 的 monorepo 内做。

### 已知的不可验证边界

| 层次 | 状态 |
|---|---|
| 模块加载 | ✅ 已验：`scripts/dev-link.ps1` 建好 peer junction 后，自检的冒烟导入对**真实的 DSH 依赖**求值成功（32/32），包括 `storage.ts` 里真正执行 `defineDomain()` 的启动期校验 |
| 构建产物加载 | ✅ 已验：`lib/` 全部 30 个服务端模块可被原生 `import`，宿主入口导出形状正确（含"不得有 `export default`"这条） |
| `apply()` 注册 | ✅ 已验：`plugin-host/tests/plugin.test.ts` 用假 ctx 真跑 `apply()`，断言注册了 **11 个工具**、系统提示的 section 与 context 各一节、`/study` 与 `/socratic` 两条命令，并断言无 `storage.domain` 时明确报出降级为内存 |
| 工具执行链 | ✅ 已验：同一测试真跑「导入 → 进度 → 证据 → 建卡 → 复习 → 修订 → 收束」，断言每一步都落到存储（教材记录、节点/边、掌握度、SRS 排期、课堂记录、证据保留） |
| 多格式导入 | ✅ 已验（宿主侧）：`plugin-host/tests/formats.test.ts` 用真实临时文件跑七种格式（md / txt / html / 文本层 pdf / docx / odt / epub），并从存储读回；五条失败路径（图片 / pptx / 扫描件 / 路径不存在 / 空正文）各自如实说明 |
| **升级不丢数据** | ✅ 已验：`plugin-host/tests/upgrade.test.ts` 用**真实 `JsonStorageBackend`** 读写真文件 —— v2 域声明 `compatibleVersions: [1]` 时 v1 记录照常读入；**并反证**漏写这一行时旧记录会静默消失 |
| **作为 bundle 被真实 DSH 装载** | ✅ 已验：`scripts/verify-install.mjs` 在临时 `DSH_HOME` 里装一遍，真实装载器把本包解析成一层，并输出 `# == @deepseek-ai/dsh-web-app, patched by dsh-study-alongwith-ai`；同时断言 preset 根里 **study + socratic 两个模式都在**、**卸载后不留残骸**、**重装幂等** |
| `plugin-ui` 客户端半边 | ⚠️ **模块契约已验，浏览器渲染未验**：`lib/client.js` 已产出，并在假 `window.__ModuleLoader__` 下求值通过（工厂返回 `{name, inject, apply}`；调用 `apply` 确实注册了中英字典、注入了 `settings.section` slot、两本字典键数一致）。但在真实 Web GUI 里长什么样、slot 元数据是否被接受，**没有跑过** |
| 在运行中的 DSH 里挂载 | ⚠️ 使用者已实机尝试：**挂载成功**，并因此暴露出下面那条存储域生命周期的致命 bug（已修）。修复后**尚未**再次实机复验 |
| **从 Public Git URL 安装** | ✅ **实测通过（两步，见上方「从 GitHub 安装」）**：仓库根即本包（`TheShinning/dsh-ai-learn`，含 `lib/` 产物）。克隆后用真实装载器跑 `verify-build` / `verify-preset` 全绿。**唯一门槛**是 pnpm v10 对 git 依赖构建脚本的批准（放行条目须带提交哈希），因此每次升级要更新那一行 |

**曾经的一个未验证假设，现在有答案了**：宿主 loader 能不能直接 `import()` 一个 `.ts` 入口？
——**能**。使用者用路径 A（patch 里写 `.ts` 绝对路径）实机挂载成功，插件真的跑起来了
（并撞上存储域那个 bug，说明代码执行到了 `apply()` 之后）。所以桌面版自带的 Node 支持类型剥离。
不过**发布形态仍然产出 `.js`**：依赖宿主的 Node 版本属于把可移植性押在别人身上，而构建只要
一次 `stripTypeScriptTypes`，代价远低于这个风险。

**这条测试还抓出过一个真实 API 违规**（值得所有写 DSH 工具的人知道）：
`dsh-tools` 的 schema 编译器**拒绝 `required: false`** —— 该键一旦出现就必须是字面量 `true`；
可选参数的正确写法是**不写** `required`。本文档作者最初按常见 JSON Schema 习惯写了 `required: false`，
模块加载能过、类型检查能过，**只有真正调用 `defineTool()` 时才抛**
`UNSUPPORTED_SCHEMA: parameters.x.required must be true when present`。

**第二个真机发现（由使用者在实机上跑出来的）**：插件的存储域生命周期原本是错的 ——
`apply()` 里 `storage.domain.open()` 打开后**从不关闭**，而且用 `void promise.then(...)` 吞掉了 rejection。
DSH profile 是 `patchReload: live`：保存 `cordis.patch.yml` 会先卸载插件再挂载一次，
于是新 fiber 二次 open 同一个域 → 抛「已打开」→ 未处理的 rejection →
**`dsh: fatal load failure` → 宿主退出 1**。修法是把 open/close 放进同一个 `ctx.effect`
（卸载时反向执行，先 close），并让任何失败都降级为内存存储 + 记日志，绝不抛出 ——
一个教学插件没有资格让整个 DSH 起不来。`plugin-host/tests/plugin.test.ts` 里已加对应回归断言
（挂载 open 一次 / 卸载 close 一次 / open 失败不抛且记降级日志）。

## 安装（桌面版 DSH）

DSH_HOME（桌面版）= `%APPDATA%\dsh-desktop\harness`，profile 目录 = `%DSH_HOME%\profiles\web`。

### 先说清 bundle 契约（以下都取证自 DSH 自己的编译产物）

**什么算一个 bundle**：`package.json` 里声明了 `dsh.bundle.patch` 的 npm 包。
`dsh-app-boot` 读的就是这个字段，缺了会**报错**而不是静默降级：
`profile bundle "X" declares no dsh.bundle in its package.json`。

**层栈怎么拼**（`loadProfileDirectory` 的契约，逐字）：

```
[每个 bundle 的补丁，按 dsh.profile.bundles 顺序] → profile 自己的 cordis.patch.yml → home patch → --patch 叠加
```

所以 **bundle 补丁在最底层，用户的 profile 补丁可以覆盖本包的任何默认值** ——
这正是"默认 `protocol: false`，想开自己开"能成立的机制。

**补丁怎么写**（`cordis-plugin-include:applyEntryPatches` 原文）：

- 按 `entry.id` 命中；
- 命中后 `target[key] = value` —— **顶层整体替换，不是深合并**。给一行补字段必须把它的
  `config` 写全（本包对 `agent-presets` 就是这么做的）；
- `name` 是**断言**而非匹配键：写了却不一致就 warn + 跳过（本包用它做保险）；
- 命中不到只 warn，不报错；补丁文件必须是**顶层数组**，否则 `config file must be a top-level array`。

**解析锚点有两个**：先在 dsh 安装里找，再在 profile 目录的 `node_modules` 里找。

### 路径 A：作为 bundle 安装（推荐）

```powershell
dsh plugin --profile web add dsh-study-alongwith-ai
```

`dsh plugin` 会把参数转发给 profile 目录里的 pnpm，并按**安装后状态**调和
`dsh.profile.bundles`：声明了 `dsh.bundle` 的依赖才进层栈，否则只装成普通依赖并告警。
装完重启 DSH（或等 `patchReload: live` 生效）。

本机已有三个第三方 bundle 是这么装的，可以直接对照：
`profiles\web\package.json` 的 `dsh.profile.bundles` 里躺着 `dshmarket`、`dsh-better-sidebar`、
`@linxin666/dsh-client-ui-skill-explorer`。

**这条路径每次 `npm run check` 都会被验证一遍**（`scripts/verify-install.mjs` 在临时 `DSH_HOME`
里复现同样的落盘状态，再让真实装载器去解析）。验证通过时它给出的证据长这样：

```
# == @deepseek-ai/dsh-web-app, patched by dsh-study-alongwith-ai
- id: agent-presets
  config:
    roots: !!js >-
      (() => { try { const p = decodeURIComponent(new URL(
      'node_modules/dsh-study-alongwith-ai/presets/', baseUrl).pathname); …
# == dsh-study-alongwith-ai
- id: study-alongwith-ai
  name: dsh-study-alongwith-ai
```

### 路径 B：开发模式（免安装，改代码即热重载）

只在**开发本仓库**、想改了源码立刻生效时用。**它和路径 A 不能同时开**（见下面的警告）。

```powershell
cd H:\winmove\project\AI\reasonix-learn-AI-idea\dsh-study-alongwith-AI
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-link.ps1          # 建 junction 并打印要粘贴的 YAML
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-link.ps1 -Write   # 顺带写入 profile 的 cordis.patch.yml（仅当它为空）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-link.ps1 -Remove  # 撤销
```

原理：插件的 peer 依赖装在 DSH 的 profile 里，而 Node 是按**导入文件所在目录**向上找
`node_modules` 的；仓库在别处，所以要在仓库里放一个指向 profile 的 junction
（本机专有，已在 `.gitignore` 里排除）。

它插入的行是本地 `.ts` 绝对路径：

```yaml
- insert:
    - id: dsh-study-alongwith-ai
      name: 'H:/…/dsh-study-alongwith-AI/packages/plugin-host/src/index.ts'
```

机制（已取证 + 已实机验证）：`dsh-app-boot` 的 `anchorInsertedPluginNames()` 会把 insert 条目里
以绝对路径 / `./` / `../` 开头的 `name` 转成 `file://` URL，相对路径以该 patch 文件所在目录为基准。
web profile 是 `patchReload: 'live'`，所以改源码即热重载。

> ⚠️ **两条路径同时开会挂载两次**。两者的 `id` 相同，于是插件被挂载两次、存储域被 open 两次 ——
> 这正是本项目已经踩过一次的坑。`dev-link.ps1` 现在会先读 profile 清单里的
> `dsh.profile.bundles`，发现本包已在层栈里就**拒绝**写 dev 补丁（除非显式 `-Force`）。

### 停用的两种含义（别混）

- **不卸载、只让某行不挂载**：在 profile 的 `cordis.patch.yml` 写 `- id: <行 id>` + `disabled: true`
  （补丁 last write wins，且它在本包补丁之后应用）
- **整个 bundle 卸掉**：`dsh plugin --profile web remove dsh-study-alongwith-ai`，
  它同时从 `dsh.profile.bundles` 层栈里退出 —— 插件行与 preset 根一起消失，不留残骸

**不要**直接改 profile 的 `cordis.yml` —— 它是空数组，插件树由"各 bundle 的 patch → 该 profile 的
cordis.patch.yml → `--patch`"逐层叠加而成。

> 桌面版另有一层 generation 覆盖机制（`profiles\.generations\` 与
> `dsh.desktop.generationProjection`，从本机现有安装可见）。本次重构**没有**取证这一层，
> 因此这里不写它的行为；用 `dsh plugin` 走正规路径即可，不必手工碰它。

### 伴学模式（agent preset）—— 随 bundle 一起装

「标准模式 / PTC 模式 / 极简模式 / 创造模式」都是 **agent preset**（`order` 分别是 1/2/3/4）。
伴学模式是第五个：

```
presets/study/
├─ preset.yml          name: 伴学模式 / description / order: 5
├─ agent.cordis.yml    该模式的组合：教学人格 + 读材料工具 + 技能目录 + 压缩 + 提问
└─ skills/study-companion/SKILL.md   随 preset 发布的技能
```

**走路径 A（bundle）时不需要任何额外操作**。bundle 补丁会把 `presets/` 发布成一个
**system 信任级的 preset 根**：

```yaml
- id: agent-presets
  config:
    roots: !!js "…new URL('node_modules/dsh-study-alongwith-ai/presets/', baseUrl)…"
```

为什么是补丁 `roots` 而不是往用户目录塞一份副本 —— `dsh-agent-presets` 的 Config 是
`{ default(必填), roots: [{path, trust}], includeShippedRoot, includeUserRoot }`，
`roots` 是官方预留的**部署级附加根**，夹在 shipped(system) 与 `~/.dsh/.agent-presets`(user) 之间，
同 id 先到先得。bundle 本身就是一层部署，用 `trust: system` 表达"随包发布的、只读的"，
比在用户根放副本更准确 —— 后者会被模式面板的删除动作当成用户自撰的 preset 删掉。

`path` 必须是绝对路径（内部是 `resolve(expandHomePath(path))`，相对路径会落到 `process.cwd()`），
而 bundle 的安装位置不固定，所以用了 loader 的 `!!js` 表达式：

- `!!js` 由 `new Function("ctx","expr","with (ctx) { return eval(expr) }")` 求值，作用域是 loader ctx，
  因此 `baseUrl`（= profile 目录的 file URL）可用；`process` 是全局，也可用
  （官方 shipped preset 就在用 `process.platform === 'win32'`）。
- 表达式**永不抛错**：任何异常退化成 `roots: []`，也就是"没有伴学模式"，
  而不是让整行 `agent-presets` 加载失败、把标准模式一起带走。
  这两条路径都在 `verify-install.mjs` 里有断言。

**已知权衡**：补丁是整体替换，而 `default` 是必填字段，所以本包必须把它写回 `standard`。
若你的部署曾把该行的 `default` 改成别的模式，装本 bundle 会把它改回来。
（用户实际选择的默认模式存在 settings 命名空间 `agent-presets` 里，不受影响。）

> 走路径 B（开发模式）时，`dev-link.ps1` 改为把 `presets/study` **junction** 到
> `<DSH_HOME>\.agent-presets\study`。两条路都开时系统根先命中，用户根那份被遮蔽 —— 不致命，
> 但没必要，脚本检测到 bundle 已装就会跳过这一步。

两条设计取舍值得说明：

- **教学协议写在 preset 的 persona 里**（静态文本），而宿主级插件挂载配 `protocol: false`。
  这样伴学工具在任何模式都可用，但教学协议**只出现在伴学模式**，不会把标准模式变成半个导师。
- **工具面收窄**：伴学模式只挂 `tool-fs` / `tool-fs-search` / `tool-skill` / 压缩 / `ask_user`，
  **不挂 shell、子代理、工作流、plan-mode**。陪读会话不需要代码执行权。
  若要让伴学工具也只在本模式出现，打开 `agent.cordis.yml` 里注释掉的那两行，
  并把 bundle 补丁里的插入行注释掉（两处都开会挂载两次）。

窗口（加入教材 / 学习记录 / 悬浮窗保留）的设计见 [`docs/ui-windows.md`](docs/ui-windows.md)：
每个窗口对应哪个具名 slot、数据从哪来、以及为什么它现在只能到源码层。

### 苏格拉底教学模式（第二个 preset）

与「伴学模式」并存，共用同一份学习数据（教材、证据、卡片、复习排期是同一份），区别在教学法：

| | 伴学模式（`presets/study`，order 5） | 苏格拉底教学模式（`presets/socratic`，order 6） |
|---|---|---|
| 锚点 | **材料**：以教材为锚点推进 | **学生的表达**：以他说出来的东西推进 |
| 默认动作 | 讲解 + 追问 | 提问；**讲不讲答案由证据决定** |
| 每轮依据 | `study_progress` 给路线 | `study_steps` 给环节与动作（`may_reveal_answer` / `must_retell` / `question_budget`） |
| 按材料换教法 | 协议里的通用原则 | 每轮注入该材料类型的**追问重点**与**降阶阶梯** |

六环节：定向 → 追问 → 降阶 → 直讲与复述 → 测试 → 收束与复习。
四条**跨模式底线**（两种模式都不变，且由 `study_steps` 强制）：

1. 一次只问一个问题；2. 先问后讲（深度 3 或连续两次困惑才允许直讲）；
3. 直讲之后必须先复述，复述不通过不推进（且**追问深度不归零**）；4. 点亮需要 ≥2 种不同正向证据，学生说「懂了」不算证据。

**按材料类型换教法**（分类结果写进教材记录的 `sourceFormat` 复合值，零 migration）：

| 材料 | 教学模式 | 追问重点 | 卡片偏好 |
|---|---|---|---|
| 规章条例 | 条文驱动 | 适用条件 → 例外情形 → 后果 | 填空 + 口诀 |
| 大学教材 / 讲义 | 概念驱动 | 解决什么问题 → 最易混哪个 → 换场景还成立吗 | 简答 + 辨析选择 |
| 真题 / 刷题 | 刷题驱动 | **先自答** → 判对错 → 归因（概念/记忆/迁移/审题） | 选择 + 填空 |
| 文章 | 论证驱动 | 主张 → 证据支持到哪一步 → 哪里最弱 | 简答 |
| 答案解析 | 解析复盘 | 反推出题人想考什么 → 换个数还成立吗 | 选择 + 简答 |

判不准（置信度 `weak` / `unknown`）时**不猜**：导入报告会要求先问用户一句，答一句即可改判
（重新导入时传 `material_type`）。

### 课堂记录（学了什么 / 还不完善的点）

收束时 `study_wrap_up` 生成一份**快照**（生成后再产生的证据不会改写它）：

```markdown
# 课堂记录 · 实践论
- 时间：… → …　- 教材：book:pasted-text-xxxx　- 材料类型：textbook｜教学模式：concept-driven
- 概览：本节围绕 2 个知识点，记录 5 条证据；学生作答 3 次；复述 1 次（通过 1 次）；复习 1 张卡。

## 课堂过程
- 2026-09-26T10:00:00.000Z｜diagnose｜ask
## 涉及的知识点
- 第一节 认识与实践｜掌握度 confused｜证据 3 条（kgev-…, kgev-…, kgev-…）
## 还不完善的点
- **概念混淆未澄清**（证据）「第一节 认识与实践」：出现过答错或困惑，至今未点亮。
  - 下一步：下一节课从这里开始，且**追问深度不归零**：先给例子或二选一，不要重新从定义问起。
## 复习
- 本节提交复习 1 张：again 0｜hard 0｜good 1
```

四类缺口各自带**来源**（证据 / 材料 / 系统）与**可执行下一步**：
`confused-node`（混淆未澄清）、`unanswered`（问了没答上）、`material-defect`（材料本身残缺，如扫描件）、
`system-gap`（已点亮却没建卡 —— 没有排期就一定会忘）。

记录同时落库（domain 的 `sessions` 表）并写入工作区 `.study/records/<日期>-<标题>.md`。
**写入失败时报告里会明说 `未能写入工作区`**，不会谎报"已保存"。

### 十一个伴学工具

`study_import_textbook`（多格式导入 + 材料分类）、`study_record_evidence`、`study_retract_evidence`、
`study_progress`（路线 + 进度 + 最近一次课堂摘要）、`study_review_queue`、`study_submit_review`、
`study_create_card`、`study_rebuild_structure`、**`study_steps`**（苏格拉底环节编排）、
**`study_formats`**（本机格式能力，含缺什么依赖）、**`study_wrap_up`**（课堂记录）。

斜杠命令：`/study`（进度）、`/socratic`（环节与材料形态）。

### 安装与升级（三条路径）

| 路径 | 何时用 | 命令 | 验证状态 |
|---|---|---|---|
| **A. bundle 安装（本地路径）** | 本机/局域网 | `dsh plugin --profile web add <本包绝对路径>` | ✅ `npm run check:install` 在临时 `DSH_HOME` 里用**真实装载器**验证（含卸载→重装幂等） |
| **B. 开发模式** | 改本仓库源码 | `scripts\dev-link.ps1`（建 junction，`patchReload: live` 热重载） | ⚠️ 本机可用；脚本的 preset 链接块在 PowerShell 5.1 下有已知问题（见 `findings.md`），脚本内已拦截并打印手工命令 |
| **C. Git 仓库（已发布，推荐）** | 从 GitHub 装/升级 | 见下方两步 | ✅ **实测通过**：仓库根即本包（`TheShinning/dsh-ai-learn`，含 `lib/` 产物）；用真实装载器对克隆下来的包跑 `verify-build` 与 `verify-preset` 全绿 |
| **D. Git 仓库子目录** | —— | `<git-url>&path:<子目录>` | ❌ **实测失败**：`&path:` 不被 pnpm 识别，装下来的是仓库根。详见 [`docs/publishing.md`](docs/publishing.md) §二 |
| — | 直接用逻辑 | 只用 `packages/core`（零依赖纯函数）+ `packages/ingest` | ✅ 各自有测试，`node --test` 直接跑 |

#### 从 GitHub 安装（两步）

```powershell
# ① 先装一次 —— 它会失败，但会打印出你要粘贴的确切规格（含提交哈希）
dsh plugin --profile web add git+ssh://git@github.com/TheShinning/dsh-ai-learn.git

# ② 把错误信息里给出的那一条加进 profile 的 pnpm-workspace.yaml
#    %APPDATA%\dsh-desktop\harness\profiles\web\pnpm-workspace.yaml
onlyBuiltDependencies:
  - "dsh-study-alongwith-ai@git+ssh://git@github.com:TheShinning/dsh-ai-learn.git#<错误信息里的 sha>"

# ③ 再装一次
dsh plugin --profile web add git+ssh://git@github.com:TheShinning/dsh-ai-learn.git
```

为什么不能一步到位：**pnpm v10 默认禁止 git 依赖执行构建脚本**，而放行条目必须是
**带提交哈希的完整规格**（只写包名不行、`@*` 通配被拒、不带 sha 也不行 —— 四种写法都实测过）。
代价是**每次升级换 sha 后要更新那一行**；这是 pnpm 对所有 git 依赖的策略。
细节与备选通道（npm 发布）见 [`docs/publishing.md`](docs/publishing.md) §三。

**升级动作**：

```powershell
# bundle / git 安装
dsh plugin --profile web remove dsh-study-alongwith-ai
dsh plugin --profile web add <路径或 URL>
# 本地路径 / 开发模式：git pull 后重启 DSH（或等 live reload）；发布形态需要先 npm run build
```

**升级会不会丢学习数据**：取决于**域版本**是否变。

- 只加工具 / 加 preset / 改提示词 → **域版本不变**，数据原样继续用；
- 加表（本项目 v1 → v2 加了 `sessions`）→ 已在 `STUDY_DOMAIN` 里声明 **`compatibleVersions: [1]`**，
  旧记录照常读入；这一行是**升级不丢数据的关键** ——
  本域是 `layout: 'per-record'`，每个记录文件带版本戳，后端读取只接受"当前版本 + compatibleVersions"，
  **不在集合里的戳是"丢弃而不是迁移"，而且不报错**（`plugin-host/tests/upgrade.test.ts` 里有正反两面的回归）。

**停用的两种含义**（别混）：

- 只让某一行不挂载：profile 的 `cordis.patch.yml` 写 `- id: <行 id>` + `disabled: true`（补丁 last-write-wins）；
- 整个 bundle 卸掉：`dsh plugin --profile web remove dsh-study-alongwith-ai` —— 插件行与 preset 根一起消失，不留残骸。

## 支持的格式

**先说清一个事实**：DSH 运行时**只原生支持图片**。审计结论（取证自 `@deepseek-ai/*` 编译产物）：

- 内容块只有 `text / image / file / tool-result`；**没有** pdf/docx 之类的 part 类型
  （全树 grep `application/pdf`、`officedocument` 零命中）
- `image` 的 mediaType 是字面量联合，只有 **png / jpeg / webp / gif** 四种
- 文件块对**任何**模型都不原生发送：`projectFilesToText` 无条件把它转成一句句柄文本
  （`[File "a.pdf" (…): verbatim read-only copy saved at "…". Read that path with your file tools…]`）
- PDF 只有**前端渲染**（`dsh-client-ui-sidebar-documentpreview` 内联 pdfjs 画布），
  宿主进程**没有任何 PDF 解析器**（`pdfjs-dist` 在 node_modules 里不存在，只在浏览器 bundle 内联）；
  DOCX/XLSX/PPTX 完全没有支持

所以"多格式摄取"必须由本插件承担：

| 格式 | 原生 | 内置解析（本插件） | 外部命令回退 |
|---|---|---|---|
| 图片 png/jpg/webp/gif | ✅ 上传即被模型看到（vision，20 MiB/张、单条 20 张） | 读尺寸/mime 供 UI | — |
| Markdown / txt | ⚠️ 只得句柄，模型需按路径读（`ctx.fs` 仅 UTF-8 且拒二进制） | 直接读：BOM 剥离、CRLF 归一、编码回退 | — |
| html | ❌ | 去标签 + 实体解码 | — |
| **PDF** | ❌ | 文本层提取（zlib inflate + 内容流 `Tj/TJ` 解析） | `pdftotext -layout`；扫描件 `pdftoppm` + `tesseract -l chi_sim+eng` |
| **docx / odt / epub** | ❌ | 自写 zip 读取（stored/deflate）+ XML→Markdown | — |

**可离线直接使用的解析相关依赖**（已实测存在于 `APP\node_modules`，且 profile 内可通过
`profiles\node_modules` 的 junction 闭包用裸模块名 import）：`sharp@0.35.4`（含 win32 原生二进制与
libvips DLL）、`turndown@7.2.4`、`@joplin/turndown-plugin-gfm`、`jsdom@29.1.1`、`parse5@8.0.1`、
`jszip@3.10.2`、`image-size@1.2.1`、`iconv-lite@0.7.3`、`mime-types@3.0.2`。

**明确不可用**（实测不存在）：`pdf-parse`、`unpdf`、`pdfjs-dist`（作为包）、`mammoth`、`docx`、
`xlsx`、`officeparser`、`marked`、`remark`、`cheerio`、`html-to-text`、`adm-zip`、`yauzl` 等。
因此本仓库的 `packages/ingest` 刻意**零依赖**（自己解 zip、自己解 PDF 内容流），
以保证在任何主机上都能跑，不依赖用户装什么。

解析失败时返回**完整尝试轨迹**（哪一层、哪个解析器、失败原因）与可操作建议，
不把"能力缺失"和"文档问题"混成一句"导入失败"。

## 构建（从源码到可加载产物）

```powershell
npm run build        # packages/*/src/**/*.ts → lib/   （23 个服务端模块 + 1 个客户端半边）
npm run check:build  # 验证产物真的能加载
```

### 为什么这里没有打包器

本机（以及任何只装了 DSH 的机器）都**没有**可用的打包器 —— 已安装产物里
vite / tsdown / rollup / esbuild 一个都不在 `node_modules`。DSH 自己的第三方插件都用 tsdown，
插件作者按理要自备工具链。

但 Node 24 自带 `module.stripTypeScriptTypes`，于是构建退化成一件很窄的事：**删掉类型标注**。
`scripts/build.mjs` 只做两件必须显式做对的事：

1. **改写相对说明符 `.ts` → `.js`**。源码写的是显式 `.ts` 后缀（Node ESM 要求显式后缀），
   剥离类型不会动说明符。映射是 `packages/<pkg>/src/<rest>.ts` → `lib/<pkg>/<rest>.js`，
   跨包引用（如 `../../core/src/index.ts`）的相对深度**会变**，所以必须按"源路径 → 输出路径"
   重算，不能字符串替换。解析不到输出文件就报错退出。
2. **把客户端半边包成 ModuleLoader 工厂**（见下）。

剥离类型对**非可擦除语法**（`enum`、带运行时代码的 `namespace`、参数属性、装饰器）会抛错 ——
这正好是我们要的信号：构建失败，而不是产出坏文件。

### 客户端半边：契约取证 + 受约束子集

两个真实第三方产物（`dsh-better-sidebar/lib/client.js`、`@linxin666/dsh-client-ui-skill-explorer/lib/client.js`）
的包装**逐字一致**，本包照此产出：

```js
window.__ModuleLoader__.load({
  id: 'dsh-study-alongwith-ai',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const { createElement: h } = require('react');   // 裸说明符 → 工厂的 require
    …
    Object.assign(exports, { name, inject, apply });
    return module.exports;
  },
});
```

`scripts/build.mjs` 里的客户端变换**不是**通用 ESM→CJS 转换器，只接受一个受约束子集：
只有裸说明符导入、只有 `export const` / `export function`。出现 `export default`、相对导入、
或任何未识别形态一律**报错退出** —— 宁可构建失败，也不产出悄悄坏掉的浏览器半边。
本包的客户端源码恰好落在这个子集内（无 JSX，单一 `react` 依赖）。

`npm run check:build` 会在假 `window.__ModuleLoader__` 下真的求值这个产物、真的调一次 `apply`，
断言它注册了字典、注入了 `settings.section` slot。

### 两半的产物要求（都踩过坑）

| 半边 | 产物 | 要求 |
|---|---|---|
| 宿主 | `lib/plugin-host/index.js` | 标准 cordis ESM 插件；**必须具名导出 `name`/`inject`/`Config`/`apply`，不要 `export default`**（default 会被 `Loader.unwrapExports` 取走，注入元数据丢失）。`check:build` 里有一条断言专门盯这个 |
| 客户端 | `lib/client.js` | 上面那个形状的 IIFE；exports 里带 `apply` / `inject`（**服务名**）/ 可选 `name` |

客户端半边的其他实测约束：

- `package.json` 里 `dsh.client.inject` 写的是**包名**数组（保证对方 bundle 先到达），
  而代码里的 `inject` 写的是**cordis 服务名**（如 `slots`/`locale`/`theme`）。两套体系，不能互抄。
- 只有 8 个"种子模块"可以不声明依赖直接 `require`：`react`、`react/jsx-runtime`、`react-dom`、
  `react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、
  `@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`（另有 ui-dockkit）。
  其他任何 specifier 都必须有对应的 `dsh.client` 图行，否则抛 `missed the module table`。
- 样式：CSS Modules 在构建期被转成"一段 CSS 字符串 + 哈希类名表"，在 factory 求值时
  插 `<style data-plugin="<包名>" data-plugin-css="<包名>/<文件>">` —— 这两个属性是 HMR 清理句柄。
  本包客户端半边**不引 CSS**，所以这条还没用上。
- 颜色只用 `--dsw-alias-*` 语义令牌；深色由 `body[data-ds-dark-theme]` 自动切换，不要写死色值。

## 发布前检查清单

| 项 | 状态 |
|---|---|
| `package.json` 包名合法（小写、无大写字母） | ✅ `dsh-study-alongwith-ai`（**曾经是 `dsh-study-alongwith-AI`，大写 `AI` 不是合法 npm 包名**） |
| `private: true` 已移除 | ✅ |
| `dsh.bundle.patch` 指向真实存在的补丁文件 | ✅（`check:install` 会验证） |
| `files` 覆盖运行时所需的一切（`lib` / `presets` / 补丁） | ✅ |
| `exports` 不挡住运行时需要的子路径 | ✅（含 `./client`、`./cordis.patch.yml`、`./presets/*`） |
| 构建产物随包发布而非从源码加载 | ✅ 发布形态是 `lib/`，不依赖宿主 Node 的类型剥离 |
| `npm run check` 全绿 | ✅ |
| 真实浏览器里的客户端渲染 | ❌ 未验证（见"已知的不可验证边界"） |
