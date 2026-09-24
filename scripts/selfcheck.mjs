#!/usr/bin/env node
/**
 * 仓库自检：干三件原系统栽过跟头的事。
 *
 * ## 1. 相对导入完整性（fatal）
 *
 * 每个源文件里的相对 import 必须真实存在。这条抓的是最蠢也最贵的错：
 * 层级写错（`../../../core` 而不是 `../../core`）在编辑器里看不出来，
 * 只有真正加载时才炸。原仓库的桥接层就出现过"类型对、路径错"的组合。
 *
 * ## 2. 冒烟导入（fatal for relative, warning for peer）
 *
 * 用 Node 原生类型剥离真正 import 每个模块，暴露 Node **不支持**的语法：
 * `enum`、带运行时代码的 `namespace`、构造函数参数属性、装饰器。
 * 裸包名（`react`、`@deepseek-ai/*`）在本仓库没安装，那属于**主机提供的 peer**，
 * 只记为环境提示，不算失败。
 *
 * ## 3. 接线自检（fatal）
 *
 * 原系统最贵的一课是"定义了但没有任何调用者"：`LearningWorkspace.tsx` 整棵树没有
 * importer，连带 Header / Toolbar / FocusHud / ClassroomPanel / StudioPanel /
 * AssetsPanel 全部不可达，于是"节奏条统一"与"证据点亮脉冲"有发射无接收；
 * `recordMetacognitionReflection()`、`sortFlashcardsByDuePriority()` 只有定义；
 * `_llmScorer` 参数从未被调用。
 *
 * 判据：值导出（const/function/class）若既**没有**被任何 barrel（`export * from`）
 * 再导出，又**没有**在其它文件里被引用，即视为未接线。
 * 类型/接口导出只做提示（它们本来就可能只在声明处出现）。
 *
 * 退出码：0 通过；1 有 fatal 项。
 */

import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = fileURLToPathRoot()
const PACKAGES = join(ROOT, 'packages')

function fileURLToPathRoot() {
  const url = new URL('..', import.meta.url).pathname
  const decoded = decodeURIComponent(url)
  return decoded.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '')
}

async function collect(dir, filter) {
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.scratch') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await collect(full, filter)))
    else if (entry.name.endsWith('.ts') && filter(full)) out.push(full)
  }
  return out
}

const isTest = (p) => /[\\/]tests[\\/]/.test(p)
/**
 * import specifier 的抽取必须**锚定行首**。
 * 早先版本用 `/(?:from|import)\s*'…'/` 无锚定，把 pdf.ts 测试夹具里的
 * PDF 内容（`from '%PDF-1.4…'` 之类）也当成依赖，污染了环境提示。
 */
const IMPORT_PATTERNS = [
  /^[ \t]*import[^\n]*?from[ \t]*'([^']+)'/gm,
  /^[ \t]*import[ \t]*'([^']+)'/gm,
  /^[ \t]*export[^\n]*?from[ \t]*'([^']+)'/gm,
]
const EXPORT_RE = /^export\s+(?:async\s+)?(const|function|class|type|interface)\s+([A-Za-z_$][\w$]*)/gm
const BARREL_RE = /^export\s+\*\s+from\s+'([^']+)'/gm

/**
 * cordis 插件元数据导出：由宿主按**模块命名空间**读取，不会被任何文件按名 import。
 * 把它们排除在接线自检之外，否则每个插件都会误报。
 */
const PLUGIN_METADATA = new Set(['name', 'inject', 'apply', 'Config', 'provide', 'intercept', 'reusable'])

const allSource = (await collect(PACKAGES, () => true)).sort()
const modules = allSource.filter((p) => !isTest(p))

/** 读取 + 解析 import specifier。 */
const texts = new Map()
for (const file of allSource) texts.set(file, await readFile(file, 'utf8'))

// —— 1. 相对导入完整性
const missingRelative = []
const missingExternal = new Set()
for (const file of allSource) {
  const text = texts.get(file)
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const spec = match[1]
      if (spec.startsWith('.')) {
        const target = resolve(dirname(file), spec)
        if (!existsSync(target)) missingRelative.push({ file: relative(ROOT, file), spec, target: relative(ROOT, target) })
      } else if (!spec.startsWith('node:')) {
        // 裸包名：本仓库没装，属主机 peer；只记录
        missingExternal.add(spec)
      }
    }
  }
}

// —— 2. 冒烟导入
// 判定：只有"相对导入失败"与"求值/语法错误"才算失败；
// "Cannot find package '<裸包名>'"是主机 peer 未安装，属环境，不计失败。
const isPeerMiss = (message) => /^Cannot find package '([^']+)'/.test(message)
const smokeFailures = []
const smokePeerMisses = []
for (const file of modules) {
  const hasBadRelative = missingRelative.some((item) => item.file === relative(ROOT, file))
  if (hasBadRelative) continue
  try {
    await import(pathToFileURL(file).href)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const record = { file: relative(ROOT, file), message }
    if (isPeerMiss(message)) smokePeerMisses.push(record)
    else smokeFailures.push(record)
  }
}

// —— 3. 接线自检（barrel 识别）
const barrelTargets = new Set()
for (const file of allSource) {
  for (const match of texts.get(file).matchAll(BARREL_RE)) {
    if (match[1].startsWith('.')) barrelTargets.add(resolve(dirname(file), match[1]))
  }
}

const exportsByFile = new Map()
for (const file of modules) {
  const found = []
  for (const match of texts.get(file).matchAll(EXPORT_RE)) found.push({ kind: match[1], name: match[2] })
  exportsByFile.set(file, found)
}

const unwired = []
const typeOnly = []
for (const [file, exports] of exportsByFile) {
  const isPublicViaBarrel = barrelTargets.has(resolve(file))
  for (const item of exports) {
    if (isPublicViaBarrel) continue
    if (PLUGIN_METADATA.has(item.name)) continue
    const pattern = new RegExp(`\\b${item.name.replace(/\$/g, '\\$')}\\b`)
    let referenced = false
    for (const [other, text] of texts) {
      if (other === file) continue
      if (pattern.test(text)) {
        referenced = true
        break
      }
    }
    if (referenced) continue
    if (item.kind === 'type' || item.kind === 'interface') typeOnly.push({ file: relative(ROOT, file), name: item.name })
    else unwired.push({ file: relative(ROOT, file), name: item.name, kind: item.kind })
  }
}

// —— 4. 孤立包自检
// 这一门是为了堵住本项目真实发生过的一次漏洞：`packages/ingest` 写完了、62 项测试全绿，
// 但**没有任何包引用它**，于是"多格式摄取"根本没接到对话上。
// 第 [3] 门抓不到它 —— ingest 的 index.ts 是 barrel（`export *`），
// 被判成"已对外公开"就放过了。跨包可达性必须单独查。
const ENTRY_PACKAGES = new Set(['plugin-host', 'plugin-ui'])
const packageDirs = []
try {
  for (const entry of await readdir(PACKAGES, { withFileTypes: true })) {
    if (entry.isDirectory()) packageDirs.push(entry.name)
  }
} catch {
  /* 无 packages 目录 */
}

const isolatedPackages = []
for (const pkg of packageDirs) {
  // 只检查**代码包**：没有任何 .ts 的包（例如只放 Markdown 的技能包）不参与可达性判断。
  const hasCode = [...texts.keys()].some((file) => {
    const rel = relative(ROOT, file).split('\\').join('/')
    return rel.startsWith(`packages/${pkg}/`) && rel.endsWith('.ts')
  })
  if (!hasCode) continue

  if (ENTRY_PACKAGES.has(pkg)) continue
  const marker = `/packages/${pkg}/`
  const referenced = [...texts.keys()].some((file) => {
    const rel = relative(ROOT, file).split('\\').join('/')
    if (rel.startsWith(`packages/${pkg}/`)) return false
    for (const pattern of IMPORT_PATTERNS) {
      for (const match of texts.get(file).matchAll(pattern)) {
        if (!match[1].startsWith('.')) continue
        const target = resolve(dirname(file), match[1]).split('\\').join('/')
        if (target.includes(marker)) return true
      }
    }
    return false
  })
  if (!referenced) isolatedPackages.push(pkg)
}

// —— 报告
const line = (t) => process.stdout.write(`${t}\n`)
line('=== 伴学插件生态自检 ===')
line(`源码模块 ${modules.length}（含测试 ${allSource.length}）`)

line(`\n[1] 相对导入完整性：${missingRelative.length === 0 ? '通过' : `${missingRelative.length} 处缺失`}`)
for (const item of missingRelative) line(`  ✖ ${item.file}\n    '${item.spec}' → ${item.target}`)

line(`\n[2] 冒烟导入：${modules.length - smokeFailures.length - missingRelative.length - smokePeerMisses.length} 通过 / ${smokeFailures.length} 抛错`)
for (const item of smokeFailures) line(`  ✖ ${item.file}\n    ${item.message}`)
line(`  环境提示：${smokePeerMisses.length} 个模块因缺少主机 peer 而无法求值（不计失败）`)
line(`  环境提示：${missingExternal.size} 个 peer 包未在本仓库安装（由 DSH 主机提供）`)
line(`    ${[...missingExternal].sort().join(', ')}`)

line(`\n[3] 接线自检：未接线的值导出 ${unwired.length}`)
for (const item of unwired) line(`  ✖ ${item.kind} ${item.name}  ← ${item.file}`)

line(`\n提示：仅声明处引用的类型 ${typeOnly.length}`)
if (typeOnly.length > 0) line(`    ${typeOnly.map((t) => t.name).join(', ')}`)

line(`\n[4] 孤立包自检：${isolatedPackages.length === 0 ? '通过' : `${isolatedPackages.length} 个包没有任何引用方`}`)
for (const pkg of isolatedPackages) {
  line(`  ✖ packages/${pkg} 写完了但没被任何包引用（入口包 ${[...ENTRY_PACKAGES].join(' / ')} 除外）`)
}

const failed =
  missingRelative.length > 0 || smokeFailures.length > 0 || unwired.length > 0 || isolatedPackages.length > 0
line(`\n结论：${failed ? '未通过' : '通过'}`)
process.exit(failed ? 1 : 0)
