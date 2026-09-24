#!/usr/bin/env node
/**
 * 构建：把 `packages/<pkg>/src/**\/*.ts` 逐文件剥离类型，输出到 `lib/<pkg>/**\/*.js`。
 *
 * ## 为什么不用打包器
 *
 * 本仓库所在环境不可执行 esbuild / tsx / vite / tsdown（沙箱 EPERM），而 Node 24
 * 自带 `module.stripTypeScriptTypes`。于是构建退化为一件很窄的事：**删掉类型标注**。
 * 剩下的工作只有两件，两件都必须显式做对：
 *
 * 1. **改写相对说明符 `.ts` → `.js`**。源码里写的是显式 `.ts` 后缀（Node ESM 要求
 *    显式后缀），剥离类型不会动说明符，所以必须自己按"源路径 → 输出路径"重算。
 *    `packages/<pkg>/src/<rest>.ts` 映射到 `lib/<pkg>/<rest>.js`，因此跨包引用
 *    （如 `../../core/src/index.ts`）的相对深度会变，必须重新计算而不是字符串替换。
 *
 * 2. **把客户端半边包成 ModuleLoader 工厂**。契约取自两个真实第三方插件产物
 *    （`dsh-better-sidebar/lib/client.js`、`@linxin666/dsh-client-ui-skill-explorer/lib/client.js`），
 *    两者逐字一致：一个 IIFE 里 `window.__ModuleLoader__.load({ id, factory })`，
 *    工厂内建 `module.exports`，裸说明符改用 `require(...)`。
 *
 * ## 有意为之的边界
 *
 * 客户端变换**不是**通用 ESM→CJS 转换器，只接受一个受约束子集：
 * 只有裸说明符导入、只有 `export const` / `export function` / `export interface`(已剥离)。
 * 出现 `export default`、相对导入、或任何未识别形态一律**报错退出** —— 宁可构建失败，
 * 也不产出悄悄坏掉的浏览器半边。
 */

import { stripTypeScriptTypes } from 'node:module'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC_ROOT = join(ROOT, 'packages')
const OUT_ROOT = join(ROOT, 'lib')

/** 服务端半边参与构建的包；`plugin-ui` 只贡献浏览器半边，单独走客户端变换。 */
const SERVER_PACKAGES = ['core', 'ingest', 'plugin-host']
/** 客户端半边的源码与输出位置。 */
const CLIENT_SOURCE = join(SRC_ROOT, 'plugin-ui', 'src', 'client', 'index.ts')
const CLIENT_OUTPUT = join(OUT_ROOT, 'client.js')
const CLIENT_ID = 'dsh-study-alongwith-ai'

const problems = []
const note = (message) => problems.push(message)

/** 递归收集 `*.ts`（不含 `*.d.ts`）。 */
function collectTs(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...collectTs(full))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) found.push(full)
  }
  return found
}

/** `packages/<pkg>/src/<rest>.ts` → `lib/<pkg>/<rest>.js`；不匹配则返回 undefined。 */
function outputPathFor(sourcePath) {
  const rel = relative(SRC_ROOT, sourcePath).split(sep)
  if (rel.length < 3 || rel[1] !== 'src') return undefined
  const [pkgName, , ...rest] = rel
  const tail = rest.join(sep).replace(/\.ts$/, '.js')
  return join(OUT_ROOT, pkgName, tail)
}

/**
 * 重写相对说明符：先按源码目录解析出真实源文件，再按输出目录重算相对路径。
 * 解析不到对应输出文件即报错 —— 悄悄留下 `./x.ts` 会让产物在 Node 里直接崩。
 */
function rewriteSpecifiers(code, sourcePath) {
  const sourceDir = dirname(sourcePath)
  const outPath = outputPathFor(sourcePath)
  const outDir = dirname(outPath)
  return code.replace(
    /(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{1,2}\/[^'"]*)\2/g,
    (match, prefix, quote, specifier) => {
      const target = resolve(sourceDir, specifier)
      const targetOut = outputPathFor(target)
      if (targetOut === undefined) {
        note(`${relative(ROOT, sourcePath)}: 相对说明符 ${specifier} 不在可映射的源集合内`)
        return match
      }
      try {
        statSync(target)
      } catch {
        note(`${relative(ROOT, sourcePath)}: 相对说明符 ${specifier} 指向的文件不存在`)
        return match
      }
      let rewritten = relative(outDir, targetOut).split(sep).join('/')
      if (!rewritten.startsWith('.')) rewritten = `./${rewritten}`
      return `${prefix}${quote}${rewritten}${quote}`
    },
  )
}

/** 剥离类型；非可擦除语法（enum / namespace / 参数属性）会在此抛错，正是我们想要的信号。 */
function stripTypes(code, label) {
  try {
    return stripTypeScriptTypes(code, { mode: 'strip' })
  } catch (error) {
    note(`${label}: 类型剥离失败（存在非可擦除语法？）— ${error.message}`)
    return code
  }
}

/**
 * 把剥离后的客户端源码包成 ModuleLoader 工厂。
 *
 * 只接受：`import { a, b as c } from '<裸说明符>'`、`import * as N from '<裸说明符>'`、
 * `import N from '<裸说明符>'`；`export const X`、`export function X`。其余一律报错。
 */
function wrapClient(stripped, label) {
  const exported = []
  let body = stripped

  body = body.replace(
    /^import\s+(?:\*\s+as\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)|(\{[^}]*\}))\s+from\s+(['"])([^'"]+)\4;?[ \t]*$/gm,
    (match, namespaceName, defaultName, named, _quote, specifier) => {
      if (specifier.startsWith('.')) {
        note(`${label}: 客户端半边出现相对导入 ${specifier} —— 工厂契约要求裸说明符`)
        return match
      }
      if (namespaceName !== undefined) return `const ${namespaceName} = require(${JSON.stringify(specifier)});`
      if (defaultName !== undefined) {
        return `const ${defaultName} = (require(${JSON.stringify(specifier)}).default ?? require(${JSON.stringify(specifier)}));`
      }
      const pairs = named
        .slice(1, -1)
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '')
        .map((part) => {
          const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(part)
          if (asMatch !== null) return `${asMatch[1]}: ${asMatch[2]}`
          if (/^[A-Za-z_$][\w$]*$/.test(part)) return part
          note(`${label}: 无法解析的具名导入项 ${JSON.stringify(part)}`)
          return part
        })
      return `const { ${pairs.join(', ')} } = require(${JSON.stringify(specifier)});`
    },
  )

  body = body.replace(/^export\s+const\s+([A-Za-z_$][\w$]*)/gm, (_match, name) => {
    exported.push(name)
    return `const ${name}`
  })
  body = body.replace(/^export\s+function\s+([A-Za-z_$][\w$]*)/gm, (_match, name) => {
    exported.push(name)
    return `function ${name}`
  })

  const leftovers = body.match(/^\s*(?:import|export)\b.*$/gm)
  if (leftovers !== null) {
    note(`${label}: 变换后仍残留 ${leftovers.length} 条未识别的 import/export：${leftovers[0].trim()}`)
  }
  if (exported.length === 0) note(`${label}: 未识别到任何导出 —— 浏览器半边将没有入口`)

  const indent = (text) => text.split('\n').map((line) => (line === '' ? line : `\t\t${line}`)).join('\n')
  return [
    '// 由 scripts/build.mjs 生成，请勿手改。源码：packages/plugin-ui/src/client/index.ts',
    '//',
    '// 契约取自真实第三方插件产物（dsh-better-sidebar / dsh-client-ui-skill-explorer）：',
    '// 一个 IIFE 调用 window.__ModuleLoader__.load({ id, factory })，工厂内建 module.exports，',
    '// 裸说明符经工厂的 require 解析。',
    'window.__ModuleLoader__.load({',
    `\tid: ${JSON.stringify(CLIENT_ID)},`,
    '\tfactory: (require) => {',
    '\t\tvar module = { exports: {} };',
    '\t\tvar exports = module.exports;',
    '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    indent(body.trim()),
    `\t\tObject.assign(exports, { ${exported.join(', ')} });`,
    '\t\treturn module.exports;',
    '\t},',
    '});',
    '',
  ].join('\n')
}

function main() {
  rmSync(OUT_ROOT, { recursive: true, force: true })

  let built = 0
  for (const pkg of SERVER_PACKAGES) {
    const srcDir = join(SRC_ROOT, pkg, 'src')
    let files
    try {
      files = collectTs(srcDir)
    } catch (error) {
      note(`packages/${pkg}/src 不可读：${error.message}`)
      continue
    }
    if (files.length === 0) note(`packages/${pkg}/src 下没有 TypeScript 源文件`)
    for (const file of files) {
      const label = relative(ROOT, file)
      const out = outputPathFor(file)
      const code = rewriteSpecifiers(stripTypes(readFileSync(file, 'utf8'), label), file)
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, code, 'utf8')
      built += 1
    }
  }

  if (statSync(CLIENT_SOURCE, { throwIfNoEntry: false }) === undefined) {
    note(`${relative(ROOT, CLIENT_SOURCE)} 不存在`)
  } else {
    const label = relative(ROOT, CLIENT_SOURCE)
    const wrapped = wrapClient(stripTypes(readFileSync(CLIENT_SOURCE, 'utf8'), label), label)
    mkdirSync(OUT_ROOT, { recursive: true })
    writeFileSync(CLIENT_OUTPUT, wrapped, 'utf8')
  }

  const entry = join(OUT_ROOT, 'plugin-host', 'index.js')
  if (statSync(entry, { throwIfNoEntry: false }) === undefined) {
    note('缺少宿主入口 lib/plugin-host/index.js —— package.json 的 main 会指向空处')
  }

  if (problems.length > 0) {
    process.stderr.write(`构建失败，${problems.length} 个问题：\n`)
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(`构建完成：${built} 个服务端模块 + 1 个客户端半边 → ${relative(ROOT, OUT_ROOT)}/\n`)
}

main()
