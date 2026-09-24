#!/usr/bin/env node
/**
 * 编码体检：查全仓源码有没有被"双重编码"损坏或带 BOM。
 *
 * 背景：本仓库作者（AI）曾用 PowerShell 的 Get-Content/Set-Content 改写文件，
 * 在中文 Windows 上把 UTF-8 当成 GBK 读入又存回，导致中文变成乱码且**不可逆**
 * （非 GBK 字符被替换成 '?'）。这类损坏在编辑器里看着只是"乱码"，
 * 但会让模型读到错误的提示词、让审阅者读到错误的注释 —— 必须机器检查。
 *
 * 判据：
 * 1. BOM（EF BB BF）—— 本仓库约定不使用 BOM；
 * 2. U+FFFD 替换字符 —— 明确的信息丢失；
 * 3. 典型 GBK-误解码字符集（如 锛 鐨 鏄 涓 浜 鎴 璁 铏 绫 鍗 鍑 娴 鍐 鍦 鑺 涓）——
 *    这些字在正常中文技术文档里几乎不会出现，出现即为损坏特征；
 * 4. 私用区字符（U+E000–U+F8FF）—— GBK 解码 UTF-8 字节的典型产物。
 *
 * 退出码：发现任一问题即 1。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, '$1')
  .replace(/\/$/, '')

/**
 * 正常中文文本里极罕见的字符，作为 GBK 误解码指纹。
 *
 * 注意：本字符集只包含"乱码产物"特征字，**绝不含常用汉字**——
 * 早先版本用手抄码点，误把 `我`、`申` 等常用字算进来，导致满屏误报。
 * 本脚本自身因为字面量里含这些字符会被命中，故在扫描时跳过自己。
 */
const MOJIBAKE_FINGERPRINT = /[锛鐨鏄涓浜鎴璁铏绫鍗鍑娴鍐鍦鑺闈鐢鍜屾垜浠粨]/g
const PRIVATE_USE_RE = /[\uE000-\uF8FF]/g

/**
 * 扫描根。
 *
 * ## 为什么必须包含 `presets/` 与 `docs/`
 *
 * 本仓库记录过一次事故：用 PowerShell 的 `Get-Content`+`Set-Content` 改写文件，
 * 在中文 Windows 上把 UTF-8 当 GBK 读回，非 GBK 字符被**静默吞掉**。
 * 而 `presets/**`（agent.cordis.yml、SKILL.md）与 `docs/*.md` 恰恰是中文最密集的地方 ——
 * 它们曾长期不在扫描范围内（2026-09-23 独立核验发现）。
 *
 * `cordis.patch.yml` 与 `README.md` 也在根目录一起纳入，理由相同：写成乱码时
 * 前者会让补丁静默失效，后者会让使用者读到错误的安装说明。
 */
const SCAN_ROOTS = ['packages', 'scripts', 'presets', 'docs']
const ROOT_FILES = ['README.md', 'cordis.patch.yml', 'package.json']

async function collect(dir) {
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.scratch' || entry.name === '.git') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await collect(full)))
    else if (/\.(ts|tsx|mjs|md|json|yml)$/.test(entry.name)) out.push(full)
  }
  return out
}

const files = []
for (const root of SCAN_ROOTS) files.push(...(await collect(join(ROOT, root))))
for (const name of ROOT_FILES) {
  const full = join(ROOT, name)
  try {
    await readFile(full)
    files.push(full)
  } catch {
    // 根文件缺失不是编码问题，交给别的门去管
  }
}
const problems = []

for (const file of files) {
  // 本脚本自身含指纹字面量，跳过
  if (file.endsWith('check-encoding.mjs')) continue
  const bytes = await readFile(file)
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const body = hasBom ? bytes.subarray(3) : bytes
  const text = body.toString('utf8')

  const replacement = (text.match(/\uFFFD/g) ?? []).length
  const fingerprints = (text.match(MOJIBAKE_FINGERPRINT) ?? []).length
  const pua = (text.match(PRIVATE_USE_RE) ?? []).length
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length

  const issues = []
  if (hasBom) issues.push('BOM')
  if (replacement > 0) issues.push(`替换字符×${replacement}`)
  if (fingerprints > 0) issues.push(`乱码指纹×${fingerprints}`)
  if (pua > 0) issues.push(`私用区字符×${pua}`)
  if (issues.length > 0) problems.push({ file: relative(ROOT, file), issues, cjk })
}

process.stdout.write(`扫描 ${files.length} 个文件\n`)
if (problems.length === 0) {
  process.stdout.write('编码体检：通过（无 BOM / 无替换字符 / 无乱码指纹）\n')
  process.exit(0)
}
process.stdout.write(`编码体检：${problems.length} 个文件有问题\n`)
for (const problem of problems) {
  process.stdout.write(`  ✖ ${problem.file}\n    ${problem.issues.join('，')}  正常中文=${problem.cjk}\n`)
}
process.exit(1)
