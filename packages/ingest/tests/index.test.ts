import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as api from '../src/index.ts'

test('公共出口：契约与实现都从 @dsh-study/ingest 再导出', () => {
  // 契约（来自 @dsh-study/core 的 ingest/types.ts）
  assert.equal(typeof api.detectFormat, 'function')
  assert.equal(typeof api.runIngestPipeline, 'function')
  assert.equal(api.INGEST_TIER_LABEL.native, '运行时原生')
  assert.equal(api.INGEST_TIER_LABEL.builtin, '内置解析')
  assert.equal(api.INGEST_TIER_LABEL.external, '外部命令')

  // 注册表
  assert.equal(typeof api.defaultParsers, 'function')
  assert.equal(typeof api.ingestFile, 'function')
  assert.equal(typeof api.ingestBytes, 'function')
  assert.equal(typeof api.capabilities, 'function')
  assert.equal(typeof api.sniffContainerFormat, 'function')

  // 文本 / PDF / Office / 图像
  for (const name of [
    'markdownParser',
    'plainTextParser',
    'htmlParser',
    'htmlToMarkdown',
    'decodeText',
    'tidyMarkdown',
    'pdfBuiltinParser',
    'pdfPopplerParser',
    'pdfOcrParser',
    'extractPdfTextLayer',
    'commandAvailable',
    'docxParser',
    'odtParser',
    'epubParser',
    'readZipEntries',
    'readZipText',
    'xmlToMarkdown',
    'sniffOfficeFormat',
    'readImage',
    'readImageBytes',
    'sniffImageMime',
    'probeImageSize',
    'imageCapability',
  ] as const) {
    assert.equal(typeof (api as Record<string, unknown>)[name], 'function', `${name} 应对外导出`)
  }
})
