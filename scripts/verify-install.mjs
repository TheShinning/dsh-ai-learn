#!/usr/bin/env node
/**
 * 安装形态验证：在**临时 DSH_HOME** 里真的装一遍，看组合结果。
 *
 * ## 为什么这一关不可省
 *
 * 「本包是可安装 bundle」这句话的正确性不由本仓库的任何单元测试保证，而由 DSH 的
 * profile 装载器保证：它要能解析 `dsh.profile.bundles` 里的包名、读出
 * `package.json` 的 `dsh.bundle.patch`、解析那份补丁、并按 `applyEntryPatches`
 * 的语义把它应用到组合树上。这一关就是把这四点跑一遍。
 *
 * ## 安全性
 *
 * 全程使用仓库内 `.scratch/dsh-install-check/` 作为 `DSH_HOME`
 * （`resolveDshHome` 的优先级是「显式配置 → $DSH_HOME → ~/.dsh」，所以临时值会被尊重），
 * 因此**不会碰到用户真实的 harness 目录**。找不到 DSH 安装时本关**跳过并说明**，
 * 而不是假装通过 —— 换一台没有 DSH 的机器 `npm run check` 依然应当可用。
 *
 * ## 子进程 stdio
 *
 * 本环境禁止通过管道捕获子进程输出（EPERM），所以 dump 直接写文件描述符，
 * 不走 pipe。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const APP = process.env.DSH_APP ?? 'D:/sofewar-ai/DeepSeek-harness/DSH Desktop/resources/app'
const BIN = join(APP, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const PACKAGE_NAME = 'dsh-study-alongwith-ai'
const PROFILE = 'verify'

if (!existsSync(BIN)) {
  process.stdout.write(`安装形态验证：跳过（未找到 DSH：${BIN}；用 DSH_APP 指定安装目录）\n`)
  process.exit(0)
}

const SCRATCH = join(ROOT, '.scratch', 'dsh-install-check')
const HOME = join(SCRATCH, 'dshhome')
const PROFILE_DIR = join(HOME, 'profiles', PROFILE)
const failures = []

/** 运行 dsh CLI，stdout/stderr 直接落文件（不经管道）。 */
function runDump(label, extraArgs) {
  const out = join(SCRATCH, `${label}.txt`)
  const fd = openSync(out, 'w')
  const result = spawnSync(process.execPath, [BIN, '--profile', PROFILE, ...extraArgs, '--dump-config'], {
    env: { ...process.env, DSH_HOME: HOME },
    cwd: SCRATCH,
    stdio: ['ignore', fd, fd],
  })
  closeSync(fd)
  if (result.error !== undefined) throw result.error
  return { status: result.status, text: existsSync(out) ? readFileSync(out, 'utf8') : '' }
}

/** 断言 dump 文本里存在某行，返回该行索引（找不到为 -1）。 */
const findLine = (text, needle) => text.split('\n').findIndex((line) => line.includes(needle))

/**
 * 内容断言必须在**归一化空白**后的副本上做：dump 是 YAML，长标量会被折成 `>-`
 * 块（`!!js` 表达式、Windows 路径都会换行），引号也只在必要时才加。
 * 逐行做子串匹配会把这些全都误判成缺失。
 */
const flatten = (text) => text.replace(/\s+/g, ' ')

rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })

// —— 1. 基线：只有内置 bundle ——
const baseline = runDump('dump-baseline', ['--from-default-profile', 'web'])
if (baseline.status !== 0) {
  process.stderr.write(`基线 dump 失败（exit ${String(baseline.status)}）：\n${baseline.text.slice(0, 2000)}\n`)
  process.exit(1)
}
if (findLine(baseline.text, '- id: agent-presets') < 0) {
  failures.push('基线组合里没有 agent-presets 行 —— 本关的前提不成立，后续断言无意义')
}
if (findLine(baseline.text, `- id: study-alongwith-ai`) >= 0) {
  failures.push('基线下就存在 study-alongwith-ai 行 —— 临时 DSH_HOME 没有生效？')
}

// —— 2. 装：清单 + node_modules（等价于 `dsh plugin --profile verify add` 的落盘结果）——
const manifestPath = join(PROFILE_DIR, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.dependencies = { ...(manifest.dependencies ?? {}), [PACKAGE_NAME]: '^0.1.0' }
manifest.dsh = manifest.dsh ?? {}
manifest.dsh.profile = manifest.dsh.profile ?? {}
const bundles = manifest.dsh.profile.bundles ?? []
manifest.dsh.profile.bundles = bundles.includes(PACKAGE_NAME) ? bundles : [...bundles, PACKAGE_NAME]
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

const linkPath = join(PROFILE_DIR, 'node_modules', PACKAGE_NAME)
mkdirSync(join(PROFILE_DIR, 'node_modules'), { recursive: true })
symlinkSync(ROOT, linkPath, 'junction')

// —— 3. 装后再 dump ——
const installed = runDump('dump-installed', [])
if (installed.status !== 0) {
  process.stderr.write(`装后 dump 失败（exit ${String(installed.status)}）：\n${installed.text.slice(0, 3000)}\n`)
  process.exit(1)
}

// —— 4. 断言：bundle 成为一层，且两处补丁都落地 ——
const layer = installed.text.split('\n').find((line) => line.startsWith('# ==') && line.includes(PACKAGE_NAME))
if (layer === undefined) {
  const layers = installed.text.split('\n').filter((line) => line.startsWith('# ==')).join(' | ')
  failures.push(`组合里没有 ${PACKAGE_NAME} 这一层。实际层：${layers}`)
}

const rowIndex = findLine(installed.text, '- id: study-alongwith-ai')
const flat = flatten(installed.text)
if (rowIndex < 0) {
  failures.push('bundle 补丁没有插入 study-alongwith-ai 行')
} else {
  const block = flatten(installed.text.split('\n').slice(rowIndex, rowIndex + 12).join('\n'))
  if (!block.includes(`name: '${PACKAGE_NAME}'`) && !block.includes(`name: ${PACKAGE_NAME}`)) {
    failures.push('插入行的 name 不是本包名')
  }
  if (!block.includes('protocol: false')) failures.push('插入行缺少 protocol: false')
  if (!block.includes('command: true')) failures.push('插入行缺少 command: true')
  if (!block.includes(`packageName: ${PACKAGE_NAME}`)) {
    failures.push('插入行没有 __dshPluginOwner 归属标注 —— 补丁可能不是从本 bundle 层来的')
  }
}

const presetsIndex = findLine(installed.text, '- id: agent-presets')
if (presetsIndex < 0) {
  failures.push('装后组合里找不到 agent-presets 行')
} else {
  const block = flatten(installed.text.split('\n').slice(presetsIndex, presetsIndex + 30).join('\n'))
  if (!block.includes('roots: !!js')) failures.push('agent-presets 行的 roots 不是 !!js 表达式（preset 根补丁未生效）')
  if (!block.includes("URL('node_modules/dsh-study-alongwith-ai/presets/', baseUrl)")) {
    failures.push('roots 的 path 没有按 baseUrl 定位到本包的 presets/')
  }
  if (!block.includes("trust: 'system'") && !block.includes('trust: system')) {
    failures.push('roots 没有声明 trust: system')
  }
  if (!block.includes('default: standard')) failures.push('config 是整体替换，default 必须被写回')
  if (!block.includes('includeShippedRoot: true')) failures.push('config 是整体替换，includeShippedRoot 必须被写回')
  if (!block.includes('includeUserRoot: true')) failures.push('config 是整体替换，includeUserRoot 必须被写回')
  // 跨层 patch 的直接证据：dump 会在这行的层头上标注是谁改的。
  if (!flat.includes(`# == @deepseek-ai/dsh-web-app, patched by ${PACKAGE_NAME}`)) {
    failures.push('组合里没有"agent-presets 行被本 bundle 改过"的层头标注')
  }
}

// —— 4b. preset 根里必须**两个模式都在**（新模式下这一门原先是零覆盖）——
// 补丁把整个 `presets/` 作为 system 信任级根发布，DSH 的 scanRoot() 会把该根下每个合法子目录
// 当成一个 preset（缺 agent.cordis.yml 就会在选择器里显示成 broken 行）。
const presetsDir = join(PROFILE_DIR, 'node_modules', PACKAGE_NAME, 'presets')
if (!existsSync(presetsDir)) {
  failures.push(`preset 根目录不存在：${presetsDir}`)
} else {
  const publishable = readdirSync(presetsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  if (!publishable.includes('study')) failures.push('preset 根里缺少 study 模式')
  if (!publishable.includes('socratic')) {
    failures.push('preset 根里缺少 socratic 模式（苏格拉底教学模式没有被发布出去）')
  }
  for (const id of publishable) {
    if (!existsSync(join(presetsDir, id, 'agent.cordis.yml'))) {
      failures.push(`preset ${id} 缺 agent.cordis.yml —— 选择器会把它显示成损坏行`)
    }
    if (!existsSync(join(presetsDir, id, 'preset.yml'))) {
      failures.push(`preset ${id} 缺 preset.yml（模式选择器里会没有名字与说明）`)
    }
  }
}

// —— 4c. 卸载 → 重装：确认"卸干净、装回来"，这是在线升级的必经动作 ——
// 卸载的定义（README「停用的两种含义」）：从 `dsh.profile.bundles` 层栈里退出，
// 插件行与 preset 根**一起消失**，不留残骸 —— 这正是下面要证明的。
const bundlesNow = (manifest.dsh.profile.bundles ?? []).filter((name) => name !== PACKAGE_NAME)
manifest.dsh.profile.bundles = bundlesNow
writeFileSync(join(PROFILE_DIR, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

const removed = runDump('dump-removed', [])
if (removed.status !== 0) {
  failures.push(`卸载后 dump 失败（exit ${String(removed.status)}）`)
} else {
  if (removed.text.includes(`# == ${PACKAGE_NAME}`)) {
    failures.push('卸载后组合里**仍然**有本包这一层（层栈没有真正退出）')
  }
  if (findLine(removed.text, '- id: study-alongwith-ai') >= 0) {
    failures.push('卸载后插件插入行仍然存在 —— 卸载必须不留残骸')
  }
  if (flatten(removed.text).includes(`${PACKAGE_NAME}/presets/`)) {
    failures.push('卸载后 agent-presets 的 roots 仍指向本包 —— preset 根没有随 bundle 一起退出')
  }
  // 卸载后 preset 目录本身可以留在 node_modules 里（那是 pnpm 的事），但**组合树里不能再引用它**
}

// 装回来：证明"卸载→重装"是幂等的（作者反复调试时的常见动作）
manifest.dsh.profile.bundles = [...bundlesNow, PACKAGE_NAME]
writeFileSync(join(PROFILE_DIR, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
const reinstalled = runDump('dump-reinstalled', [])
if (reinstalled.status !== 0) {
  failures.push(`重装后 dump 失败（exit ${String(reinstalled.status)}）`)
} else {
  if (!reinstalled.text.includes(`# == ${PACKAGE_NAME}`)) failures.push('重装后组合里没有本包这一层')
  if (findLine(reinstalled.text, '- id: study-alongwith-ai') < 0) failures.push('重装后插件插入行不见了')
  if (!flatten(reinstalled.text).includes(`${PACKAGE_NAME}/presets/`)) failures.push('重装后 preset 根没有回来')
}

// —— 5. `!!js` 表达式本身：算出来是不是对的路径，以及会不会把整行带崩 ——
// 上面证明的是"表达式进了组合树"；这一步证明"表达式算出来的东西是对的"。
// 求值方式与 loader 逐字一致（cordis-plugin-loader lib/types/config/utils.js）：
//   const evaluate = new Function('ctx', 'expr', `with (ctx) { return eval(expr) }`)
// 因此 `baseUrl` 经 `with (ctx)` 解析 —— 这是"bundle 安装位置不固定"能成立的全部依据。
const patchText = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
const payload = /roots:\s*!!js\s*"(.*)"[ \t]*$/m.exec(patchText)
if (payload === null) {
  failures.push('cordis.patch.yml 里找不到 roots 的 !!js 表达式')
} else {
  const evaluate = new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }')
  const baseUrl = pathToFileURL(`${PROFILE_DIR}/`).href
  const expectedPath = join(PROFILE_DIR, 'node_modules', PACKAGE_NAME, 'presets')
  try {
    const value = evaluate({ baseUrl }, payload[1])
    if (!Array.isArray(value) || value.length !== 1) {
      failures.push(`roots 表达式应返回恰好 1 个根，实际 ${JSON.stringify(value)}`)
    } else {
      // 比较**解析后的目录**而不是字符串：file URL 的 pathname 是正斜杠且带尾斜杠
      // （`H:/.../presets/`），Windows 上完全合法，agent-presets 内部也会再过一次 resolve()。
      if (resolve(String(value[0].path)) !== resolve(expectedPath)) {
        failures.push(`roots 路径应解析到 ${expectedPath}，实际 ${String(value[0].path)}`)
      }
      if (value[0].trust !== 'system') failures.push(`roots 的 trust 应为 system，实际 ${String(value[0].trust)}`)
      if (!existsSync(value[0].path)) failures.push(`roots 路径在磁盘上不存在：${String(value[0].path)}`)
    }
  } catch (error) {
    failures.push(`roots 的 !!js 表达式求值抛错：${error.message}`)
  }
  // 退化路径：`baseUrl` 缺失时必须退化成空 roots（"没有伴学模式"），
  // 而不是抛错 —— 那会让整行 agent-presets 加载失败，连标准模式一起带走。
  try {
    const degraded = evaluate({}, payload[1])
    if (!Array.isArray(degraded) || degraded.length !== 0) {
      failures.push(`baseUrl 缺失时应退化成空 roots，实际 ${JSON.stringify(degraded)}`)
    }
  } catch (error) {
    failures.push(`baseUrl 缺失时表达式抛错（应当优雅退化）：${error.message}`)
  }
}

// —— 结果 ——
if (failures.length > 0) {
  process.stderr.write(`安装形态验证失败，${failures.length} 个问题：\n`)
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`)
  process.stderr.write(`  证据留在 ${join('.scratch', 'dsh-install-check')}\n`)
  process.exit(1)
}
process.stdout.write(
  `安装形态验证通过：DSH 把本包解析成一层 bundle，两处补丁（插件行 + preset 根）都已落进组合树。\n`,
)
