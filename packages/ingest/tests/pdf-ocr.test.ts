/**
 * 本机没装 tesseract，**无法**验证真实 OCR 效果；这里用「替身命令行」验证编排逻辑：
 * 页面发现 → 逐页调用 → 语言包失败退回 → 结果拼接 → 原因文案里记录真实命令行。
 * 替身脚本模拟的正是 pdftoppm / tesseract 的 CLI 形状。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { pdfOcrParser } from '../src/pdf.ts'
import { buildPdf, makeTempDir } from './helpers/fixtures.ts'
import { rmSync } from 'node:fs'

const FAKE_RASTER = `import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (args.includes('-v')) process.exit(0)
const prefix = args[args.length - 1]
const pageCount = Number(process.env.FAKE_PAGES ?? '2')
for (let page = 1; page <= pageCount; page += 1) writeFileSync(\`\${prefix}-\${page}.png\`, 'fake-png')
`

const FAKE_TESSERACT = `import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (args.includes('-v')) process.exit(0)
const outBase = args[1]
const language = args[args.indexOf('-l') + 1]
if (String(language).includes('chi_sim')) {
  process.stderr.write("Error opening data file ./tessdata/chi_sim.traineddata\\n")
  process.exit(1)
}
writeFileSync(\`\${outBase}.txt\`, \`识别结果 \${outBase.slice(-1)} (\${language})\\n\`)
`

function fakeToolchain(): { dir: string; dispose: () => void } {
  const dir = makeTempDir()
  writeFileSync(join(dir, 'fake-pdftoppm.mjs'), FAKE_RASTER)
  writeFileSync(join(dir, 'fake-tesseract.mjs'), FAKE_TESSERACT)
  return {
    dir,
    dispose: () => {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('OCR 编排（替身命令）：逐页识别、中文语言包失败自动退回 eng，并在 reason 里记录命令', async () => {
  const tools = fakeToolchain()
  try {
    const parser = pdfOcrParser({
      command: process.execPath,
      commandArgs: [join(tools.dir, 'fake-tesseract.mjs')],
      rasterCommand: process.execPath,
      rasterArgs: [join(tools.dir, 'fake-pdftoppm.mjs')],
      timeoutMs: 20_000,
    })
    assert.equal(parser.capability.available, true)
    assert.equal(parser.capability.handlesScanned, true)

    const result = await parser.parse({
      bytes: buildPdf('q 100 0 0 100 72 600 cm /Im1 Do Q', { withImage: true }),
      fileName: 'scan.pdf',
      format: 'pdf',
    })

    assert.match(result.markdown, /识别结果 1/, '第一页应被识别')
    assert.match(result.markdown, /识别结果 2/, '第二页应被识别')
    assert.match(result.markdown, /\(eng\)/, '中文语言包失败后应退回 eng')
    assert.equal(result.partial, true)
    assert.match(result.reason ?? '', /pdftoppm|fake-pdftoppm\.mjs/)
    assert.match(result.reason ?? '', /--psm 6/)
    assert.match(result.reason ?? '', /语言包 eng/)
  } finally {
    tools.dispose()
  }
})

test('OCR 编排（替身命令）：maxPages 限制页数并在 reason 里说明', async () => {
  const tools = fakeToolchain()
  try {
    process.env.FAKE_PAGES = '4'
    const parser = pdfOcrParser({
      command: process.execPath,
      commandArgs: [join(tools.dir, 'fake-tesseract.mjs')],
      rasterCommand: process.execPath,
      rasterArgs: [join(tools.dir, 'fake-pdftoppm.mjs')],
      maxPages: 2,
      timeoutMs: 20_000,
    })
    const result = await parser.parse({ bytes: buildPdf('q Q'), fileName: 'scan.pdf', format: 'pdf' })
    assert.match(result.markdown, /识别结果 1/)
    assert.match(result.markdown, /识别结果 2/)
    assert.equal(result.markdown.includes('识别结果 3'), false, 'maxPages 之外的页不该被 OCR')
    assert.match(result.reason ?? '', /仅 OCR 前 2 页/)
  } finally {
    delete process.env.FAKE_PAGES
    tools.dispose()
  }
})

test('OCR 编排：替身命令没生成任何页面图像时如实失败', async () => {
  const dir = makeTempDir()
  try {
    // 一个什么都不做的替身：模拟 pdftoppm 静默失败
    writeFileSync(join(dir, 'noop.mjs'), 'process.exit(0)\n')
    const parser = pdfOcrParser({
      command: process.execPath,
      commandArgs: [join(dir, 'noop.mjs')],
      rasterCommand: process.execPath,
      rasterArgs: [join(dir, 'noop.mjs')],
      timeoutMs: 20_000,
    })
    const result = await parser.parse({ bytes: buildPdf('q Q'), fileName: 'scan.pdf', format: 'pdf' })
    assert.equal(result.markdown, '')
    assert.match(result.reason ?? '', /没有生成任何页面图像|OCR 未取到文本/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
