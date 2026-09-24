# 苏格拉底教学模式 · 需求台账与自检记录

> 用途：把用户提出的**每一条需求**与计划的**具体落点**一一对上，并记录自检发现（遗漏 / 矛盾 / 未验证假设）。
> 规则：台账里每一行都必须能回答"这条需求落在哪个文件、由哪条验收判它成立"。对不上的，就是遗漏，必须显式列出来。
>
> 关联文档：[落地计划](socratic-teaching-mode-plan.md) ｜ 批次与硬约束见仓库根 `task_plan.md`

---

## 一、需求台账（需求 → 落点 → 验收）

> 需求编号 `R-` 为用户明确提出的；`S-` 为工程自检衍生（不是用户要求，但不做就会出问题）。

| 编号 | 需求（用户原话要点） | 落点（文件 / 模块） | 验收 | 状态 |
|---|---|---|---|---|
| R1 | 一步一步启发式引导 | `core/src/pedagogy/step.ts`（六环节状态机）+ `study_steps` 工具 | 验收 1、5 | 计划中 |
| R2 | 让学生学习知识（不是只反问） | `step.ts` 的 `mayRevealAnswer` + `depthDirective()` 深度 3 直讲；`prompt.ts` 协议第 2 条 | 验收 1、17 | 计划中 |
| R3 | 及时复习 | `core/src/review/plan.ts` + `shouldInterrupt()` + ⑥ 环节插入规则 | 验收 3 | 计划中 |
| R4 | 了解学习进度 | `masteryFromEvidence()` + `growth/stats.ts` + `study_progress` 追加字段 + `/socratic` 命令 | 验收 6 | 计划中 |
| R5 | 闪卡等知识测试功能 | `review/cards.ts`（四类卡）+ `pedagogy/quiz.ts` 的 `nextQuizKind()` + 模式 `cardBias` | 验收 4、15 | 计划中 |
| R6 | 生成课堂记录 | `core/src/records/classroom.ts` + `sessions` 表 + `study_wrap_up` + Markdown 落盘 | 验收 11、13、14 | 计划中 |
| R7 | 记录学习过程 + 不完善的点 | `core/src/records/gaps.ts` 四类归因 + `steps` 留痕参数 + 证据 id 引用 | 验收 11、12 | 计划中 |
| R8 | 按教材类型自适应教学模式（规章条例 / 大学教材 / 刷题…） | `core/src/pedagogy/material.ts`（分类）+ `strategy.ts`（五种模式策略表） | 验收 15–17 | 计划中 |
| R9 | 支持多种格式输入 | 复用 `packages/ingest` + `study_formats` + 失败建议接地 + `formatDirective()` | M1–M6 | 计划中 |
| S1 | 新 preset 必须被 loader 方言验证 | `scripts/verify-preset.mjs` 改遍历 + `presets/socratic/` | 验收 8 | 计划中 |
| S2 | 新 preset 必须在 dev 模式下可见 | `scripts/dev-link.ps1` 改遍历 | 验收 8、10 | 计划中 |
| S3 | 伴学模式零回归 | 只增量：新工具 / schema 只增字段 | 验收 7 | 计划中 |
| S4 | 输出 schema 追加字段不破坏既有调用 | `study_progress` 只增字段 | 验收 6 | 计划中 |
| S5 | 首次使用（无任何教材）也能开始 | `study_steps` 零起点动作 + `SKILL.md` 第一步 | 验收 18 | **本轮补入计划** |
| S6 | 用户把文件拖进对话（附件句柄路径）也能导入 | `study_import_textbook` 接受句柄路径 + 失败时如实说明 | 验收 19 | **本轮补入计划** |
| S7 | 记录在真实运行里看得见（不依赖未验证的浏览器渲染） | Markdown 落盘 + `/socratic` 文本输出 | 验收 20 | **本轮补入计划** |
| S8 | 复习统计不是"死接线" | `buildStudyStats()` 增加证据来源的复习口径 | 验收 21（F1/F2） | **本轮补入计划** |

---

## 二、自检发现（遗漏与风险）

> 本节由本轮自检产出，逐条记录**发现 → 影响 → 处置**。未处置的必须写明原因。

### 甲、自查发现（无需外部核验，证据已在本轮读取范围内）

#### F1【高】`reviewHistory` 是死接线：复习统计在真实运行里恒为空

- 证据：`packages/core/src/growth/stats.ts:57` 声明 `FlashcardLike.reviewHistory?`，`:117-120` 用它统计"已复习卡"与"复习天数"；
  而生产调用点 `packages/plugin-host/src/tools.ts:407` 写的是 `flashcards: cards.map((card) => ({ id: card.id, reviewHistory: [], srs: card.srs }))` —— **恒传空数组**。
- 影响：`study_progress` 报告里的「已复习卡」恒为 0、「复习天数」恒为 0。真实复习数据其实存在（`srs.practiceCount / lastReviewedAt`，以及 `kind === 'srs-review'` 的证据行），但没有被这条路读到。
- 处置：① 课堂记录的"今日复习"一律**从 `srs-review` 证据行推导**（纯函数、已有时间戳），不依赖 `reviewHistory`；
  ② `buildStudyStats()` 增加一条兼容的复习来源（以证据行为准，`reviewHistory` 保留为可选），并在本计划 S1 里加"复习统计不为 0"的断言；
  ③ 在 S5 的 README 里如实说明该指标的历史口径。**不得**只改测试夹具让它变绿。

#### F2【中】同类盲区：core 测试全绿但生产接线是空的

- 证据：`packages/core/tests/stats.test.ts:48-49` 用手写的 `reviewHistory` 夹具断言通过；生产侧（F1）不传。
- 影响：这正是本项目 README 记录的头号教训（"组件没挂载但测试通过"）在**数据层**的复现。
- 处置：本计划新增的每个纯函数模块，除单测外**必须**有一条"生产调用点确实把数据传进来了"的静态或集成断言（验收 11/13 已含证据 id 可回溯，这里再补一条复习统计）。

#### F3【中】零起点路径在计划里是空白

- 现状：计划的流程起点是"已有教材的节点"，但首次使用（没有任何教材）是最常见的入口。
- 处置：`study_steps` 在无教材/空图谱时**必须**返回"零起点"动作（导入材料 / 粘贴正文 / 直接说一个想学的知识点），而不是报错或返回空对象；写入验收清单与 `SKILL.md` 第一步。

#### F4【中】"把文件发给模型"这条真实路径没被覆盖

- 背景：DSH 对 PDF/docx **没有原生内容块**（README 已取证：内容块只有 text/image/file/tool-result，file 块会被投影成一句句柄文本）。
- 影响：用户在 GUI 里拖入一份 PDF 时，模型拿到的是**路径句柄**，不是正文。计划的导入口只写了"传路径"，没有写"从附件/句柄路径导入"，也没写这条失败时怎么如实说明。
- 处置：`study_import_textbook` 接受 `path` 时**同时接受工作区相对路径与附件句柄路径**；两者都解析不到就明确报"我拿到的是句柄不是正文，请确认路径或直接粘贴正文"，并列出受支持格式；`study_formats` 报告里写明"PDF 等格式必须给路径，不能只给附件"。

#### F5【低】客户端窗口仍是源码层，未在真实浏览器渲染过

- 证据：`docs/ui-windows.md:85-86` 明确标注"模块契约已验，真实浏览器渲染未验"，学习记录窗口当前只是 `/study` 文本 + 会话事件的 MVP 设想。
- 影响：如果课堂记录只存在于 `sessions` 表里，用户在本机**看不到**它。
- 处置：课堂记录的**主要交付物是 Markdown 文件**（`.study/records/*.md`，工作区内可读可 diff）+ `/socratic` 文本输出；`sessions` 表是数据源。**不把"浏览器里能看见"写进本计划的验收**（那条留给客户端半边单独一批）。

#### F6【低】"同一条证据两个结论"的老病，有两个新入口

- 风险点一：`errorType` 由模型判定 → 需要显式标为"模型的判断，不是系统测量"（与 `Metric<T>` 的诚实约束一致）。
- 风险点二：新写的 `answerToEvidence()` 若自己另定一套正向/语气判定，就会重现原系统"写入路径与重放路径不对称"。
- 处置：`answerToEvidence()` 的输出必须经 `evidenceTone()` 与 `isPositiveEvidence()` 的语义（同一处定义），并在 `quiz.test.ts` 里对同一输入断言二者一致。

#### F7【低】计划的隐含前提没有明说，容易在生产里踩空

- ① `check:structure` 的"未接线值导出"检查在 core 包内生效 → 新模块 `pedagogy/step.ts`、`pedagogy/material.ts`、`records/*.ts` **每一个**都要在 `packages/core/src/index.ts`（barrel）里再导出，否则会被判"未接线"。
- ② `scripts/build.mjs` 是否自动覆盖新目录，需由核验结果确认（见乙节）。
- ③ `scripts/check-encoding.mjs` 是否自动纳入新文件，同样见乙节。
- 处置：S1 开工前先跑一次 `npm run check` 确认基线，再逐个模块落盘并立刻跑 `check:structure`，不留到最后。

### 丁、批次执行状态

| 批次 | 状态 | 实测证据 |
|---|---|---|
| S0 基线 | ✅ **完成** | `npm run check`：六道门全绿，`tests 133 / pass 133 / fail 0`（详见丙节） |
| S1 纯函数层 | ✅ **完成（7/7）** | 7 个新模块 + 6 个测试文件；core 测试 **64 → 131**；全量 **`npm test` 201 通过 / 0 失败**（基线 133，+68）；`check:structure` 31 模块 / 未接线 0 / 孤立包 0；`build` 29 个服务端模块；`check:build` 通过 |
| S2 宿主接线 | ✅ **完成** | 新增 `study_steps` / `study_formats`；导入即分类（复合 `sourceFormat`）；`study_progress` 追加 7 字段（旧 5 字段有兼容断言）+ `reviewEvidence`；context 接通 `step/nextAction/teachingMode/sourceFormat/scenario/errorType`；新增 `/socratic`。全量 **212 通过 / 0 失败**；`check:structure` 未接线 0；`build` 29 模块 |
| S3 preset 与门禁 | ✅ **完成** | `presets/socratic/`（persona + 7 行组合 + `skills/socratic-tutor/SKILL.md`）；`verify-preset.mjs` 改遍历（**原先对新模式零覆盖**）；`check-encoding.mjs` 扩到 `presets/`+`docs/`+根文件（**52 → 78 文件**）；本机两个模式的 dev junction 已就位。六道门全绿，`preset 形态验证通过：2 个模式` |
| S3.5 多格式验收 | ✅ **完成（M1–M6）** | 新增 `packages/plugin-host/tests/formats.test.ts`（**宿主侧**真实文件路径）：七种格式（md / txt / html / 文本层 pdf / docx / odt / epub）逐条导入并从存储读回；五条失败路径（图片 / pptx / 扫描件 PDF / 路径不存在 / 空正文）各自如实说明。**这条测试挖出第三个真 bug**（教材记录形状与持久层不一致） |
| S3.6 材料分类教法 | ✅ **完成** | 分类进导入流程与复合 `sourceFormat`；`study_steps` **每轮**输出"这一轮该问的是…"（`questionBias`）与"降阶阶梯（按顺序）"（`scaffoldLadder`）；快照带 `teachingMode` / `scenario` / `sourceFormat` 供 context 节读取。测试断言条例 vs 真题的**报告内容真的不同**，且跨模式底线（一次一问 / 不给答案）不受材料类型影响 |
| S3.7 课堂记录 | ✅ **完成** | `records.classroom.ts`（记录 + 四类缺口归因 + Markdown 渲染）；domain `version: 2` + **`compatibleVersions: [1]`** + `sessions` 表；`study_wrap_up` 工具（快照 + 落库 + 写工作区 + 如实报告是否写入）；`study_progress` 带最近一次课堂摘要。测试：core 记录 12 项 + 宿主 wrap_up 3 项 + **升级安全 3 项（真实 JSON 后端）** |
| S4 实机/安装验收 | ✅ **机器可验部分全部完成** | `check:install` 覆盖**装 → 卸 → 再装**周期（preset 根含 `study`+`socratic`、卸载不留残骸、重装幂等）；**GitHub 安装通道实测通过**：发布仓库 `TheShinning/dsh-ai-learn` 根即本包，克隆后用真实装载器跑 `verify-build` / `verify-preset` 全绿。⏳ **仅剩使用者目视**：GUI 模式选择器看到「苏格拉底教学模式」并走通一节课 |
| S5 收口 | ✅ **完成** | README（含「从 GitHub 安装」两步 + 实测状态块）；`CHANGELOG.md`；`docs/publishing.md`（实测版）；`docs/versioning-and-upgrade.md`；版本 0.2.0；影子 `.bak` 已删；fork 仓库侧分支 `codex/socratic-teaching-mode`；发布仓库 `main` = `de1fb831cd14b647aefcabcc9b9b3500f1a7fc59` |
| 版本化与在线升级设计 | ✅ 完成 | `docs/versioning-and-upgrade.md`：三条安装路径、升级动作表、**数据安全（按后端真实语义）**、GitHub 同步清单 |
| 发布形态（Git URL / npm） | 🟡 **方案就绪，未验** | 实测发现"Git 子目录安装"不成立（`&path:` 不被 pnpm 识别）；两条可行形态的命令已写进 `docs/publishing.md`，均需一次 GitHub 或 npm 认证才能实测 |
| 版本化与在线升级设计 | ✅ 完成 | `docs/versioning-and-upgrade.md`：三条安装路径、升级动作表、**数据安全（按后端真实语义重写）**、GitHub 同步清单、三条**明确标注未实测**的 Git 安装假设 |

### 新发现的风险清单（核验衍生，按处理状态）

| 编号 | 发现 | 状态 |
|---|---|---|
| C4 | domain `global` schema 拒写半截对象 → "导入过教材后，下次启动数据域打不开"（内存降级 + 不可自愈；**不是**宿主崩溃，见 `findings.md` 的自我更正） | ✅ **已实证 + 已修 + 有回归**（验收项 22） |
| — | **教材记录形状与持久层从未一致**（`revision` 对象 vs 字符串、`parseStatus` 缺失必填）→ 每次导入都写不合法行 → 重启 `invalid-record` | ✅ **本轮挖出 + 已修 + 双层回归**（core 形状契约测试 + 宿主七格式读回） |
| C1 | `check:structure` 抓不到 `capabilities()` 的理由写错（barrel 豁免是全仓库的，测试引用也算接线） | ✅ 已改计划与 findings |
| C2 | `prompt.ts` 的"材料情景/错误类型"两条渲染分支从来没有生产者 | ✅ 已加验收 17b（本计划首次接通） |
| C3 | `schemaNote` 归属错误（domain `global.schema`，不在 `LearnerState`） | ✅ 已改两处文档 |
| C5 | `packages/plugin-host/src/index.ts.bak-20260923-140618` 影子实现（不以 `.ts` 结尾，三门都不覆盖） | ✅ **已清理**（S5：确认无引用后删除；它此前会被 `git add` 一起推到 GitHub） |
| C6 | `selfcheck` 按名字匹配 → 假阴性（标本 `store.ts:19` 的 `emptyLearnerState`） | ✅ 已改为"新增接线必须附独立 grep 证据"，见本节表格 |
| — | 编码体检不扫 `presets/` 与 `docs/` | ⏳ 留 S3 第一件事 |
| — | 缺 DSH 时 `check:preset` / `check:install` 静默通过 | ✅ 已写进风险表（验收必须在有 DSH 的机器上跑） |

### S1 已交付件的接线证据（按 C6 纪律：不拿门禁绿灯当证明）

| 交付件 | 生产者（文件:行号） | 消费者 | 独立 grep 证据 |
|---|---|---|---|
| `nextSocraticMove()` | `core/src/pedagogy/step.ts` | **生产**：`plugin-host/src/tools.ts` 的 `study_steps` | ✅ S2 已接 |
| `answerToEvidence()` / `retellEvidence()` | `core/src/pedagogy/quiz.ts` | **生产**：`study_steps`（`record=true` 时调用 `answerToEvidence`）；`quizIntent`/`quizDirective` 进报告与输出字段 | ✅ S2 已接（`retellEvidence` 供 `answer_kind='retell'` 路径使用，S3.7 课堂记录会进一步消费） |
| `buildReviewPlan()` / `shouldInterrupt()` | `core/src/review/plan.ts` | **生产**：`study_steps`（复习插入判定）与 `study_progress`（到期队列） | ✅ S2 已接 |
| `selectFocusNode()` / `renderFocus()` | `core/src/pedagogy/focus.ts` | **生产**：`study_steps` / `study_progress` | ✅ S2 已接 |
| `classifyMaterial()` / `shouldAskUser()` | `core/src/pedagogy/material.ts` | **生产**：`study_import_textbook`（写入复合 `sourceFormat`）；`index.ts` 的 `/socratic`（`decodeSourceFormat`） | ✅ S2 已接 |
| `strategyFor()` / `modeDirective()` | `core/src/pedagogy/strategy.ts` | **生产**：`study_import_textbook`（`materialDirective`）、`study_progress`（`TEACHING_MODE_LABEL`）、`/socratic` | ✅ S2 已接 |
| `stableEvidenceDigest()` / `EvidenceIdAllocator` | `core/src/knowledge/evidence.ts` | **生产**：`tools.ts` 的两处证据 id 生成 | ✅ S2 新增（第二个真 bug 的修复） |
| `reviewActivity()` | `core/src/review/plan.ts` | **生产**：`core/src/growth/stats.ts` 的 `buildStudyStats({ reviewEvidence })` | ✅ 早已接 |
| `buildStudyStats` 复习口径修复 | `core/src/growth/stats.ts` | **生产**：`tools.ts` 的 `study_progress`（传 `reviewEvidence: graph.evidence`） | ✅ S2 已接（宿主侧补齐） |

> 这张表就是 F2/C6 那条纪律的执行方式：**每条新导出都要写清谁在生产里消费它**。
> S1 结束时六条是 🟡（只被测试引用），S2 结束后全部 ✅ —— 并且每一条都有一条**端到端**断言在
> `plugin-host/tests/plugin.test.ts` 里，而不是只靠 core 单测。

**`npm run check` 结果：六道门全绿，exit code 0**（"133"已由真实测试输出确认，不再只是 README 声明）。

| 门 | 实测输出 | 基线值 |
|---|---|---|
| 编码体检 | `扫描 52 个文件` → 通过（无 BOM / 无替换字符 / 无乱码指纹） | 52 个文件 |
| 结构自检 | `源码模块 25（含测试 42）`；相对导入通过；冒烟导入 **25 通过 / 0 抛错**；未接线值导出 **0**；孤立包 **0** | 25 个源码模块 |
| 构建 | `23 个服务端模块 + 1 个客户端半边 → lib/` | 23 + 1 |
| 产物验证 | 23 个服务端模块可 import，宿主入口与客户端半边形状正确 | — |
| 安装形态 | 真实 DSH 把本包解析成一层 bundle，**两处补丁（插件行 + preset 根）都落进组合树** | 2 处补丁 |
| preset 形态 | loader 方言可解析，**7 行**全部可解析到真实包 | `presets/study/agent.cordis.yml` 7 行 |
| 全量测试 | `tests 133 / pass 133 / fail 0`（用时 1774ms） | **133 项** |

关于"新增模块必须进 barrel"的机制（结构自检原话）：`[3] 接线自检：未接线的值导出 0`
→ 新模块的值导出若既没被 barrel 再导出、也没被其它文件引用，就会在这里报出来。

**两处需要纠正我先前的表述**：

1. 上一版台账写"core 64 + ingest 62 + plugin-host 7 = 133"，测试输出显示 `tests 133` 是**用例数**，与文件数（16）不同；
   S0 起以 `npm test` 的实测用例数为准。
2. **扫描件在本机的失败路径已有测试覆盖，不需要真装 tesseract**：`✔ OCR 解析器：缺 tesseract 时不算可用，被调用也返回依赖不可用而非抛错`
   与 `✔ 外部解析器：依赖缺失时 capability.available=false` 都用**替身命令**跑。
   所以 M5 的验收是"跑测试 + 目视 `study_formats` 报告"，而不是"必须失败一次给人看"。

**其余基线观察**（供 S1/S2 参考）：

- `check:structure` 的 `提示：仅声明处引用的类型 1 —— StudyContextInput`：类型只在声明处被引用会被提示（不是失败）。新增类型若只在自己文件里用，同样会出现提示。
- 现有 `packages/core/tests/stats.test.ts:48-49,59-60` 正是 F1 那条死接线的"绿"，**修复时必须同时改这里**，否则测试会挡住正确实现。
- 基线全程无副作用：`npm run check` 未改动仓库（只重建 `lib/`，该目录在 `.gitignore`）。

### 乙、独立核验结果（子代理①：计划对现有代码的 15 条断言）

> 核验方式：只读代码逐条对证据（`read`/`grep`/`glob`），不运行脚本。
> 结论：**9 条成立、2 条部分成立、0 条不成立**，但抓到 **6 处反例与矛盾**，其中 3 处必须回头改计划。

#### 必须改计划的 3 处

**C1【措辞错误】`check:structure` 为什么抓不到 `capabilities()` —— 我原来的理由是错的**
- 原写法（计划 §3.1"缺口一"）：未接线检查**按包内 barrel** 判定，`capabilities` 在自己的 barrel 里所以放过。
- 实际机制（`scripts/selfcheck.mjs`）：barrel 豁免是**全仓库**的（`:130-135` 收集所有 `export * from` 目标，`:147` 按绝对路径豁免）；
  且"是否被引用"是在**全部文件（含 tests）**里按**名字正则**搜索（`:88-89`、`151-159`）。
  所以即便 `registry.ts` 不是 barrel 目标，`capabilities` 也会因**测试文件的引用**（`packages/ingest/tests/pipeline.test.ts:6,176`）被判"已接线"。
- 结论不变（确实抓不到），**理由已改正**：真正的盲点是"名字匹配而非 import 图"+"测试引用也算接线"。

**C2【事实性补充】`scenario` 与 `errorType` 在 context 里是**死路**：有渲染分支，没有生产者**
- `prompt.ts:96`（材料情景）与 `:102-105`（错误类型）的渲染分支**当前恒不执行**：
  快照的唯一写入点是 `tools.ts:429-435`，其 `contextInput` 只含 `knowledgePoint / probeState / hasConfusedNodes / dueCards`。
- 影响：计划 §二 表格第 6 行、§3c.3 让人以为"材料情景已在 context 里工作"。
  **实际是：苏格拉底模式将是这两条路的首次生产者**（这正是 R8 要补的）。
- 处置：计划 §3c.3 与 §二 表格补注"当前无生产者，由本计划首次接通"；并把"context 里能看到材料情景"写成验收可观察项。

**C3【归属错误】`schemaNote` 不在 `LearnerState`，在 domain 的 `global.schema`**
- 实际：`storage.ts:145`（`global.schema`）与 `:147`（initial），而 `LearnerStateSchema`（`:113-127`）没有该字段。
  我此前把它当成"`LearnerState` 的可空位"，据此论证过一条"零 migration"方案。
- 处置：① 修正 `findings.md` 与台账中的表述；② 材料类型的落点仍用 `textbooks.sourceFormat` 复合值（与 `schemaNote` 无关，结论不变）。

#### 需要新记入风险/任务的 3 处

**C4【高】domain `global` schema 与真实写入形状可能不兼容（**待运行时验证**）**
- `storage.ts:143-147` 的 `global.schema` 把 `activeTextbookKey` 与 `schemaNote` 都当**必需**；
- 而 `store.ts:117-120` 的 `DomainHandle.global` 类型只声明 `activeTextbookKey`，`setActiveTextbook` 只写 `{ activeTextbookKey: key }`（`store.ts:324`）。
- 若 domain 实现按"必需字段缺失即拒绝"，则**设置活动教材这条最基本的路**就可能是坏的。
- 处置：列入 S2 的第一项验证（用真实 `storage.domain` 跑一次 `setActiveTextbook` + `learnerState` 往返）；无论结果如何都写进 findings。

**C5【中】源码树里有一个**影子实现**：`packages/plugin-host/src/index.ts.bak-20260923-140618`（193 行）**
- 它不以 `.ts` 结尾 → selfcheck 不扫（`:59`）、build 不产出（`build.mjs:54`）、测试 glob 不覆盖。
- 影响：任何"按 `*.ts` 说话"的结论都会漏掉这份陈旧副本；它含旧版 `inject = ['tools']` 与另一套 `resolveStore`，容易被误当参考。
- 处置：列入 S5 收口（删除或改名为 `*.bak` 归档目录并说明），本轮先记录，不动它（避免与正在进行的批次混淆）。

**C6【中】selfcheck 的"名字匹配"有真实假阴性标本**
- `packages/plugin-host/src/store.ts:19` 的 `emptyLearnerState` 在文件外**零引用**，本应判"未接线"；
  它躲过的原因是检查按名字全仓库搜索，而 `core/src/textbook/identity.ts:216` 有**同名导出**且被 `core/tests/identity.test.ts` 引用。
- 影响：**新增模块不能只靠 `check:structure` 判"接线了没有"** —— 尤其是我准备新增的 `CardLike` / `ClassroomRecord` / `TeachingMode` 这类容易重名的类型与工厂。
- 处置：新增每条接线后，用**独立的 grep 证据**确认"有生产者 + 有消费者"，把证据写进 `progress.md`；不把 selfcheck 绿灯当作接线证明。

#### 顺带校正的行号

- 计划 §3.1 写"`registry.ts:112` 读字节 → `detectFormat`"稍偏：`detectFormat` 实际在 `registry.ts:98`（`ingestBytes`），`:112` 的 `ingestFile` 是读字节后转调 `:113-114`。已修正。
- 断言 3（`isPracticable()` 四种都 true）判定为**部分成立**：四种都不是按 `kind` 排除，但内容缺失时四种都可能 false（缺题面 / 缺答案 / 选择缺选项）。
  这与计划原意一致（"唯一排除条件是内容完整性"），但表述需精确：不是"对四种都返回 true"，而是"**不因卡片类型而排除**"。

#### 核验未覆盖的项（如实标注）

- 未运行任何脚本 → `check:structure` 的实际输出由我这里另跑的 `npm run check` 覆盖（已确认：未接线 0）。
- domain 真实实现下的 `global` 写入兼容性（C4）**未验证**。
- `.bak` 文件与现役 `index.ts` 的完整差异未逐行 diff。
- `lib/` 只做了针对性 grep（命中均为源码镜像），未逐文件比对产物与源码一致性。

