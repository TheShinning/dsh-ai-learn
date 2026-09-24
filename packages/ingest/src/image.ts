/**
 * 图像摄取：**不抽文字**，而是交给模型原生视觉。
 *
 * 这里只做三件事，全部零依赖：
 * 1. 用魔数判定 MIME（扩展名可以骗人）；
 * 2. 读像素尺寸（PNG IHDR / JPEG SOFn / WebP VP8X·VP8·VP8L / GIF / BMP / TIFF），
 *    用于「图片太大先降采样」这类后续决策；
 * 3. 如实报告失败（未知格式 / 空文件），不假装成功。
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { ImageIngestResult, IngestAttempt, ParserCapability } from '../../core/src/ingest/types.ts'

/** 图像识别结果。 */
export type ImageInfo = { readonly mimeType: string; readonly width?: number; readonly height?: number }

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.byteLength < offset + signature.length) return false
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) return false
  }
  return true
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = ''
  for (let index = 0; index < length; index += 1) {
    const byte = bytes[offset + index]
    if (byte === undefined) return out
    out += String.fromCharCode(byte)
  }
  return out
}

function u16be(bytes: Uint8Array, offset: number): number | undefined {
  const a = bytes[offset]
  const b = bytes[offset + 1]
  return a === undefined || b === undefined ? undefined : (a << 8) | b
}

function u32be(bytes: Uint8Array, offset: number): number | undefined {
  const a = bytes[offset]
  const b = bytes[offset + 1]
  const c = bytes[offset + 2]
  const d = bytes[offset + 3]
  return a === undefined || b === undefined || c === undefined || d === undefined ? undefined : ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
}

function u32le(bytes: Uint8Array, offset: number): number | undefined {
  const a = bytes[offset]
  const b = bytes[offset + 1]
  const c = bytes[offset + 2]
  const d = bytes[offset + 3]
  return a === undefined || b === undefined || c === undefined || d === undefined ? undefined : (a | (b << 8) | (c << 16) | (d << 24)) >>> 0
}

function u16le(bytes: Uint8Array, offset: number): number | undefined {
  const a = bytes[offset]
  const b = bytes[offset + 1]
  return a === undefined || b === undefined ? undefined : a | (b << 8)
}

/** 魔数 → MIME。不认识返回 `application/octet-stream`。 */
export function sniffImageMime(bytes: Uint8Array): string {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (ascii(bytes, 0, 4) === 'GIF8') return 'image/gif'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp'
  if (ascii(bytes, 0, 2) === 'BM') return 'image/bmp'
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff'
  const head = ascii(bytes, 0, Math.min(bytes.byteLength, 1024))
  if (/<svg[\s>]/i.test(head)) return 'image/svg+xml'
  return 'application/octet-stream'
}

function pngSize(bytes: Uint8Array): { width?: number; height?: number } {
  if (ascii(bytes, 12, 4) !== 'IHDR') return {}
  const width = u32be(bytes, 16)
  const height = u32be(bytes, 20)
  return width && height ? { width, height } : {}
}

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function jpegSize(bytes: Uint8Array): { width?: number; height?: number } {
  let offset = 2
  while (offset + 4 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1] ?? 0
    if (marker === 0xff) {
      offset += 1
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2
      continue
    }
    const length = u16be(bytes, offset + 2)
    if (length === undefined || length < 2) break
    if (JPEG_SOF_MARKERS.has(marker)) {
      const height = u16be(bytes, offset + 5)
      const width = u16be(bytes, offset + 7)
      return width && height ? { width, height } : {}
    }
    offset += 2 + length
  }
  return {}
}

function webpSize(bytes: Uint8Array): { width?: number; height?: number } {
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8X') {
    const width = 1 + ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16))
    const height = 1 + ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16))
    return { width, height }
  }
  if (chunk === 'VP8 ') {
    // 有损：跳过 3 字节帧标签 + 3 字节起始码 0x9d 0x01 0x2a
    if (bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      const width = ((bytes[26] ?? 0) | ((bytes[27] ?? 0) << 8)) & 0x3fff
      const height = ((bytes[28] ?? 0) | ((bytes[29] ?? 0) << 8)) & 0x3fff
      return { width, height }
    }
    return {}
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    const bits = (bytes[21] ?? 0) | ((bytes[22] ?? 0) << 8) | ((bytes[23] ?? 0) << 16) | ((bytes[24] ?? 0) << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return {}
}

function tiffSize(bytes: Uint8Array): { width?: number; height?: number } {
  const little = startsWith(bytes, [0x49, 0x49])
  if (!little && !startsWith(bytes, [0x4d, 0x4d])) return {}
  const read16 = (offset: number): number | undefined => (little ? u16le(bytes, offset) : u16be(bytes, offset))
  const read32 = (offset: number): number | undefined => {
    if (!little) return u32be(bytes, offset)
    // TIFF little-endian 的 LONG
    const a = bytes[offset]
    const b = bytes[offset + 1]
    const c = bytes[offset + 2]
    const d = bytes[offset + 3]
    return a === undefined || b === undefined || c === undefined || d === undefined ? undefined : (a | (b << 8) | (c << 16) | (d << 24)) >>> 0
  }
  const ifdOffset = read32(4)
  if (ifdOffset === undefined) return {}
  const count = read16(ifdOffset)
  if (count === undefined) return {}
  let width: number | undefined
  let height: number | undefined
  for (let index = 0; index < count; index += 1) {
    const entry = ifdOffset + 2 + index * 12
    const tag = read16(entry)
    if (tag !== 256 && tag !== 257) continue
    const type = read16(entry + 2)
    const value = type === 3 ? read16(entry + 8) : read32(entry + 8)
    if (tag === 256) width = value
    else height = value
  }
  return width && height ? { width, height } : {}
}

/** 读像素尺寸；读不出来时返回空对象（不算失败，图像仍可交给视觉模型）。 */
export function probeImageSize(bytes: Uint8Array): { width?: number; height?: number } {
  try {
    switch (sniffImageMime(bytes)) {
      case 'image/png':
        return pngSize(bytes)
      case 'image/jpeg':
        return jpegSize(bytes)
      case 'image/webp':
        return webpSize(bytes)
      case 'image/gif': {
        const width = u16le(bytes, 6)
        const height = u16le(bytes, 8)
        return width && height ? { width, height } : {}
      }
      case 'image/bmp': {
        const headerSize = u32le(bytes, 14)
        if (headerSize === 12) {
          const width = u16le(bytes, 18)
          const height = u16le(bytes, 20)
          return width && height ? { width, height } : {}
        }
        const width = u32le(bytes, 18)
        const rawHeight = u32le(bytes, 22)
        const signedHeight = rawHeight === undefined ? undefined : rawHeight | 0
        return width && signedHeight ? { width, height: Math.abs(signedHeight) } : {}
      }
      case 'image/tiff':
        return tiffSize(bytes)
      case 'image/svg+xml': {
        const head = ascii(bytes, 0, Math.min(bytes.byteLength, 4096))
        const width = Number.parseInt(/\bwidth\s*=\s*"(\d+)/i.exec(head)?.[1] ?? '', 10)
        const height = Number.parseInt(/\bheight\s*=\s*"(\d+)/i.exec(head)?.[1] ?? '', 10)
        return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : {}
      }
      default:
        return {}
    }
  } catch {
    return {}
  }
}

/** 原生视觉能力声明：图像格式由运行时多模态能力直接消化，文本管线不参与。 */
export function imageCapability(): ParserCapability {
  return {
    id: 'image-native-vision',
    tier: 'native',
    formats: ['image'],
    handlesScanned: true,
    available: true,
  }
}

/**
 * 由字节生成图像摄取结果。
 * `reference` 是交给模型的可引用路径（这里是磁盘绝对路径）。
 */
export function readImageBytes(bytes: Uint8Array, reference: string): ImageIngestResult {
  const parser = 'image-native-vision'
  if (bytes.byteLength === 0) {
    return {
      ok: false,
      format: 'image',
      reference,
      mimeType: 'application/octet-stream',
      bytes: 0,
      attempts: [{ tier: 'native', parser, ok: false, reason: '文件为空（0 字节）' }],
      advice: '图像文件是空的，请重新导出后再试',
    }
  }
  const mimeType = sniffImageMime(bytes)
  if (mimeType === 'application/octet-stream') {
    return {
      ok: false,
      format: 'image',
      reference,
      mimeType,
      bytes: bytes.byteLength,
      attempts: [{ tier: 'native', parser, ok: false, reason: '魔数不匹配任何受支持图像格式（PNG/JPEG/WebP/GIF/BMP/TIFF/SVG）' }],
      advice: '请提供 PNG/JPEG/WebP/GIF/BMP/TIFF/SVG 图像；HEIC/AVIF 请先转码',
    }
  }
  const { width, height } = probeImageSize(bytes)
  const sizeNote = width && height ? `${width}×${height}` : '尺寸未知'
  const attempt: IngestAttempt = {
    tier: 'native',
    parser,
    ok: true,
    reason: `原生视觉读取：${mimeType}，${sizeNote}，${bytes.byteLength} 字节`,
  }
  return { ok: true, format: 'image', reference, mimeType, bytes: bytes.byteLength, width, height, attempts: [attempt] }
}

/** 从磁盘读图（推荐路径：模型可直接引用这个绝对路径）。 */
export async function readImage(filePath: string): Promise<ImageIngestResult> {
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await readFile(filePath))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      format: 'image',
      reference: resolve(filePath),
      mimeType: 'application/octet-stream',
      bytes: 0,
      attempts: [{ tier: 'native', parser: 'image-native-vision', ok: false, reason: `读取失败：${reason}` }],
      advice: '确认文件存在且可读',
    }
  }
  return readImageBytes(bytes, resolve(filePath))
}
