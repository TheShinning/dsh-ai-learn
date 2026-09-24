#!/usr/bin/env node
/**
 * preset 形态验证：用 **DSH 自己的解析方言**遍历 `presets/*` 逐个检查。
 *
 * ## 为什么单独一关
 *
 * preset 组合文件是**唯一没有被其它闸门覆盖的交付物**：它不是 TypeScript（构建与产物验证
 * 都看不见它），也不是插件代码（测试碰不到它）。而它一旦写错，用户在模式选择器里看到的
 * 是一个"损坏"的条目 —— 官方 `dsh-agent-presets` 的 `compositionProblem()` 会把整个
 * directory 报成 broken row。
 *
 * 本项目已经差点犯过这个错：`skill-filesystem` 行上曾写了 `customSkillDirs: [- !!js ...]`，
 * 依赖 `baseUrl` 在组合文件行的作用域里可用 —— 这一点没有任何先例，一旦求值抛错，
 * 整行加载失败会把伴学模式一起带走。
 *
 * ## 为什么改成遍历（2026-09-23 独立核验发现）
 *
 * 原实现**硬编码 `presets/study`**：新增第二个模式（苏格拉底）时，这一门会**完全不检查它，
 * 也不会失败** —— 也就是"绿灯"，但覆盖为零。而 `dsh-agent-presets` 的 `scanRoot()` 是把
 * root 下**每个匹配 `/^[a-z0-9][a-z0-9-]*$/` 的子目录**都当成一个 preset 的。
 * 所以这一门必须用同一口径遍历，否则新增模式等于没验。
 *
 * 找不到 DSH 安装时**跳过并说明**，不假装通过。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const APP = process.env.DSH_APP ?? 'D:/sofewar-ai/DeepSeek-harness/DSH Desktop/resources/app'
const APP_MODULES = join(APP, 'node_modules')
const INCLUDE = join(APP_MODULES, '@deepseek-ai', 'cordis-plugin-include', 'lib', 'index.js')

if (!existsSync(INCLUDE)) {
  process.stdout.write(`preset 形态验证：跳过（未找到 DSH：${INCLUDE}；用 DSH_APP 指定安装目录）\n`)
  process.exit(0)
}

/** 与 `dsh-agent-presets/lib/types/preset.js` 的 PRESET_ID 保持同一口径。 */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

/** 官方 shipped preset 用掉的 order；本仓库的 preset 必须排在它们之后。 */
const SHIPPED_ORDERS = new Set([1, 2, 3, 4])

/** 这些行名不得出现（工具面收窄：无 shell / 子代理 / 工作流 / plan-mode）。 */
const FORBIDDEN_ROWS = ['dsh-tool-bash', 'dsh-tool-pwsh', 'dsh-plan-mode', 'dsh-tool-subagent', 'dsh-workflow']

const { entryListSchema } = await import(pathToFileURL(INCLUDE).href)

/** 官方 js-yaml 也是从 DSH 安装里取的，避免本仓库多一个依赖。 */
const yamlModule = await import(pathToFileURL(join(APP_MODULES, 'js-yaml', 'index.js')).href)
const yaml = yamlModule.default ?? yamlModule

const failures = []
const check = (presetId, condition, message) => {
  if (!condition) failures.push(`[${presetId}] ${message}`)
}

// —— 0. 找出所有 preset 目录（与 loader 同一口径：目录名匹配 PRESET_ID）——
const presetsRoot = join(ROOT, 'presets')
const presetIds = existsSync(presetsRoot)
  ? readdirSync(presetsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && PRESET_ID.test(entry.name))
      .map((entry) => entry.name)
      .sort()
  : []

if (presetIds.length === 0) {
  failures.push('presets/ 下没有任何合法 preset 目录（目录名须匹配 /^[a-z0-9][a-z0-9-]*$/）')
}

const report = []

for (const presetId of presetIds) {
  const dir = join(presetsRoot, presetId)
  const compositionPath = join(dir, 'agent.cordis.yml')
  const metadataPath = join(dir, 'preset.yml')
  const skillsDir = join(dir, 'skills')

  // —— 1. 展示元数据 ——
  if (!existsSync(metadataPath)) {
    failures.push(`[${presetId}] 缺少 preset.yml（展示元数据）`)
  } else {
    const meta = yaml.load(readFileSync(metadataPath, 'utf8'))
    check(presetId, typeof meta === 'object' && meta !== null && !Array.isArray(meta), 'preset.yml 必须是映射，不是数组')
    check(presetId, typeof meta?.name === 'string' && meta.name.trim() !== '', 'preset.yml 缺少非空 name')
    check(
      presetId,
      typeof meta?.description === 'string' && meta.description.trim() !== '',
      'preset.yml 缺少非空 description（选择器会显示空白）',
    )
    check(presetId, Number.isFinite(meta?.order), 'preset.yml 的 order 必须是有限数字')
    if (Number.isFinite(meta?.order)) {
      check(presetId, !SHIPPED_ORDERS.has(meta.order), `order ${String(meta.order)} 与官方 shipped preset 冲突（已占用 1/2/3/4）`)
    }
  }

  // —— 2. 组合文件：用 loader 的方言解析 ——
  let rows
  if (!existsSync(compositionPath)) {
    failures.push(`[${presetId}] 缺少 agent.cordis.yml —— 这个目录会被选择器报成 broken 行`)
    continue
  }
  try {
    rows = yaml.load(readFileSync(compositionPath, 'utf8'), { schema: entryListSchema })
  } catch (error) {
    failures.push(`[${presetId}] agent.cordis.yml 无法用 loader 方言解析：${error.message.split('\n')[0]}`)
    continue
  }

  // —— 3. 形状：顶层数组，每项是带 name 字符串的映射（官方 entryListProblem 的判据）——
  if (!Array.isArray(rows)) {
    failures.push(`[${presetId}] 组合文件必须是**顶层数组**（YAML 无法在列表旁携带兄弟键，元数据因此放在 preset.yml）`)
    continue
  }

  const seenIds = new Set()
  const names = []
  const walk = (list, at) => {
    for (const [index, entry] of list.entries()) {
      const label = at === '' ? `row ${String(index + 1)}` : `${at} row ${String(index + 1)}`
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        failures.push(`[${presetId}] ${label} 不是映射`)
        continue
      }
      if (typeof entry.name !== 'string' || entry.name.trim() === '') {
        failures.push(`[${presetId}] ${label} 缺少字符串 name —— Loader 不会挂载它`)
        continue
      }
      if (typeof entry.id === 'string') {
        if (seenIds.has(entry.id)) failures.push(`[${presetId}] 行 id 重复：${entry.id}（同一个 id 挂载两次是本项目踩过的坑）`)
        seenIds.add(entry.id)
      }
      names.push(entry.name)
      // 组：`group: true` 时 config 是嵌套的条目列表，按同一规则递归。
      if (entry.group === true) {
        if (!Array.isArray(entry.config)) failures.push(`[${presetId}] ${label}（${entry.name}）声明了 group 但 config 不是数组`)
        else walk(entry.config, entry.id === undefined ? label : String(entry.id))
      }
    }
  }
  walk(rows, '')

  // —— 4. 每一行的包名都要真的能解析（官方 rowResolves 的判据）——
  for (const name of names) {
    if (name.startsWith('cordis:')) continue // 内置（cordis:group / cordis:include）
    if (name.startsWith('.')) {
      failures.push(`[${presetId}] 行名 ${name} 是相对说明符：相对 preset 目录解析，本仓库的 preset 不用这种形式`)
      continue
    }
    if (!existsSync(join(APP_MODULES, name, 'package.json'))) {
      failures.push(`[${presetId}] 行名 ${name} 在 DSH 安装里解析不到 —— 选择器会把这个 preset 报成损坏`)
    }
  }

  // —— 4b. 每一行的 **config 必须通过它自己的 schema** ——
  //
  // 这一条是补的，起因是一个真实故障（2026-09-28，使用者截图）：
  //   切换到「伴学模式」时报
  //     failed to apply loader entry tool-fs-search: invalid config:
  //     $.sampleOverCapGlobResults missing required value
  //   —— `@deepseek-ai/dsh-tool-fs-search` 的 `Config.sampleOverCapGlobResults` 是
  //   `z.boolean().required()`（**没有默认值**），而两个 preset 的行都没写 config。
  //   "行名能解析"这一门当时是绿的，但**模式一挂载就失败**。
  //
  // 校验方式与 cordis 逐字一致：`resolveConfig()` 用的是 standard-schema 接口
  //   `runtime.Config['~standard'].validate(config)` → 有 `issues` 即失败。
  for (const [index, entry] of rows.entries()) {
    if (typeof entry?.name !== 'string' || entry.name.startsWith('cordis:')) continue
    const entryPath = join(APP_MODULES, entry.name, 'lib', 'index.js')
    if (!existsSync(entryPath)) continue // 上面第 4 步已经报过"解析不到"
    let mod
    try {
      mod = await import(pathToFileURL(entryPath).href)
    } catch (error) {
      failures.push(
        `[${presetId}] 行 ${String(entry.id ?? index + 1)}（${entry.name}）无法导入，config 未校验：${error.message.split('\n')[0]}`,
      )
      continue
    }
    const standard = mod.Config?.['~standard']
    if (standard === undefined || typeof standard.validate !== 'function') continue // 该行没有 config schema
    const result = standard.validate(entry.config ?? {})
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') continue // 异步校验不支持
    for (const issue of result?.issues ?? []) {
      failures.push(
        `[${presetId}] 行 ${String(entry.id ?? index + 1)}（${entry.name}）的 config 不合法：` +
          `${issue.message}${issue.path ? ` (at ${issue.path.join('.')})` : ''} —— 这一行会让整个模式加载失败`,
      )
    }
  }

  // —— 5. 教学协议必须真的在 persona 里（这是缺陷 1 的修法落点）——
  const persona = rows.find((row) => row?.id === 'persona')
  if (persona === undefined) {
    failures.push(`[${presetId}] 组合里没有 persona 行 —— 教学协议就无处安放（缺陷 1 的修法落点没了）`)
  } else {
    check(
      presetId,
      persona.name === '@deepseek-ai/dsh-persona',
      `persona 行的 name 应为 @deepseek-ai/dsh-persona，实际 ${String(persona.name)}`,
    )
    const prefix = persona.config?.prefix
    check(
      presetId,
      typeof prefix === 'string' && prefix.trim().length > 100,
      'persona.prefix 缺失或过短 —— 教学协议是本模式的核心，不能是空壳',
    )
  }

  // —— 6. 工具面收窄 ——
  for (const name of names) {
    for (const bad of FORBIDDEN_ROWS) {
      if (name.includes(bad)) {
        failures.push(`[${presetId}] 不该挂 ${name}（工具面应保持收窄：无 shell / 子代理 / 工作流 / plan-mode）`)
      }
    }
  }

  // —— 7. 插件本体由宿主级挂载提供（bundle 补丁的插入行），组合里不该重复挂 ——
  if (names.includes('dsh-study-alongwith-ai')) {
    failures.push(`[${presetId}] 组合里挂了 dsh-study-alongwith-ai —— 它与 bundle 补丁的插入行是同一个 id，会挂载两次`)
  }
  // 同一 id 被两个 preset 重复挂载同样危险
  if (names.includes('study-alongwith-ai')) {
    failures.push(`[${presetId}] 组合里挂了 study-alongwith-ai（宿主插件行 id）—— 会与 bundle 补丁的插入行重复挂载`)
  }

  // —— 8. 技能文件真的在随包目录里（不硬编码技能名：preset 可能带多个技能）——
  if (!existsSync(skillsDir)) {
    failures.push(`[${presetId}] 缺少 skills/ 目录 —— preset 自带的技能应随目录发布`)
  } else {
    const skillFiles = []
    for (const packageDir of readdirSync(skillsDir)) {
      const skillPath = join(skillsDir, packageDir, 'SKILL.md')
      if (existsSync(skillPath) && statSync(skillPath).isFile()) skillFiles.push(join('presets', presetId, 'skills', packageDir, 'SKILL.md'))
    }
    if (skillFiles.length === 0) failures.push(`[${presetId}] skills/ 下没有任何 <name>/SKILL.md`)
    for (const file of skillFiles) {
      const body = readFileSync(join(ROOT, file), 'utf8')
      check(presetId, body.trim().length > 200, `技能文件内容过短（${file}）`)
    }
    report.push(`  - ${presetId}：${String(rows.length)} 行，技能 ${skillFiles.map((file) => file.split(/[\\/]/)[3]).join('、')}`)
  }
}

// —— 9. 本仓库应当同时提供「伴学」与「苏格拉底教学」两个模式 ——
if (presetIds.length === 1 && presetIds[0] === 'study') {
  failures.push('只发现 study 一个 preset —— 本仓库应同时发布 study 与 socratic（新增模式必须被这一门覆盖）')
}

if (failures.length > 0) {
  process.stderr.write(`preset 形态验证失败，${String(failures.length)} 个问题：\n`)
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`)
  process.exit(1)
}
process.stdout.write(`preset 形态验证通过：${String(presetIds.length)} 个模式，组合文件用 loader 方言可解析。\n`)
for (const line of report) process.stdout.write(`${line}\n`)
