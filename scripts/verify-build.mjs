#!/usr/bin/env node
/**
 * 产物验证：证明 `lib/` 里**每一个**模块都能在原生 Node 下被 import，且两个半边
 * 都具备 Loader / ModuleLoader 需要的形状。
 *
 * ## 这一关专门抓什么
 *
 * 1. **只作类型用的导入没写 `import type`**。剥离类型会把 `import type {...}` 整条删掉，
 *    但 `import { SomeType }` 会被原样保留 —— 运行时 Node 去要一个不存在的具名导出，
 *    直接 SyntaxError。这类错误构建期看不见，只有真正 import 才会暴露。
 * 2. **相对说明符改写漏改**。残留 `.ts` 会让 Node 在默认配置下拒绝解析。
 * 3. **客户端包装契约漂移**。用假 `window.__ModuleLoader__` 求值产物，断言工厂返回
 *    的对象带 `name` / `inject` / `apply`，并真的调用一次 `apply` 看它注册了什么。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const LIB = join(ROOT, 'lib')
const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}

function collectJs(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...collectJs(full))
    else if (entry.name.endsWith('.js')) found.push(full)
  }
  return found
}

if (statSync(LIB, { throwIfNoEntry: false }) === undefined) {
  process.stderr.write('lib/ 不存在 —— 先运行 npm run build\n')
  process.exit(1)
}

const modules = collectJs(LIB)
check(modules.length >= 20, `lib/ 下只有 ${modules.length} 个模块，疑似构建不完整`)

// —— 1. 每个模块都要能 import（客户端半边除外，它依赖浏览器全局）——
const CLIENT = join(LIB, 'client.js')
let imported = 0
for (const file of modules) {
  if (file === CLIENT) continue
  const label = relative(ROOT, file).split('\\').join('/')
  try {
    await import(pathToFileURL(file).href)
    imported += 1
  } catch (error) {
    failures.push(`${label} 无法 import：${error.message.split('\n')[0]}`)
  }
}

// —— 2. 源码里不能残留未写 `import type` 的类型导入 ——
// 已由 import 检查覆盖；这里额外静态扫描，报出可疑行以便定位。
for (const file of modules) {
  if (file === CLIENT) continue
  const code = readFileSync(file, 'utf8')
  const suspicious = code.split('\n').filter((line) => /^import\s*\{[^}]*\}\s*from\s*'\.\//.test(line))
  for (const line of suspicious) {
    const names = line.slice(line.indexOf('{') + 1, line.indexOf('}')).split(',').map((n) => n.trim())
    const specifier = /from\s*'([^']+)'/.exec(line)?.[1]
    if (specifier === undefined) continue
    let target
    try {
      target = readFileSync(join(file, '..', specifier), 'utf8')
    } catch {
      continue
    }
    for (const name of names) {
      if (name === '' || name.includes(' as ')) continue
      const declared = new RegExp(`export\\s+(?:const|function|class|let|var)\\s+${name}\\b`).test(target)
      const reexported = new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(target)
      if (!declared && !reexported) {
        failures.push(`${relative(ROOT, file)}：导入的 ${name} 在 ${specifier} 里不是运行时导出（应写成 import type？）`)
      }
    }
  }
}

// —— 3. 宿主入口形状 ——
const hostEntry = join(LIB, 'plugin-host', 'index.js')
let host
try {
  host = await import(pathToFileURL(hostEntry).href)
} catch (error) {
  failures.push(`宿主入口无法 import：${error.message.split('\n')[0]}`)
}
if (host !== undefined) {
  check(typeof host.name === 'string' && host.name !== '', '宿主入口缺少字符串 name 导出')
  check(typeof host.apply === 'function', '宿主入口缺少 apply 导出')
  check(Array.isArray(host.inject), '宿主入口缺少 inject 数组导出')
  check(host.Config !== undefined, '宿主入口缺少 Config 导出（schemastery 校验会失去约束）')
  check(host.default === undefined, '宿主入口导出了 default —— Loader.unwrapExports 会丢弃元数据')
}

// —— 4. 客户端半边：在假 ModuleLoader 里求值并调用 apply ——
let clientLoad
const fakeWindow = {
  __ModuleLoader__: {
    load: (spec) => {
      clientLoad = spec
    },
  },
}
const reactStub = {
  createElement: (type, props, children) => ({ type, props, children }),
}
const requireStub = (specifier) => {
  if (specifier === 'react') return reactStub
  throw new Error(`客户端半边 require 了未桩接的模块：${specifier}`)
}
if (statSync(CLIENT, { throwIfNoEntry: false }) === undefined) {
  failures.push('缺少 lib/client.js（浏览器半边）')
} else {
  const code = readFileSync(CLIENT, 'utf8')
  try {
    // eslint-disable-next-line no-new-func
    new Function('window', code)(fakeWindow)
  } catch (error) {
    failures.push(`lib/client.js 求值失败：${error.message}`)
  }
  if (clientLoad === undefined) {
    failures.push('lib/client.js 没有调用 window.__ModuleLoader__.load')
  } else {
    check(clientLoad.id === 'dsh-study-alongwith-ai', `客户端 id 应为 dsh-study-alongwith-ai，实际 ${String(clientLoad.id)}`)
    check(typeof clientLoad.factory === 'function', '客户端 load 缺少 factory')
    if (typeof clientLoad.factory === 'function') {
      let exported
      try {
        exported = clientLoad.factory(requireStub)
      } catch (error) {
        failures.push(`客户端 factory 抛错：${error.message}`)
      }
      if (exported !== undefined) {
        check(exported.name === 'study-alongwith-ai', `客户端 name 应为 study-alongwith-ai，实际 ${String(exported.name)}`)
        check(
          Array.isArray(exported.inject) && exported.inject.join(',') === 'slots,locale,theme',
          `客户端 inject 应为 slots,locale,theme，实际 ${JSON.stringify(exported.inject)}`,
        )
        check(typeof exported.apply === 'function', '客户端缺少 apply')
        if (typeof exported.apply === 'function') {
          const effects = []
          const disposers = []
          const slots = []
          const ctx = {
            // 真实 Cordis 的 ctx.effect 会**立即执行** callback，并把返回值登记为 disposer
            // （disposer 在 unloading 时逆序执行）。假 ctx 必须照做，否则永远看不到副作用。
            effect: (callback, label) => {
              effects.push({ callback, label })
              disposers.push(callback())
            },
            slots: {
              inject: (slot, register) => slots.push({ slot, register }),
              register: (meta) => ({ meta }),
            },
            locale: {
              register: (namespace, dicts) => {
                ctx.localeRegistered = { namespace, dicts }
                return () => {}
              },
              bind: (namespace) => (key) => `${namespace}:${key}`,
            },
            theme: { getTheme: () => null },
          }
          try {
            exported.apply(ctx)
          } catch (error) {
            failures.push(`客户端 apply 抛错：${error.message}`)
          }
          check(effects.length === 1, `客户端 apply 应注册 1 个 effect，实际 ${effects.length}`)
          check(ctx.localeRegistered !== undefined, '客户端 apply 没有注册 locale 字典')
          check(slots.length === 1 && slots[0].slot === 'settings.section', '客户端 apply 没有注入 settings.section slot')
          const dicts = ctx.localeRegistered?.dicts
          check(dicts !== undefined && Object.keys(dicts.zh ?? {}).length === Object.keys(dicts.en ?? {}).length, '中英文字典键数不一致')
        }
      }
    }
  }
}

// —— 结果 ——
if (failures.length > 0) {
  process.stderr.write(`产物验证失败，${failures.length} 个问题：\n`)
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`)
  process.exit(1)
}
process.stdout.write(`产物验证通过：${imported} 个服务端模块可 import，宿主入口与客户端半边形状正确。\n`)
