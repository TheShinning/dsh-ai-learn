/**
 * 测试夹具工厂：全部在运行时**自己造**，不依赖仓库里预先存在的二进制文件。
 *
 * 这里的 ZIP 写入器是与 `src/office.ts` 读取器**独立实现**的（包括 CRC32），
 * 这样「读回来的内容对得上」才算真的验证，而不是自己骗自己。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, deflateSync } from 'node:zlib'

/* ------------------------------ CRC32 ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

/** 标准 CRC-32（IEEE），与 ZIP 中央目录里存的是同一个。 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/* ------------------------------- ZIP ------------------------------- */

export type ZipInput = { readonly name: string; readonly data: string | Uint8Array; readonly store?: boolean }

/** 手写一个合法 ZIP（本地头 + 中央目录 + EOCD），支持 stored 与 deflate。 */
export function makeZip(entries: readonly ZipInput[]): Uint8Array {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data)
    const method = entry.store ? 0 : 8
    const body = method === 0 ? raw : deflateRawSync(raw)
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const checksum = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 文件名
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, nameBytes, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBytes)

    offset += local.length + nameBytes.length + body.length
  }

  const centralBuffer = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...localParts, centralBuffer, eocd]))
}

/* ------------------------------- PDF ------------------------------- */

function pdfStreamObject(data: Buffer, extra = ''): Buffer {
  const dictionary = `<< /Length ${data.length}${extra ? ` ${extra}` : ''} /Filter /FlateDecode >>`
  return Buffer.concat([Buffer.from(`${dictionary}\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')])
}

/**
 * 造一个**带正确 xref 的最小单页 PDF**：
 * 内置提取器不需要 xref，但 `pdftotext` 需要，所以两边用同一个夹具。
 * `contentStream` 按 UTF-8 写成内容流（PDF 里的字面字符串允许直接放 UTF-8，
 * 内置提取器会按 UTF-8 解码）。
 */
export function buildPdf(contentStream: string, options: { withImage?: boolean } = {}): Uint8Array {
  const header = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')
  const content = deflateSync(Buffer.from(contentStream, 'utf8'))
  const resources = options.withImage
    ? '<< /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >>'
    : '<< /Font << /F1 5 0 R >> >>'
  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents 4 0 R >>`, 'latin1'),
    pdfStreamObject(content),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', 'latin1'),
  ]
  if (options.withImage) {
    objects.push(pdfStreamObject(deflateSync(Buffer.alloc(8 * 8, 0x9a)), '/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8'))
  }

  const chunks: Buffer[] = [header]
  let offset = header.length
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(offset)
    const prefix = Buffer.from(`${index + 1} 0 obj\n`, 'latin1')
    const suffix = Buffer.from('\nendobj\n', 'latin1')
    chunks.push(prefix, body, suffix)
    offset += prefix.length + body.length + suffix.length
  })

  const xrefOffset = offset
  const xrefLines = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f ']
  for (const objectOffset of offsets) xrefLines.push(`${String(objectOffset).padStart(10, '0')} 00000 n `)
  const trailer = ['trailer', `<< /Size ${objects.length + 1} /Root 1 0 R >>`, 'startxref', String(xrefOffset), '%%EOF', '']
  chunks.push(Buffer.from(`${xrefLines.join('\n')}\n${trailer.join('\n')}`, 'latin1'))
  return new Uint8Array(Buffer.concat(chunks))
}

/* ------------------------------ 图像 ------------------------------ */

/** 手写 1×1 灰度 PNG（含真实 IDAT，可被任何解码器读）。 */
export function png1x1(): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
    0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05,
    0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ])
}

/** 手写 SOI + SOF0 的 JPEG 片段（尺寸 3×2）。 */
export function jpegHeader(width = 3, height = 2): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ])
}

/** 手写 RIFF/WEBP + VP8X 块（尺寸 300×200）。 */
export function webpVp8x(width = 300, height = 200): Uint8Array {
  const bytes = new Uint8Array(30)
  bytes.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  bytes.set([0x1a, 0x00, 0x00, 0x00], 4)
  bytes.set([0x57, 0x45, 0x42, 0x50], 8) // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x58], 12) // VP8X
  bytes.set([0x0a, 0x00, 0x00, 0x00], 16)
  const w = width - 1
  const h = height - 1
  bytes.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24)
  bytes.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27)
  return bytes
}

/** 手写 GIF89a 头（尺寸 12×7）。 */
export function gifHeader(width = 12, height = 7): Uint8Array {
  const bytes = new Uint8Array(13)
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0)
  bytes[6] = width & 0xff
  bytes[7] = (width >> 8) & 0xff
  bytes[8] = height & 0xff
  bytes[9] = (height >> 8) & 0xff
  return bytes
}

/* ------------------------------ 临时目录 ------------------------------ */

/** 建一个临时目录（优先系统临时区，失败则退到工作区内的隐藏目录）。 */
export function makeTempDir(): string {
  const attempts: Array<() => string> = [
    () => mkdtempSync(join(tmpdir(), 'dsh-ingest-tests-')),
    () => {
      const fallbackRoot = join(process.cwd(), '.dsh-ingest-tests')
      mkdirSync(fallbackRoot, { recursive: true })
      return mkdtempSync(join(fallbackRoot, 'run-'))
    },
  ]
  let lastError: unknown
  for (const attempt of attempts) {
    try {
      return attempt()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('无法创建临时目录')
}

/** 写一个临时文件并回调，结束后清理整个目录。 */
export async function withTempFile(fileName: string, data: Uint8Array, run: (path: string) => Promise<void> | void): Promise<void> {
  const dir = makeTempDir()
  const path = join(dir, fileName)
  writeFileSync(path, data)
  try {
    await run(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
