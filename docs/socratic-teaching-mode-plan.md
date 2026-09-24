# 苏格拉底教学模式（socratic-teaching）落地计划

> 定位：在 `dsh-study-alongwith-AI` 这棵已建成的 cordis 插件树上，**新增第二个 agent preset + 一层纯函数教学引擎**，
> 让 agent 能一步一步启发式引导学生、把复习插进教学回路、把进度做成可读可画的数据，并保留闪卡等知识测试。
>
**多格式输入是硬性需求**（用户明确要求），且本仓库**已经具备**这条管线（`packages/ingest`，原生 2 + 内置 6 + 外部 2 个解析器，133 项测试里 62 项是它）。
因此本计划对多格式的定位是：**复用现有摄取层，补齐"能力可见性 + 按格式换教学法 + 如实失败"三件缺口**，而不是重写解析器。

> 本文只描述**要做什么、落在哪个文件、怎么验**。所有对应关系都指向本仓库现有代码或已取证的 DSH 契约。

---

## 一、范围与不做什么

**做**：一个「苏格拉底教学模式」preset + 它需要的教学引擎（步骤机、焦点选择、复习编排、测试编排）与三个新工具。

**不做**（本计划明确排除）：

- 不改原 Reasonix 仓库（`DeepSeek-Reasonix-learn8AI/`）—— 那是旧底座，迁移已完成。
- 不做多用户 / 家长视图 / 课程分享等平台化能力。
- 不重写已有的伴学模式（`presets/study`）：它必须行为不变、测试不变绿。
- 不改客户端半边的既有 slot 注册；新增模式会自动出现在模式选择器里，不需要新 UI。

---

## 二、沿用「本项目 AI 伴学系统的思路」——逐条对应

这是本计划的核心：**不是新造一套教学法，而是把伴学系统已验证的机制换一个用法。**

| # | 伴学系统已有思路（现成资产） | 苏格拉底模式怎么用 |
|---|---|---|
| 1 | **追问深度不是模型自报，是数出来的**：`deriveProbeState()` 从同一节点、同一语气的连续 `answer-quality` 证据推导 0→3（`core/src/pedagogy/probe.ts`） | 直接作为步骤机的**输入信号**：深度 0/1 继续问，2 降阶，3 直接讲最小正确模型并要求复述。模型无权"觉得自己讲够了" |
| 2 | **降阶指令由纯函数生成**：`depthDirective()` / `toneDirective()` | 扩展为**降阶阶梯选择**（换例子 → 缩小范围 → 给二选一 → 给最小模型），每一级都可由证据推导，不由模型即兴决定 |
| 3 | **掌握度是证据集合的纯函数**：`masteryFromEvidence()`，唯一正向判定 `isPositiveEvidence()`，困惑有否决权（`core/src/knowledge/mastery.ts`） | 苏格拉底模式的「了解学习进度」= 读这个纯函数的输出，**不新增任何进度真相源** |
| 4 | **掌握门控**：点亮需 ≥2 种不同正向证据（`MASTERY_POSITIVE_KIND_FLOOR`） | 「不能靠学生说『懂了』过关」在苏格拉底模式里升级为**硬闸门**：复述 + 一次变式/闪卡答对才点亮，之后才允许推进下一节点 |
| 5 | **布鲁姆层级门控**：`hasReachedBloom()` / `nodeBloomLevel()` | 决定"能不能换更难的问法"：未达 `understand` 不允许连环抽象追问；达 `apply` 才给迁移题 |
| 6 | **教学协议有正规投递渠道**：稳定协议走 `systemPrompt.section()`，易变状态走 `systemPrompt.context()`（`plugin-host/src/prompt.ts`） | 苏格拉底协议进**新 preset 的 persona**（静态），逐步指令进 context 节（每轮变），用户文本仍不被污染 |
| 7 | **卡片是判别联合，判定方式由类型决定**：`choice` 自动判分，`cloze/short-answer/mnemonic` 自评（`core/src/review/cards.ts`） | 「闪卡等知识测试功能」直接复用四种卡；苏格拉底模式额外要求每张卡**绑 nodeId**，让答对/答错回流成证据 |
| 8 | **复习失败会降级**：`srsMasterySignal()` + `study_submit_review` 一次写入排期与降级信号（`core/src/review/srs.ts`） | 复习不再只是"到期列表"，而是教学回路的一环：答错 → 焦点回到该节点 → 追问深度上升 |
| 9 | **每个数字都必须声明来源**：`Metric<T>` 的 `source` 必填，启发式必须给 note（`core/src/growth/stats.ts`） | 进度面板/报告沿用同一约束，禁止出现"看起来很棒的假数字" |
| 10 | **UI 只能经 slot 注册，事件由 fiber 托管**（`packages/plugin-ui`） | 苏格拉底模式不上新 UI：进度用 `/socratic` 命令 + 工具返回值 + 现有面板承载 |
| 11 | **六道门自检**（编码 / 结构 / 产物 / 安装形态 / preset 形态 / 全量测试） | 新 preset 必须进 `check:preset`，新增工具必须进 `plugin-host/tests/plugin.test.ts` 的注册断言 |

一句话：**苏格拉底模式 = 把「追问深度 + 证据 + 掌握门控 + SRS」这条已有链路，重新编排成一条以"启发式引导"为主线的课堂流程。**

---

## 三、目标态：一节课的样子（六环节状态机）

```
① 定向 diagnose      —— 选焦点节点（困惑 > 到期复习 > 先修未满足 > 未点亮），问一个诊断问题
② 追问 probe         —— 一次一个关键问题，只给台阶不给答案（试探深度 0/1）
③ 降阶 scaffold      —— 深度 2：换例子 / 缩小范围 / 二选一（阶梯由证据选，不由模型选）
④ 直讲+复述 verify   —— 深度 3 或连续两次困惑：讲最小正确模型，要求学生用自己的话复述
⑤ 测试 quiz          —— 复述通过后给一张卡（选择/填空/简答/口诀），判分回流成证据
⑥ 收束+复习 wrapup   —— 节点点亮 → 记录证据 → 插入到期复习 → 给进度摘要与下一步入口
```

规则（必须可测试，不能只写在提示词里）：

- **一次只问一个问题**：`step.ts` 输出的 `questionBudget` 恒为 1。
- **讲答案的门槛**：只有 `probeDepth === 3` 或 `consecutiveConfused >= 2` 才允许 `explain-and-retell`。
- **第 4 环节不可跳过**：直讲之后必须先复述，复述不通过就回到 ② 且深度不重置为 0。
- **复习插入时机**：`dueCards > 0` 时在 ⑥ 插入；`again` 结果允许**打断**当前节点一次（每节课最多一次）。
- **低压力**：允许「不会 / 跳过 / 暂停」，用"下一步入口"代替"任务失败"（沿用伴学协议第 9 条）。

---

## 三·补 多格式输入（复用摄取层 + 补三个缺口）

### 3.1 现状：管线是通的，能力是"死"的

已核实的接线（非推断）：`plugin-host/src/tools.ts:40` 导入 `ingestFile`，`:153` 在 `study_import_textbook` 里真调用；
`ingest/src/registry.ts:112` 读字节 → `detectFormat` → 图像走原生视觉 / 其余走 `runIngestPipeline`；
失败时返回**完整尝试轨迹 + 可操作建议**（`tools.ts:164-176`），图像被明确拒绝并指向视觉模型（`:154-163`）。

| 格式 | 层 | 现状 |
|---|---|---|
| Markdown / txt | native 直通 | ✅ |
| html | builtin 去标签 + 实体解码 | ✅ |
| PDF（文本层） | builtin 内容流解析 | ✅ |
| docx / odt / epub | builtin 自写 zip + XML→Markdown | ✅ |
| PDF（扫描件） | external `pdftotext` / `pdftoppm`+`tesseract` | ⚠️ 依赖外部命令，本机 `tesseract` **未安装**（`pdftotext`/`pdftoppm` 有） |
| 图片 png/jpg/webp/gif | native 视觉 | ✅ 但**只能作为附件**，不能当教材正文 |
| pptx / xlsx / rtf / 音视频 | —— | ❌ 明确不支持（`SourceFormat` 封闭联合里没有），需要"如实说清" |

缺口一：`ingest/src/registry.ts:75` 的 `capabilities()`（能力清单 + 缺哪个依赖）**没有任何生产调用点**——
`plugin-host` 一处都没引用。于是模型与用户都不知道"这台机器能不能 OCR 扫描件"。

> 为什么自检没报出来（**理由经独立核验纠正**）：`scripts/selfcheck.mjs` 的"未接线"判定是
> ①**按名字**在全仓库（含 tests）搜索引用（`:88-89`、`151-159`），且 ②任何被 `export * from` 指向的文件**全仓库豁免**（`:130-135`、`:147`）。
> 所以 `capabilities` 既在自己的 barrel 里，又被 `ingest/tests/pipeline.test.ts` 引用 → 判定为"已接线"。
> 教训（对本计划直接相关）：**selfcheck 绿灯不等于生产接线存在**，新增接线必须另附独立 grep 证据。

缺口二：导入失败虽有建议文本，但**建议不知道本机实际情况**（模板里会说"装 tesseract"，即使已经装了；或反过来）。

缺口三：`ingest` 返回的 `format` 目前只落在报告里，**没有反过来改变教学法**。而苏格拉底模式最需要按格式换问法。

### 3.2 要补的三件事

1. **能力可见**：新增第 10 个工具 `study_formats`——列出本机当前可解析的格式、所在层、`available`、以及缺哪个依赖（例如"扫描件 OCR 需要 `tesseract`，本机未找到"）。一个副作用：模型不再对用户许下做不到的承诺。
2. **失败建议接地**：`study_import_textbook` 的失败分支接上同一份能力清单，把模板建议换成"本机实测缺什么 / 还能走哪条路"（PDF 无文本层时给出两条真实出路：装 tesseract 后重导，或直接看图片附件）。
3. **按格式换教法**：`SourceFormat` 进入教学状态，教学法随之切换（见下表）。

### 3.3 按格式换教学法（苏格拉底模式的"因材施教"）

| 材料类型 | 苏格拉底模式的做法 |
|---|---|
| 教材 / 讲义（PDF / docx / odt / epub） | 用结构切分拿章节 → 焦点按**小节**推进；锚点优先用"小节标题"，因为 PDF 页码在文本层不可靠 |
| 文章 / 网页（html / md） | 一轮只引用一处原文；重点是**作者论证链**的追问（"他凭什么这么断言？"） |
| 法条 / 规范 | 先问"这条的适用条件是什么"，再给反例检验边界；口诀卡走 `mnemonic` 类型 |
| 真题 / 模拟题 | 先隐藏答案让学生自答，答完再揭示；错题直接变成 `errorType` 证据 |
| 答案解析 | 不当作新知识讲，而是**反推**："出题人想考的是哪一个判断？" |
| 图片附件 | 只作为视觉材料提问，不进教材库；有 OCR 文本时可另存为教材 |
| 粘贴正文 | 最快路径，**不做来源真实性断言**（不声称"这是你的教材原文"） |

---

## 三·补二 课堂记录 / 学习留痕 / 不完善点

用户的硬性要求：一节课结束要能**生成课堂记录**（学了什么、怎么学的），留下**学习过程痕迹**，并明确列出**还不完善的点**。
这一条正好补上当前系统唯一真正缺失的一环：**它记住了证据，却没有记住"这节课"**。

### 3b.1 三件不同的事，不要混

| 概念 | 含义 | 现状 | 本计划 |
|---|---|---|---|
| **课堂记录**（记录） | 一节课的**快照**：材料、起止时间、走过哪些环节、涉及哪些节点、当堂结论与下一步 | ❌ 无（只有 `learner_state` 当前位置） | 新增 `sessions` 表 + `buildClassroomRecord()` + `study_wrap_up` 工具 + Markdown 落盘 |
| **学习留痕**（留痕） | 可回溯的**证据链**：每条证据的时间、种类、来源、结果 | ✅ 已有（`evidence` 表 + `evidenceKey` 幂等键 + `orderEvidence`） | 课堂记录里**引用**证据 id，不复制证据 |
| **不完善的点**（缺口） | 没讲完 / 没答上 / 判不清 / 材料本身残缺，且各自带**下一步** | ⚠️ 部分（`confused` 节点、`hasConfusedNodes` 提示） | 新增 `findGaps()` 四类归因 + 收束清单 |

### 3b.2 课堂记录的数据形状

```ts
// 类型契约在 core（零依赖，可单测）；zod 记录 schema 在 plugin-host/storage.ts（domain 模板在此）
export type ClassroomRecord = {
  readonly id: string
  readonly textbookKey: string
  readonly title: string
  readonly materialType: MaterialType
  readonly mode: TeachingMode
  readonly startedAt: string
  readonly endedAt: string
  /** 环节轨迹：本堂课真实走过的环节顺序（来自 study_steps 的可选留痕）。 */
  readonly steps: readonly { readonly step: SocraticStep; readonly at: string; readonly action: SocraticAction }[]
  readonly nodesTouched: readonly { readonly nodeId: string; readonly title: string; readonly mastery: Mastery; readonly evidenceIds: readonly string[] }[]
  readonly evidenceIds: readonly string[]
  readonly answered: number
  readonly explained: number
  readonly retold: number
  readonly review: { readonly submitted: number; readonly again: number; readonly hard: number; readonly good: number }
  readonly gaps: readonly ClassroomGap[]
  readonly summary: string
  readonly nextEntry: string
}
export function buildClassroomRecord(input: {
  readonly textbook?: { readonly key: string; readonly title: string }
  readonly materialType: MaterialType
  readonly mode: TeachingMode
  readonly steps: readonly {...}[]
  readonly evidence: readonly Evidence[]
  readonly nodes: readonly KnowledgeNode[]
  readonly cards: readonly { readonly srs: SrsState; readonly nodeId?: string }[]
  readonly startedAt: string
  readonly endedAt?: string
  readonly now?: Date
}): ClassroomRecord
```

### 3b.3 「不完善的点」必须归因，不能只报"有困惑"

`findGaps()` 输出四类，每类都带 `nextStep`（可执行）与 `source`（证据 / 材料 / 系统）：

| 缺口类型 | 判定来源（全部来自真实数据） | 下一步 |
|---|---|---|
| `confused-node` | 节点存在 `confused` 或 `correct === false` 的证据 | 回到该节点，进阶追问深度（不重置为 0） |
| `unanswered` | 有 `question-asked` 证据但长时间没有对应的 `answer-quality` | 先降低问题难度，或换成二选一 |
| `material-defect` | 教材 `parseStatus !== 'ready'` 或导入时 `partial === true`（例如扫描件只取到标题） | 补依赖后重导 / 换一份材料 |
| `system-gap` | 到期卡为 0 而节点已点亮（**没建卡**）、知识点无任何证据、节点无对应卡片 | 建卡 / 补一次测试 |

**诚实约束（沿用 `Metric<T>` 的精神）**：缺口只能是"有证据支撑"或"材料/系统事实"；
任何"看起来该复习了"的猜测必须标成 `heuristic` 并带 `note`，不得与证据结论并列展示。

### 3b.4 记录怎么产生、怎么留痕、怎么不撒谎

- **产生时机**：用户说"这节课到这里 / 整理一下"→ `study_wrap_up`（与伴学协议第 8 条"收束必须征得同意"一致）。
- **写盘顺序**：算记录 → **先落盘 session** → 再生成 Markdown 快照。落盘失败时明确报错，不返回"已保存"。
- **快照 vs 重算**：`sessions` 存的是**当时**的快照（`write-once`）。之后的证据变化**不改写历史记录**——
  因为"同一条证据两个结论"正是原系统最贵的病，历史记录必须冻结。
- **落盘位置**：`<工作区>/.study/records/<日期>-<标题>.md`（工作区内、可读、可 diff、可进版本库）；
  纯函数 `renderClassroomRecord()` 负责渲染，因此同样的记录在任何地方渲染结果一致。
- **`study_progress` 报告**尾部增加"最近一次课堂记录摘要"一行（只读最近一条，不重算历史）。

---

## 三·补三 按材料类型自适应教学模式

用户的硬性要求：不同教材要走不同教法 —— 规章条例、大学教材、刷题，各自一套。
**现状：词表已备好，逻辑是空的。** `MaterialType`（`article|textbook|regulation|lecture-notes|exam|answer-analysis`）与
`TeachingScenario`（`general|regulation|law|course-concept|code-practice|review`）在 `core/src/types.ts` 有**类型与中文标签**，
但**没有任何分类器与策略映射**：全仓库只有 `prompt.ts` 引用了 `TeachingScenario`，`MaterialType` 一次都没被引用过。
导入时命中的 `sourceFormat` 也只写进报告与记录（`tools.ts:178/217`），并不改变教学行为。

### 3c.1 分类 → 模式 → 策略 三层

```ts
/** 1) 材料分类：显式 > 扩展名 > 内容特征，三层降级，输出必须带 confidence 与 evidence 说明。 */
export function classifyMaterial(input: {
  readonly title?: string
  readonly sourceRef?: string
  readonly sourceFormat?: SourceFormat
  readonly markdown: string
  readonly explicit?: MaterialType
}): { readonly type: MaterialType; readonly confidence: 'explicit' | 'strong' | 'weak'; readonly why: string }

/** 2) 类型 → 教学法：封闭映射，未知输入不穿透。 */
export function teachingModeOf(type: MaterialType): TeachingMode
export type TeachingMode = 'concept-driven' | 'clause-driven' | 'drill-driven' | 'argument-driven' | 'exam-debrief'

/** 3) 策略：把"怎么教"编码成数据，而不是散在提示词里。 */
export type TeachingStrategy = {
  readonly mode: TeachingMode
  readonly focusBias: readonly string[]        // 焦点偏好（如刷题模式优先错题节点）
  readonly questionBias: readonly string[]     // 问法偏好（如条例模式优先"适用条件/例外"）
  readonly cardBias: readonly CardKind[]       // 生成卡片的类型偏好（如条例→cloze + mnemonic）
  readonly scaffoldLadder: readonly string[]   // 降阶阶梯（如刷题模式先给"题眼"再给第一步）
  readonly wrapUpChecklist: readonly string[]  // 收束清单（如条例模式必须复述例外情形）
}
export function strategyFor(type: MaterialType): TeachingStrategy
export function modeDirective(mode: TeachingMode): string
```

### 3c.2 五种模式的教学法（这张表是数据，不是散文）

| `MaterialType` | 模式 | 焦点 | 追问的重点 | 卡片偏好 | 降阶阶梯 | 收束清单 |
|---|---|---|---|---|---|---|
| `regulation` 规章条例 | `clause-driven` | 逐条：适用条件 → 例外 → 后果 | "这一条的**适用条件**是什么""**什么情况下不适用**""如果不满足条件会怎样" | `cloze`（要件填空）+ `mnemonic`（口诀） | 条文原文 → 拆成要件 → 给一个不满足条件的反例 | 复述适用条件与例外情形各一次 |
| `textbook` 大学教材 | `concept-driven` | 概念 → 机制 → 迁移 | "这个概念解决什么问题""与它最容易混的是哪个""换个场景还成立吗" | `short-answer` + `choice`（辨析） | 给定义 → 给对比表 → 给一个边界例子 | 用自己的话讲清一个机制并给一个反例 |
| `exam` 刷题/真题 | `drill-driven` | **先自答**，再判对错，再归因 | "你先说答案和理由""错在哪一步：概念/记忆/迁移/审题" | `choice` + `cloze` | 给"题眼" → 给第一步 → 给同类更小题 | 列出本轮错题的 `errorType` 分布与重做清单 |
| `article` 文章 | `argument-driven` | 论证链：主张 → 理由 → 证据 → 反驳 | "作者凭什么这么断言""这个证据支持到哪一步""哪里最弱" | `short-answer` | 标出主张句 → 标出理由句 → 给一个反驳方向 | 用自己的话重述论证链 |
| `lecture-notes` 讲义 | `concept-driven`（偏结构） | 本次课的知识地图 | "这几个概念之间是什么关系：先修/对照/易混/实例" | `short-answer` + `mnemonic` | 给目录 → 给一句话纲要 → 给一个概念对照 | 补齐图谱里缺的语义边 |
| `answer-analysis` 答案解析 | `exam-debrief` | 反推出题意图 | "出题人想考哪一个判断""这一步为什么必须这么做""换个数还成立吗" | `choice` + `short-answer` | 指出考点 → 指出关键步骤 → 给一个变式 | 归纳本条解析对应的考点 |
| 未识别（`unknown` / 弱置信） | 不猜：默认 `concept-driven` + **显式问用户**"这是教材、条例还是题？" | — | — | — | — | — |

**与苏格拉底原则的一致性**：模式只改"问什么、卡片长什么样、怎么降阶"，
**不改**"先问后讲""一次一个问题""深度 3 才直讲""≥2 种正向证据才点亮"这四条硬规则——那是跨模式的底线。

### 3c.3 落在哪里（材料类型是**教材的属性**，不是会话属性）

- **存进教材记录自身**：`textbooks.sourceFormat` 写入**复合值** `` `${SourceFormat}|${MaterialType}|${confidence}` ``（例如 `pdf|regulation|strong`）。
  理由：材料类型不会因为换教材而改变，也不该依赖"当前活动教材"；放进 `learner_state` 会导致换书即丢。
- **兼容性/版本复核（独立核验结论）**：`sourceFormat` 是 `z.string()`（`storage.ts:40`），旧值形如 `pdf` / `markdown`；
  读取时按 `|` 切分，**首段取 `SourceFormat`**，其余缺失则按内容特征重新分类。**零 migration、零新字段**。
  （此前我曾考虑写进 `learner_state`，核验确认 `schemaNote` 实际属于 domain 的 `global.schema`（`storage.ts:145`）而不是 `LearnerState`，故该方案作废。）
- **允许一句话改判**：用户说"这是条例不是教材"→ 分类器接受 `explicit` 覆写，重写该教材的 `sourceFormat` 复合值与 `confidence='explicit'`。
- 分类与策略全部是 core 纯函数（`material.ts` / `strategy.ts`），有单测；宿主只负责"调用 + 落盘 + 渲染"。
- `prompt.ts` 的易变状态快照另带 `teachingMode`，供每轮的 context 节使用（快照是易变的，不承担持久化职责）。
- **首次接通两条既有死路（核验发现）**：`prompt.ts:96` 的"材料情景"与 `:102-105` 的"错误类型"两个渲染分支
  当前**恒不执行**——快照唯一写入点 `tools.ts:429-435` 从不赋 `scenario` / `errorType`。
  本计划是它们的第一位生产者：分类结果写 `scenario`、错误类型写 `errorType`，验收里要能看到这两行真的出现。

---

## 四、落地设计（核心引擎）

> **已确认的取舍（决策记录）**：采用**编排工具层**——新增 `study_steps`，模型每轮向系统索取"下一步做什么"，
> 而不是自己决定讲不讲答案；`mayRevealAnswer` / `questionBudget` 由证据推导。伴学模式（`presets/study`）**不切过去**，
> 保持已验收行为不变，`study_steps` 对它是纯增量可用工具。

### 4.1 纯函数层（新增，`packages/core`，零依赖，`node --test` 直接可跑）

**A. `packages/core/src/pedagogy/step.ts`** — 步骤机

```ts
export type SocraticStep = 'diagnose' | 'probe' | 'scaffold' | 'explain-and-retell' | 'quiz' | 'wrapup'
export type SocraticAction = 'ask' | 'narrow' | 'give-example' | 'offer-binary' | 'explain-then-retell' | 'quiz' | 'review' | 'advance'
export type SocraticMove = {
  readonly step: SocraticStep
  readonly action: SocraticAction
  readonly nodeId?: string
  readonly probeDepth: ProbeDepth
  /** 恒为 1 —— 一次只问一个问题。 */
  readonly questionBudget: 1
  /** 给学生看的台阶（不含答案）。 */
  readonly scaffoldLadder: readonly string[]
  /** 给模型看的指令，来自纯函数而非模型自省。 */
  readonly directive: string
  readonly mustRetell: boolean
  readonly mayRevealAnswer: boolean
}
export function nextSocraticMove(input: {
  readonly nodeId?: string
  readonly mastery: Mastery
  readonly probeState: ProbeState
  readonly cards: readonly { readonly srs: SrsState; readonly nodeId?: string }[]
  readonly history: readonly Evidence[]
  readonly now?: Date
}): SocraticMove
```

**B. `packages/core/src/pedagogy/focus.ts`** — 焦点选择（把现有路线排序抽成可单测的纯函数）

```ts
export type FocusReason = 'confused' | 'due-review' | 'prerequisite-gap' | 'unlit' | 'fresh'
export function selectFocusNode(graph, opts?): { node: KnowledgeNode; reason: FocusReason; detail: string } | undefined
export function focusReasonDirective(reason: FocusReason): string
```

优先级固定：`confused > due-review > prerequisite-gap > unlit > fresh`，同档内按节点顺序，保证两次调用结果一致。

**C. `packages/core/src/review/plan.ts`** — 复习编排（与闪卡测试打通）

```ts
export type ReviewPlanItem = { cardId: string; nodeId?: string; kind: CardKind; due: boolean; overdueDays: number; reason: string }
export function buildReviewPlan(cards, opts: { now?: Date; nodeIds?: readonly string[]; limit?: number }): ReviewPlanItem[]
export function shouldInterrupt(plan: readonly ReviewPlanItem[], current?: { againCount: number }): boolean
```

**D. `packages/core/src/pedagogy/quiz.ts`** — 苏格拉底式测试编排

```ts
/** 由节点证据与已达层级决定下一题该问什么，而不是随机抽卡。 */
export function nextQuizKind(input: { bloom: BloomLevel; mastery: Mastery; hasCard: boolean }): CardKind | 'explain-in-own-words'
export function quizDirective(kind: CardKind | 'explain-in-own-words'): string
/** 一次作答 → 证据字段（tone/correct/bloom/errorType），复用 evidenceTone 与 isPositiveEvidence 的语义。 */
export function answerToEvidence(input: {...}): Pick<Evidence, 'kind' | 'correct' | 'result' | 'bloomLevel' | 'errorType' | 'summary'>
```

### 4.2 宿主层（`packages/plugin-host`，薄接线）

1. **`tools.ts` 追加第 9 个工具 `study_steps`**
   - 入参：`textbook_key?`、`node_id?`、`last_answer?`（学生最近一句）、`record?: boolean`
   - 行为：读 graph + cards → `deriveProbeState` → `nextSocraticMove()` →（可选）写一条 `answer-quality` 证据 → 返回三样东西：
     ① 当前环节与动作 ② 可直接照做的下一步指令 ③ 进度摘要（节点掌握度 / 深度 / 到期卡 / 今日已复习）
   - **零副作用模式**：`record: false`（默认）时不写任何证据，只做编排，方便模型"问下一步"而不污染数据。
2. **`tools.ts` 的 `study_progress`**：返回体**追加** `step` / `next_action` / `focus_reason`（现有 5 个字段一个不改，输出 schema 只增字段）。
3. **`prompt.ts` 的 `buildStudyContext()`**：追加两行 `- 当前教学环节：…` / `- 下一步动作：…`，仍走 `systemPrompt.context()`，不进前缀。
4. **`index.ts`**：追加 `/socratic` 斜杠命令（与现有 `/study` 同构），一行给出"当前环节 + 下一步 + 进度"。

### 4.3 模式层（新增 preset，不动现有伴学模式）

```
presets/
├─ study/                    现有「伴学模式」，order 5，行为不变
└─ socratic/                 新增「苏格拉底教学模式」
   ├─ preset.yml             name: 苏格拉底教学模式 / order: 6
   ├─ agent.cordis.yml       persona（苏格拉底协议） + 读材料 + 技能 + 压缩 + ask_user
   └─ skills/socratic-tutor/SKILL.md
```

- **preset id 合法性**：DSH 的 `PRESET_ID = /^[a-z0-9][a-z0-9-]*$/`（已从 `dsh-agent-presets/lib/types/preset.js:10` 取证），`socratic` 合法。
- **目录布局**：`scanRoot()` 把一个 root 下的**每个子目录名当作 preset id**，读 `<root>/<id>/agent.cordis.yml`、`<root>/<id>/preset.yml`（`dsh-agent-presets/lib/types/discovery.js:280-314`）。现有补丁的 roots 已指向 `presets/`，**新增 `presets/socratic/` 即自动被收录，`cordis.patch.yml` 不需要改路径**。
- **人格承载协议**：苏格拉底协议写进 `persona.prefix`（静态），插件仍 `protocol: false`（宿主级挂载）。其它模式拿到工具，但不会被苏格拉底口吻污染。
- **工具面收窄**：与伴学模式一致（`tool-fs` / `tool-fs-search` / `tool-skill` / 压缩 / `ask_user`），不挂 shell、子代理、工作流、plan-mode。

### 4.4 验证脚本层（`scripts/`）

- `verify-preset.mjs`：从「只验 `presets/study`」改成**遍历 `presets/*`**，逐个检查（顶层数组 / 行有 name / id 唯一 / 包名可解析 / persona 协议非空壳 / 工具面确实收窄 / 技能文件在位）。
- `verify-install.mjs`：断言补丁的 roots 解析出的目录里**至少有两个 preset**（study + socratic）。
- `dev-link.ps1`：目前把 `presets/study` junction 到用户根。改为**遍历 junction 每个 preset 子目录**（或提供 `-Preset <id>`），并在检测到 bundle 已安装时保持既有拒绝逻辑不变。

---

### 4.5 多格式相关的落点

- `packages/plugin-host/src/tools.ts`：新增 `study_formats`；`study_import_textbook` 失败分支接能力清单；导入成功后把 `format` 写进教学状态快照。
- `packages/plugin-host/src/prompt.ts`：`StudyContextInput` 增加 `sourceFormat`，context 节输出"- 材料形态：PDF（文本层）/ 扫描件 / 真题…"与对应问法提示。
- `packages/core/src/pedagogy/focus.ts`：`focusReasonDirective()` 之外增加 `formatDirective(format)`（纯函数、可单测），把 3.3 的表编码成数据而不是散文。
- `presets/socratic/skills/socratic-tutor/SKILL.md`：写清"导入 → 判形态 → 定问法"的第一步流程与失败时的两条出路。
- 不改 `packages/ingest`（它的 62 项测试是当前最贵也最扎实的资产，动它的风险远大于收益）。

---

## 五、三条必须正面回答的冲突

| 冲突 | 处理 |
|---|---|
| **两个模式共享同一份学习数据**（同一个插件、同一个 storage domain） | 这是**特性不是 bug**：伴学模式导入的教材，苏格拉底模式直接接着教。但**焦点节点各自独立**（`selectFocusNode` 由证据推导，不靠会话变量），因此互不污染。 |
| **"一次只推进一个点" vs "及时复习"** | 固定规则：复习只在 ⑥ 收束时插入；只有 `again`（真答错）允许打断一次，且每节课最多一次。规则写在 `shouldInterrupt()` 里，可测。 |
| **降阶会不会变成无限喂台阶 / 变成不教** | 硬闸门：深度 3 或连续 2 次困惑**必须** `explain-then-retell`；复述不通过回到 ② 但**深度不归零**。宁可多讲一次最小模型，也不允许变成只反问不教学的表演。 |

---

## 六·补 多格式的验收与诚实边界

**验收（可跑）**

| # | 验收项 | 手段 |
|---|---|---|
| M1 | `study_formats` 在本机如实报告：`pdftotext`/`pdftoppm` 可用、**`tesseract` 不可用** | 新增 `plugin-host/tests/plugin.test.ts` 断言 + 实机目视 |
| M2 | Markdown / txt / html / pdf / docx / odt / epub 七种格式仍全部可导入（解析器能力未被新模式改动破坏） | `npm run test:ingest` + 一次真实文件导入 |
| M3 | pptx / xlsx / rtf 三类**明确失败**并给出"支持哪些格式"的清单，不产生半截教材 | 新增用例（构造最小 zip/magic 字节即可，沿用 `tests/helpers/fixtures.ts` 的手法） |
| M4 | 图片仍被拒绝为"教材正文"，但给出两条真实出路（当附件给视觉模型 / OCR 后另存） | 同上 |
| M5 | 扫描件 PDF 在缺 `tesseract` 时**如实失败**，错误文本包含缺的命令名，而不是返回空字符串冒充成功 | `npm run test:ingest` 已有该断言，接线后保持一致 |
| M6 | 同一份材料换格式导入（.md → .docx）不产生"改稿即失忆"（身份 key 与版本 revision 分离） | `npm run test:core`（`identity.test.ts` 已覆盖） |

**诚实边界（写进 README 与技能，不写"全面支持"）**

- **不做** pptx / xlsx / rtf / 音视频 / 手写体识别；没有的语言包不猜。
- OCR 是**性能特性不是主路径**：本机缺 `tesseract`，扫描件要么先装依赖，要么走图片视觉。
- 解析器对复杂排版有损（脚注、双栏、合并表格、公式/图片里的文字），有损时必须标 `partial`，不得当成完整正文。
- `detectFormat` 判不准时用容器结构再判一次（`sniffContainerFormat`），**判不准也要把实际命中的格式与完整尝试轨迹展示给用户**，不出现"悄悄按纯文本处理"。

---

## 七、验收标准（可跑的，不是形容词）

| # | 验收项 | 验证手段 |
|---|---|---|
| 1 | 步骤机：深度 0/1 → ask；2 → scaffold（含阶梯）；3 → explain-then-retell 且 `mayRevealAnswer=true` | `packages/core/tests/step.test.ts` |
| 2 | 焦点选择优先级在给定证据下**确定**，两次调用一致 | `packages/core/tests/focus.test.ts` |
| 3 | 复习计划按 `nextReviewAt` 升序、逾期天数正确、`limit` 生效 | `packages/core/tests/plan.test.ts` |
| 4 | 问答→证据字段映射与 `evidenceTone`/`isPositiveEvidence` 语义一致（答对=partial、答错=confused） | `packages/core/tests/quiz.test.ts` |
| 4b | `formatDirective()` 对七种格式各有确定输出（教材/文章/法条/真题/解析/图片/粘贴正文），未知格式不静默穿透 | `packages/core/tests/focus.test.ts` |
| 5 | 新工具注册、`/socratic` 命令注册、context 节含"下一步动作" | `packages/plugin-host/tests/plugin.test.ts` |
| 6 | `study_progress` 旧字段一个不少（向后兼容） | 同一测试文件加兼容断言 |
| 7 | 伴学模式行为不变（现有 133 项测试全绿） | `npm test` |
| 8 | 两个 preset 都能用 loader 方言解析、7+7 行可解析到真实包 | `npm run check:preset` |
| 9 | bundle 装进临时 `DSH_HOME` 后，模式选择器能看到两个模式 | `npm run check:install` |
| 10 | 实机：模式选择器出现「苏格拉底教学模式」，一节课能走完 ①→⑥ | 手工验收（GUI） |
| 11 | 课堂记录：走过 ①→⑥ 后生成快照，`nodesTouched` 的证据 id **全部能在 `evidence` 表里找到**（不是编的） | `packages/core/tests/record.test.ts` |
| 12 | 缺口四类各自可被真实数据触发，且每类都带 `nextStep`；猜测项必须带 `heuristic` + note | 同上 |
| 13 | 记录**冻结**：生成后再写新证据，重读记录内容不变（不被后来者改写） | `packages/plugin-host/tests/plugin.test.ts` |
| 14 | 落盘失败时不返回"已保存"（与旧系统"看似完成、实际无证据"相对） | 同上（模拟域写入失败） |
| 15 | 五种模式在同一段材料上的 `strategyFor()` 输出**确实不同**（逐字段 diff，不是"字符串非空"） | `packages/core/tests/strategy.test.ts` |
| 16 | 分类器：条例/教材/题各有可解释的判据，弱置信**必须**给 `why` 并回落到"问用户" | `packages/core/tests/material.test.ts` |
| 17 | 模式**不改**四条硬规则（先问后讲 / 一次一问 / 深度 3 才直讲 / ≥2 种正证才点亮） | 同上（断言策略不覆盖这些字段） |
| 17b | 两条既有死路被真正接通：context 节里**实际出现**"材料情景"与"错误类型"两行（此前无生产者） | `packages/plugin-host/tests/plugin.test.ts` |
| 23 | 多格式（M1–M6）：七种格式走**真实文件路径**可导入并建起结构；五条失败路径如实说明且不留半截教材 | `packages/plugin-host/tests/formats.test.ts` |
| 24 | 按材料换教法真的生效：同一段正文以条例/真题导入后，`study_steps` 给出的追问重点与降阶阶梯**不同**，且跨模式底线不变 | `packages/plugin-host/tests/plugin.test.ts` |
| 18 | **零起点**：无教材 / 空图谱时 `study_steps` 返回 `import-material` 类动作与可执行话术，不报错、不返回空对象 | `packages/plugin-host/tests/plugin.test.ts` |
| 19 | 附件句柄路径可导入；解析不到时明确报"我拿到的是句柄不是正文"并列出受支持格式与替代做法 | 同上 |
| 20 | 课堂记录在**真实运行**里可见：Markdown 文件落在工作区 `.study/records/`，且 `/socratic` 能打印最近一次记录摘要 | 手工验收（GUI 或 CLI）+ 文件存在性断言 |
| 21 | 复习统计不为 0：给定真实 `srs-review` 证据行，`study_progress` 的复习天数/已复习卡**非零**（修复 `reviewHistory` 死接线，见台账 F1） | `packages/core/tests/stats.test.ts` + `packages/plugin-host/tests/plugin.test.ts` |
| 22 | **活动教材跨重启可往返**：`putTextbook` → `setActiveTextbook` → `close` → 重新 `open` 仍读得到；且旧半截写法必须被判失败（C4 回归） | `packages/plugin-host/tests/plugin.test.ts` |

---

## 八、批次计划

> 目标基线：启动时先跑一次 `npm run check` 记录当前状态（README 记录为 133 通过 / 0 失败），
> 之后每个批次结束都必须重跑并对比，**不允许出现"新批次绿了、老测试红了"**。

**批次 S0 · 基线（0.5h）**
跑 `npm run check` 记录基线；确认 `dev-link.ps1` 的 junction 现状（本机 `.agent-presets/study` 已是指向 `presets/study` 的 Junction）。

**批次 S1 · 纯函数层（最大工作量，1–2 天）** ✅ **已完成**

落点与计划的差异（已按实际实现修正）：
- `pedagogy/{step,quiz,focus,material,strategy}.ts` + `review/plan.ts`（共 6 个新模块）+ 6 个测试文件；
- 计划里曾写"`focus.ts` 承担 `formatDirective()`"，实际落成 **`strategy.ts` 的 `materialDirective()`**
  —— 由 `MaterialType` + `strategyFor()` 单一来源派生，避免两套并行的"格式→教法"映射；
- `growth/stats.ts` 增加**以 `srs-review` 证据行为准**的复习口径（修复台账 F1 的死接线）并补回归测试。

实测：core 测试 **64 → 131**；全量 `npm test` **201 通过 / 0 失败**；`check:structure` 31 模块 / 未接线 0 / 孤立包 0；`build` 29 个服务端模块；`check:build` 通过。

**S1 遗留的接线债（S2 第一验收标准）**：6 个新模块目前**只被测试引用**（`reviewActivity()` 除外，它已被 `growth/stats.ts` 生产消费）。
S2 必须把它们变成真实调用点，并在台账"丁"节的表里逐条更新为 ✅。

**批次 S2 · 宿主接线（0.5–1 天）**

> ✅ **前置项已完成（核验①的 C4 已实证为真 bug 并修复）**：`store.ts` 的 `setActiveTextbook`
> 原先只写 `{ activeTextbookKey }`，而 domain 的 `global.schema` 要求 `schemaNote` 也在；
> 写入不校验、**重新 open 才校验** → 用户第一次导入教材后，下次启动数据域打不开
> （`DomainError('invalid-record')`，最坏形态是宿主起不来）。已改为写全 global + 加回归测试（验收 22）。
> 详见 `findings.md` 的 C4 条目。

`tools.ts` 加 `study_steps`（含 `record` 留痕参数，默认关）与 `study_formats`，导入失败建议接能力清单；`study_progress` 追加字段；`prompt.ts` 的 context 追加环节/下一步/材料形态；`index.ts` 加 `/socratic`。
验收：`packages/plugin-host/tests/plugin.test.ts` 断言 11 个工具 + 2 个命令 + context 文本 + **零起点动作（验收 18）**与**附件句柄路径（验收 19）**；`npm run check:build`、`npm run check:install` 过。

> **接线证据纪律（C6）**：`selfcheck` 的"未接线"是**按名字**匹配的，存在假阴性（标本：`store.ts:19` 的 `emptyLearnerState`
> 零引用却因 core 里有同名导出而躲过检查）。因此每个新工具/新 context 字段落地后，
> 必须在 `progress.md` 附一条独立 grep 证据（"生产者文件:行号 + 消费者文件:行号"），不拿 selfcheck 绿灯当接线证明。

**批次 S3 · 模式与内容（0.5 天）**
新增 `presets/socratic/`（`preset.yml` / `agent.cordis.yml` / `skills/socratic-tutor/SKILL.md`，技能含"导入 → 判格式 → 定问法"流程）；
`core/src/pedagogy/focus.ts` 补 `formatDirective()` 与其测试；改造 `verify-preset.mjs`、`dev-link.ps1` 支持多 preset。
验收：`npm run check:preset` 两个模式都过；`formatDirective()` 对七种格式各有确定输出。

**批次 S3.5 · 多格式验收（0.5 天）**
按 §六·补 的 M2–M5 逐条实测：七种格式真实导入一次；构造 pptx/xlsx 最小字节确认**明确失败**且列出支持清单；图片确认被拒绝并给出两条出路；扫描件 PDF 确认在本机（无 tesseract）如实失败。
验收：新增用例进 `plugin-host/tests/` 或 `ingest/tests/`（视落点），`npm run test:ingest` 与 `npm test` 全绿。

**批次 S3.6 · 材料分类与模式路由（0.5–1 天）**
新增 `core/src/pedagogy/material.ts`（`classifyMaterial()`）与 `core/src/pedagogy/strategy.ts`（`TeachingMode` / `TeachingStrategy` / `strategyFor()` / `modeDirective()`）+ 两个测试；
`formatDirective()`（S3）改为消费 `strategyFor()`，避免出现两套并行的"格式→教法"映射；
材料类型与置信度写进 `textbooks.sourceFormat` 的复合值（旧值按 `|` 切分兼容，见 §3c.3）。
验收：验收项 15–17。

**批次 S3.7 · 课堂记录与留痕（1 天）**
`core/src/records/{classroom,gaps,render}.ts` + `tests/record.test.ts`；
`storage.ts` 新增 `sessions` 表（**域版本 1 → 2**）与 `StudyStore` 的 `putSession` / `sessionsFor` / `latestSession`；
`tools.ts` 新增 `study_wrap_up`（生成记录 + 落盘 + 返回 Markdown）与 `record` 留痕参数；
`study_progress` 报告尾部加"最近一次课堂记录摘要"。
验收：验收项 11–14；`npm run check:install`（域版本升级后在临时 `DSH_HOME` 仍可装载）。

**批次 S4 · 回归与实机（0.5 天）**
`npm run check` 全绿（133 + 新增）；实机在 GUI 模式选择器选中「苏格拉底教学模式」，走通一节课并确认落盘（教材、证据、复习排期、进度、**课堂记录**）；
并用三类材料各走一遍确认教法确实不同：一份条例（适用条件/例外）、一份大学教材（机制/迁移）、一份真题（先自答再判分归因）。
产出：`progress.md` 记录 + `findings.md` 记录实机发现（这一层历来会暴露真 bug，例如 `required: false` 被 schema 编译器拒绝、存储域生命周期）。

**批次 S5 · 收口（0.5 天）**
`README.md` 增补「苏格拉底教学模式」章节与两个模式的差异表、**五种教学模式的对照表**、**课堂记录与缺口说明**、多格式支持表与"明确不支持"清单；
`docs/socratic-teaching-mode-plan.md` 回收为**实施记录**（把计划态改成"已交付/未交付"两栏，未交付必须写明原因）。

---

## 九、风险与回退

| 风险 | 应对 |
|---|---|
| 新增第二个 preset 后，模式选择器出现"损坏"条目 | `check:preset` 遍历 `presets/*`，把这类问题拦在提交前（这正是当初补这一道门的原因） |
| `plugin-ui` 客户端已注入 `settings.section`，多一个模式是否需要 UI 改动 | 不需要：preset 发现由宿主完成；客户端只读 roster。实机确认一次即可 |
| 工具数量增加导致模型在两种模式间"串味" | 苏格拉底协议只在新 preset 的 persona 里；伴学模式 persona 一行不改 |
| dev-link 与 bundle 同时挂载（历史上已踩过一次） | 沿用 `dev-link.ps1` 现有拒绝逻辑，扩展 preset 遍历时不得削弱该检查 |
| 步骤机与模型行为不一致（模型不照指令走） | 指令不是祈使句而是**状态**：`study_steps` 每轮返回 `mayRevealAnswer` / `questionBudget`，与 `depthDirective` 一致，模型偏离时用户可见地偏离（不会静默） |
| 多格式被夸大成"全面支持" | §六·补 的"诚实边界"写进 README 与技能；pptx/xlsx/rtf/音视频在文档与工具描述里都显式列为不支持 |
| 能力探测与真实结果不一致（例如探测说 tesseract 可用、实际跑失败） | `study_formats` 只报探测结果，导入失败仍以**实际尝试轨迹**为准；两者矛盾时以轨迹为准并在报告里都呈现 |
| 课堂记录被后来的证据"改写历史" | 记录是 `write-once` 快照，落在 `sessions` 表；渲染是纯函数，重读不改内容（验收项 13） |
| 域版本 1→2 影响已安装用户的既有数据 | 只**新增表**不做字段迁移；`check:install` 在临时 `DSH_HOME` 里验证装载；失败时按既有策略降级为内存存储并记日志，绝不抛出让宿主退出 |
| 模式分类猜错导致教法跑偏 | 分类输出必须带 `confidence` 与 `why`；弱置信时**不猜**，直接问用户"这是教材、条例还是题"，并允许一句话改判（改判即重写该教材的 `sourceFormat` 复合值） |
| 复合值写进 `sourceFormat` 会不会污染既有读取路径 | 只有一处写入（`applyImportPlan` 的调用点）与一处读取（分类器）；旧值 `pdf` / `markdown` 仍能正确切分；`check:build` 与既有 `identity` / `structure` 测试覆盖该字段的传递 |
| 计划宣称"已有"而代码里其实没有（本轮自检已抓到一例：`reviewHistory` 死接线） | 台账 `docs/socratic-teaching-mode-ledger.md` 逐条登记"计划断言 → 代码证据"；独立核验不通过的断言必须回头改计划，不允许"计划这么说、代码不是这样" |
| 首次使用没有任何教材时流程空转 | `study_steps` 的零起点动作（验收 18）；`SKILL.md` 第一步写"先锁定一份材料，没有就先导入或粘贴" |
| **新增 `presets/` 或 `docs/` 下的中文文件不被编码体检覆盖**（核验②实测：`check-encoding.mjs:54` 只扫 `packages/` 与 `scripts/`） | S3 第一件事：扩 `collect` 根到 `presets/` 与 `docs/`，把本仓库曾经发生过的 UTF-8→GBK 损坏事故挡在提交前 |
| **门禁在缺 DSH 的机器上会静默通过**（`verify-preset.mjs:35-38` / `verify-install.mjs:36-39` 找不到 DSH 时打印"跳过"并 exit 0） | 验收 8 与 M1 必须在**有 DSH 的机器**上跑；报告里要写"本次是否真跑了这一门"，不允许把"跳过"记成通过 |
| 新增工具/命令会让 `plugin.test.ts` 的硬编码断言失败（`:85` 工具数、`:86-98` 名字表、`:103` 命令表） | 这是门禁在起作用：S2 同步更新这些断言（含 README `:117`/`:343` 的数字） |

回退：删除 `presets/socratic/` 即从模式选择器消失；`study_steps` 与 `/socratic` 为纯增量，注释掉注册行即回到当前形态。

---

## 十一、交付状态（2026-09-27 收口）

| 批次 | 状态 | 关键证据 |
|---|---|---|
| S0 基线 | ✅ | 六道门全绿，`tests 133` |
| S1 纯函数层 | ✅ | `pedagogy/{step,quiz,focus,material,strategy}.ts` + `review/plan.ts`；core 测试 64 → 131 |
| S2 宿主接线 | ✅ | `study_steps` / `study_formats`；导入即分类；`study_progress` 追加 7 字段；context 接通两条历史死路；`/socratic` |
| S3 模式与门禁 | ✅ | `presets/socratic/`（order 6）；`verify-preset` 改遍历；编码体检扩到 `presets/`+`docs/`+根文件（52 → 83） |
| S3.5 多格式 | ✅ | `plugin-host/tests/formats.test.ts`：七种格式真实文件导入+读回，五条失败路径 |
| S3.6 材料分类教法 | ✅ | `study_steps` 每轮输出材料类型对应的追问重点与降阶阶梯；快照接通 `teachingMode`/`scenario` |
| S3.7 课堂记录 | ✅ | `records.classroom.ts` + `study_wrap_up` + `sessions` 表 + 域版本 2 + **`compatibleVersions: [1]`**（升级不丢数据，正反回归） |
| S4 安装/实机 | ✅（机器可验） | 装→卸→再装周期；**GitHub 安装实测通过**（克隆后用真实装载器验 `verify-build`/`verify-preset`）。⏳ 仅剩 GUI 目视 |
| S5 收口 | ✅ | README / CHANGELOG / publishing / versioning 四份文档；版本 0.2.0；发布仓库 `main` = `de1fb831cd14b647aefcabcc9b9b3500f1a7fc59` |

**最终门禁数字**：编码 83 文件、结构 32 模块（未接线 0）、构建 30+1、产物验证、安装形态（含卸/重装）、preset 形态 2 个模式、全量测试 **248 通过 / 0 失败**。

**同一目标顺带修掉三个既有真 bug**（都不是本计划引入的）：
① `setActiveTextbook` 写半截 global → 导入教材后重启打不开数据域；
② 证据 id 用幂等键长度当摘要 → 同毫秒写入互相覆盖，追问深度永远到不了 3；
③ 教材记录形状与持久层从未一致 → 每次导入写不合法行。

**唯一遗留**：GUI 目视（模式选择器是否出现「苏格拉底教学模式」并走通一节课）——需要使用者操作，dev junction 已就位。

## 十、落盘清单（本计划要创建/修改的文件）

**新增**

- `packages/core/src/pedagogy/step.ts`
- `packages/core/src/pedagogy/material.ts`（材料分类）
- `packages/core/src/pedagogy/strategy.ts`（类型 → 教学法；含 `materialDirective()`）
- `packages/core/src/review/plan.ts`
- `packages/core/src/records.classroom.ts`、`records.gaps.ts`、`records.render.ts`
  （**扁平放置**：barrel 只豁免它直接指向的文件，`records/classroom.ts` 需要额外一层 `records/index.ts`；扁平可少一个活动件）
- `packages/core/tests/step.test.ts`、`focus.test.ts`、`plan.test.ts`、`quiz.test.ts`、`material.test.ts`、`strategy.test.ts`、`record.test.ts`
- `presets/socratic/preset.yml`、`presets/socratic/agent.cordis.yml`
- `presets/socratic/skills/socratic-tutor/SKILL.md`

**修改**

- `packages/core/src/index.ts`（barrel 再导出）
- `packages/plugin-host/src/tools.ts`（`study_steps` + `study_formats` + `study_wrap_up` + `study_progress` 追加字段 + 导入失败建议接地 + 导入时材料分类落盘）
- `packages/plugin-host/src/storage.ts`（新增 `sessions` 表与域版本 1→2）
- `packages/plugin-host/src/store.ts`（内存与 domain 两种实现都要补 `sessions` 三方法）
- `packages/plugin-host/src/prompt.ts`（context 追加环节/下一步/材料形态/教学模式）
- `packages/plugin-host/src/index.ts`（`/socratic` 命令）
- `packages/plugin-host/tests/plugin.test.ts`（注册、兼容、多格式、零起点、附件路径、复习统计断言）
- `packages/core/tests/stats.test.ts`（复习口径修复的断言）
- `scripts/verify-preset.mjs`、`scripts/verify-install.mjs`、`scripts/dev-link.ps1`
- `README.md`（两个模式的差异表 + 五种教学模式对照表 + 课堂记录说明 + 多格式支持表与"明确不支持"清单）
- `progress.md`、`findings.md`、`task_plan.md`
- `docs/socratic-teaching-mode-ledger.md`（需求台账与自检记录，持续维护）

**不动**

- `packages/ingest/src/**`（62 项真解析真字节测试；缺口都在宿主侧补）
