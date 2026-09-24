# 版本化与在线升级设计（DSH bundle 形态）

> 目标：本包既能**本地开发热重载**，也能作为**可安装、可升级的 bundle** 分发给别人；
> 后期源码推到 GitHub 后，升级路径变成 `git pull` 或 `dsh plugin add <git-url>`。
>
> 本文只写**已取证**的机制与**明确标注为未验证**的假设。措辞遵从本仓库的既有纪律：
> 不把"应该能行"写成"已验"，不把"跳过"写成"通过"。

---

## 一、当前形态（已取证）

| 项 | 事实 | 出处 |
|---|---|---|
| 包身份 | `dsh-study-alongwith-ai`，`type: module`，`version: 0.1.0` | `package.json` |
| bundle 声明 | `dsh.bundle.patch = ./cordis.patch.yml` —— **这就是"能被 `dsh plugin add` 安装"的判据** | `package.json` 的 `dsh` 字段 |
| 补丁内容 | ① 插入插件行 `study-alongwith-ai`（`protocol: false`）；② 给 `agent-presets` 行追加 preset 根（`trust: system`） | `cordis.patch.yml` |
| preset 发布 | 补丁把 `node_modules/dsh-study-alongwith-ai/presets/` 发布为一个 preset 根；根下**每个合法子目录名就是一个模式** | `cordis.patch.yml` + `dsh-agent-presets/lib/types/discovery.js` |
| 发布物 | `files: [lib, presets, cordis.patch.yml, README.md]`；`lib/` 由 `npm run build` 生成（**不随源码发布**） | `package.json`、`scripts/build.mjs` |
| 运行时依赖 | 6 个 peer 全部由 DSH 主机提供（`@deepseek-ai/cordis`、`dsh-tools`、`dsh-storage-domain`、`schemastery`、`zod`，另 `react` 供客户端半边） | `peerDependencies` |

**一个关键约束**：`lib/` 不进版本库（`.gitignore`），所以**从 Git 安装的包没有构建产物**。
`dsh plugin add <git-url>` 之后必须有一次 `npm run build`（或 `prepare` 脚本），
否则 `main: ./lib/plugin-host/index.js` 不存在 —— 这一条是下面"待验证"清单的第一项。

---

## 二、三条安装路径（互斥，别同时开）

### 路径 A：本地开发（当前机器正在用）

`scripts/dev-link.ps1` 建 junction，补丁里写**本地 `.ts` 绝对路径**，`patchReload: live` → 改源码即热重载。

```powershell
cd H:\winmove\project\AI\reasonix-learn-AI-idea\dsh-study-alongwith-AI
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-link.ps1
```

特点：免构建、改代码立刻生效；但依赖本机 Node 的类型剥离，**不适合分发**。

### 路径 B：bundle 安装（推荐给使用者）

```powershell
dsh plugin --profile web add dsh-study-alongwith-ai          # 从 npm（若已发布）
dsh plugin --profile web add <本地绝对路径>                    # 从本地目录
dsh plugin --profile web add <github-url>                    # 从 GitHub（见 §四）
```

`dsh plugin` 会把参数转发给 profile 目录里的 pnpm，并按**安装后状态**调和 `dsh.profile.bundles`：
声明了 `dsh.bundle` 的依赖才进层栈。

**当前验证状态**：`npm run check:install` 每次都会在临时 `DSH_HOME` 里复现同样的落盘状态，
再让**真实 DSH 的装载器**解析本包 —— 这条**已验**（输出 `# == @deepseek-ai/dsh-web-app, patched by dsh-study-alongwith-ai`）。
它验的是"装进去能被解析成一层、两处补丁都落进组合树"，**不含任何 preset 目录内容的断言**。

### 路径 C：不使用（打包给别人时的兜底）

不装插件也能用 `packages/core`（零依赖纯函数）与 `packages/ingest`（自写解析器）——
它们各自有测试，`node --test` 直接跑。适合"我只想要分类/掌握度/SRS 那套逻辑"的场景。

---

## 三、升级回路与**数据安全**

### 3.1 升级动作

| 场景 | 动作 |
|---|---|
| 本地开发 | 改源码即生效（`patchReload: live`），无需动作 |
| 本地路径安装 | `git pull` → `npm run build` → 重启 DSH（或等 live reload） |
| GitHub / npm 安装 | `dsh plugin --profile web remove dsh-study-alongwith-ai` → `add <url>` → 重启 |
| 只想让某一行不挂载 | profile 的 `cordis.patch.yml` 写 `- id: <行 id>` + `disabled: true`（补丁 last-write-wins） |
| 完全卸载 | `dsh plugin --profile web remove dsh-study-alongwith-ai` —— 插件行与 preset 根**一起消失**，不留残骸 |

### 3.2 数据在升级时会不会丢（这是本设计最要紧的一节）

学习数据落在 DSH 的 storage domain `study_alongwith_ai` 上（`DSH_HOME/storages/`）。
会不会丢，取决于**域版本**是否变。以下是**读实现得到的确切语义**（`@deepseek-ai/dsh-storage-json`）：

| 事实 | 出处 | 含义 |
|---|---|---|
| 本域是 `layout: 'per-record'` | `plugin-host/src/storage.ts` | 一条记录一个文件：`<storages>/<domain>/<table>/<key>.json` + `global.json` |
| 每个记录文件都带**版本戳** | `serializeRecord()`（`dsh-storage-json/lib/index.js`） | 形如 `{ version, record }` |
| 读取时**只接受**当前版本 + `compatibleVersions` | `parseRecord()` 的文档注释："Accepted unit versions (the current one plus the descriptor's `compatibleVersions`)" | 不在集合里的戳 → **该记录读作"不存在"** |
| 关键差别：**不接受 = 丢弃，不是迁移** | 同上："an unaccepted version stamp **discards the record instead of migrating it**" | 所以"忘了列 compatibleVersions"会**静默丢数据**，且不会报错 |
| 整单元格式（非 per-record）才抛 `version-mismatch` | `:102` | 本域用的是 per-record，所以**不会**让你看到"版本不符"的错误，只会看到数据变少 |

**结论（决定了 S3.7 必须怎么做）**：

1. 给 domain 加 `sessions` 表时，**必须**同时写 `compatibleVersions: [1]`（版本 2 接受版本 1 的记录）；
2. 否则用户升级后会看到"教材、证据、复习排期全都空了"——**而且是静默的**，没有任何报错；
3. 反过来，只要列了 `compatibleVersions`，旧记录就会被正常读入新版本（无需写迁移代码），
   新增的 `sessions` 表对旧数据而言就是"空表"，这正是我们要的平滑升级。

**因此 S3.7 的交付清单是**：

1. `STUDY_DOMAIN` 加 `sessions` 表、`version: 2`、`compatibleVersions: [1]`；
2. **回归测试**：模拟"v1 数据 + v2 spec"，断言旧记录**仍在**（而不是被丢弃）；
   再加一条**反证**：`compatibleVersions: []` 时旧记录确实读作不存在（证明这条测试真的在防这个坑）；
3. 可读的降级提示：域打不开时日志与 `/study`、`/socratic` 都要明说"数据域不可用，已降级为内存；磁盘数据未改动"。

### 3.3 版本号怎么走

- `package.json.version` 走语义化：**加 preset / 加工具 = minor**，**域版本变化 = major**（因为它影响数据兼容性）。
- 域版本（`STUDY_DOMAIN.version`）只在**表结构变化**时递增；字段追加优先用"新增表"或"新字段可空"，避免不必要的迁移。
- 每次发版在 `CHANGELOG.md` 里写三行：改了什么、**数据是否需要迁移**、怎么回退。
  （`CHANGELOG.md` 属于 S5 交付物；本设计先定规矩。）

---

## 四、GitHub 同步与"从 Git 安装"

### 4.1 同步前的仓库卫生（本计划已处理大半）

| 项 | 状态 |
|---|---|
| `node_modules/`、`lib/`、`.scratch/` 不入库 | ✅ `.gitignore` 已覆盖（`lib/` 与 `.scratch/` 在列） |
| 中文文件编码可被机器检查 | ✅ **已完成**：`check-encoding.mjs` 的扫描根从 `packages`+`scripts` 扩到 `packages`/`scripts`/`presets`/`docs` + 根 `README.md`/`cordis.patch.yml`/`package.json`（实测 52 → **74 个文件**） |
| 名字合法性 | ✅ 包名全小写（`dsh-study-alongwith-AI` → `dsh-study-alongwith-ai` 已修） |
| 发布物完整 | ✅ `files` 含 `lib`/`presets`/补丁/README |
| 影子文件 | ✅ 已清理：`packages/plugin-host/src/index.ts.bak-20260923-140618`（旧版 `inject = ['tools']` 与另一套 `resolveStore`，不以 `.ts` 结尾所以三门都不扫）已删除 —— 它此前会被 `git add` 纳入一起推到 GitHub |

### 4.2 「从 Git 安装」的待验证项（**尚未实测，不写成已支持**）

1. **构建产物**：`lib/` 不入库 → 从 Git 安装后必须先 `npm run build`。
   可选方案：加 `"prepare": "node scripts/build.mjs"`（pnpm 安装 git 依赖时会跑 prepare），
   或让使用者手动构建。**两个方案都未实测**，选定后要写进 README 并在 `check:install` 里加断言。
2. **peer 依赖解析**：本包依赖 6 个 DSH 主机提供的包，从 Git 安装时 pnpm 会不会尝试去 registry 找它们 —— 未实测。
3. **preset 根的路径表达式**：补丁用 `!!js` + `baseUrl` 算 `<profile>/node_modules/<pkg>/presets`，
   在 git 安装（可能落在 `.pnpm` 目录、或软链）下是否仍指向正确目录 —— 未实测。
   `verify-install.mjs` 现在验的是"本地目录 junction"这一种形态。

> **纪律**：以上三条在实测通过前，README 里只能写"路径 A / 路径 B-本地"已验证，
> Git 安装标注为"设计已就绪、实机未验"。这与本仓库既有的"如实标注未验证边界"做法一致。

---

## 五、这套设计对当前批次（S3–S5）的具体要求

| 批次 | 受本设计约束的点 |
|---|---|
| S3 preset | `presets/socratic/` 必须能被**同一个 preset 根**收录（已取证：根下每个合法子目录即一个模式，`order` 取 6）；不改 `cordis.patch.yml` 的 roots 表达式 |
| S3.5 多格式 | 不改 `packages/ingest` 内部（它是零依赖资产，改它等于提高升级风险） |
| S3.6 材料分类 | 材料类型写进 `sourceFormat` 复合值 → **零 migration**（这正是为了避免一次域版本升级） |
| S3.7 课堂记录 | **唯一需要域版本升级的批次** → 必须按 §3.2 交付迁移或明确降级提示 + 回归测试 |
| S4 实机 | 在真实 DSH 里验"装/卸/再装"与"升级后数据仍在" |
| S5 收口 | README 写清三条安装路径、升级动作、数据迁移说明与**未验证边界**；新增 `CHANGELOG.md` |
