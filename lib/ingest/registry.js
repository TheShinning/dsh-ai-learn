/**
 * 解析器注册表：把各层解析器按 `native → builtin → external` 组装起来，并对外提供
 * 「给一个文件路径，拿到摄取结果」的单一入口。
 *
 * 排序在**组装时就固定**（不依赖 `Array.prototype.sort` 的稳定性直觉），
 * 同时 `runIngestPipeline` 内部还会再按 tier 排一次，双保险。
 */

import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

             
                    
               
             
                   
               
               
                                       
import { detectFormat, runIngestPipeline } from '../core/ingest/types.js'

import { imageCapability, readImageBytes } from './image.js'
import { docxParser, epubParser, odtParser, readZipEntries, sniffOfficeFormat } from './office.js'
import { pdfBuiltinParser, pdfOcrParser, pdfPopplerParser } from './pdf.js'
import { htmlParser, markdownParser, plainTextParser, textFallbackParser } from './text.js'

const TIER_ORDER                        = ['native', 'builtin', 'external']

/** 稳定按 tier 排序（同级保持声明顺序），不依赖 sort 的稳定性直觉。 */
function orderByTier   (items              , tierOf                         )      {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const tierDelta = TIER_ORDER.indexOf(tierOf(left.item)) - TIER_ORDER.indexOf(tierOf(right.item))
      return tierDelta !== 0 ? tierDelta : left.index - right.index
    })
    .map((entry) => entry.item)
}

function buildParsers()                 {
  return orderByTier              (
    [
      // native：运行时直接能吃
      markdownParser(),
      plainTextParser(),
      // builtin：纯 JS 解析
      htmlParser(),
      textFallbackParser(),
      pdfBuiltinParser(),
      docxParser(),
      odtParser(),
      epubParser(),
      // external：外部命令
      pdfPopplerParser(),
      pdfOcrParser(),
    ],
    (parser) => parser.capability.tier,
  )
}

let cachedParsers                            

/** 组装好的解析器（按 tier 有序）。顺序即降级顺序。 */
export function defaultParsers()                          {
  cachedParsers ??= buildParsers()
  return Promise.resolve(cachedParsers)
}

/** 清空解析器缓存（外部命令装好后想让能力重新探测时调用）。 */
export function clearParserCache()       {
  cachedParsers = undefined
}

/** 能力清单，用于 UI 展示「哪些格式现在能解析、缺什么依赖」。 */
export async function capabilities()                              {
  const parsers = await defaultParsers()
  return orderByTier(
    [...parsers.map((parser) => parser.capability), imageCapability()],
    (capability) => capability.tier,
  )
}

/**
 * 扩展名缺失时用容器内部结构再判一次（PK 魔数在 `detectFormat` 里只能得到 unknown）。
 * 任何读取失败都返回 undefined，不抛异常。
 */
export function sniffContainerFormat(bytes            )                           {
  try {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return undefined
    return sniffOfficeFormat(readZipEntries(bytes).map((entry) => entry.name))
  } catch {
    return undefined
  }
}

/** 已经有字节时的入口（例如拖拽上传/HTTP body 已经读完）。 */
export async function ingestBytes(input                                                             )                                            {
  let format = detectFormat(input.fileName, input.bytes.subarray(0, 16))
  if (format === 'unknown') format = sniffContainerFormat(input.bytes) ?? format
  if (format === 'image') {
    return readImageBytes(input.bytes, input.reference ?? input.fileName)
  }
  return runIngestPipeline({
    bytes: input.bytes,
    fileName: input.fileName,
    format,
    parsers: await defaultParsers(),
  })
}

/** 读文件 → 判格式 → 图像走原生视觉、其余走文本解析管线。 */
export async function ingestFile(filePath        )                                            {
  const bytes = new Uint8Array(await readFile(filePath))
  return ingestBytes({ bytes, fileName: basename(filePath), reference: resolve(filePath) })
}
