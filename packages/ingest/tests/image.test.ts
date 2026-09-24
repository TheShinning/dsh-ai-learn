import { test } from 'node:test'
import assert from 'node:assert/strict'

import { imageCapability, probeImageSize, readImage, readImageBytes, sniffImageMime } from '../src/image.ts'
import { ingestBytes, ingestFile } from '../src/registry.ts'
import { gifHeader, jpegHeader, png1x1, webpVp8x, withTempFile } from './helpers/fixtures.ts'

test('PNG：手搓 1×1 PNG 的魔数、尺寸与字节数', () => {
  const bytes = png1x1()
  assert.equal(sniffImageMime(bytes), 'image/png')
  assert.deepEqual(probeImageSize(bytes), { width: 1, height: 1 })

  const result = readImageBytes(bytes, 'C:\\tmp\\pixel.png')
  assert.equal(result.ok, true)
  assert.equal(result.format, 'image')
  assert.equal(result.mimeType, 'image/png')
  assert.equal(result.bytes, bytes.length)
  assert.equal(result.width, 1)
  assert.equal(result.height, 1)
  assert.equal(result.reference, 'C:\\tmp\\pixel.png')
  assert.equal(result.attempts[0]?.tier, 'native')
  assert.match(result.attempts[0]?.reason ?? '', /image\/png/)
})

test('JPEG：SOF0 段读出宽高', () => {
  const bytes = jpegHeader(3, 2)
  assert.equal(sniffImageMime(bytes), 'image/jpeg')
  assert.deepEqual(probeImageSize(bytes), { width: 3, height: 2 })
})

test('WebP：VP8X 块读出画布尺寸', () => {
  const bytes = webpVp8x(300, 200)
  assert.equal(sniffImageMime(bytes), 'image/webp')
  assert.deepEqual(probeImageSize(bytes), { width: 300, height: 200 })
})

test('GIF：逻辑屏幕描述符读出宽高', () => {
  const bytes = gifHeader(12, 7)
  assert.equal(sniffImageMime(bytes), 'image/gif')
  assert.deepEqual(probeImageSize(bytes), { width: 12, height: 7 })
})

test('不认识的字节：不假装成功，给出转码建议', () => {
  const result = readImageBytes(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]), 'weird.bin')
  assert.equal(result.ok, false)
  assert.equal(result.mimeType, 'application/octet-stream')
  assert.match(result.attempts[0]?.reason ?? '', /魔数/)
  assert.match(result.advice ?? '', /PNG|转码/)
})

test('空文件：如实失败', () => {
  const result = readImageBytes(new Uint8Array(0), 'empty.png')
  assert.equal(result.ok, false)
  assert.equal(result.bytes, 0)
  assert.match(result.attempts[0]?.reason ?? '', /空/)
})

test('readImage / ingestFile：真实落盘的 PNG 走原生视觉分支，不做文本解析', async () => {
  await withTempFile('pixel.png', png1x1(), async (path) => {
    const image = await readImage(path)
    assert.equal(image.ok, true)
    assert.equal(image.mimeType, 'image/png')
    assert.equal(image.width, 1)
    assert.equal(image.height, 1)
    assert.ok(image.reference.endsWith('pixel.png'))

    const ingested = await ingestFile(path)
    assert.equal(ingested.format, 'image')
    assert.equal(ingested.ok, true)
    assert.ok('mimeType' in ingested)
    assert.equal(ingested.attempts[0]?.parser, 'image-native-vision')
  })
})

test('readImage：文件不存在时报错而不是抛异常', async () => {
  const result = await readImage('C:\\definitely\\missing\\file.png')
  assert.equal(result.ok, false)
  assert.match(result.attempts[0]?.reason ?? '', /读取失败/)
})

test('ingestBytes：图像即使没有扩展名也按图像走（魔数判定）', async () => {
  const result = await ingestBytes({ bytes: png1x1(), fileName: 'blob' })
  assert.equal(result.format, 'image')
  assert.equal(result.ok, true)
  if ('mimeType' in result) assert.equal(result.mimeType, 'image/png')
})

test('图像能力声明：native 层，声明能处理「无文本层」的输入', () => {
  const capability = imageCapability()
  assert.equal(capability.id, 'image-native-vision')
  assert.equal(capability.tier, 'native')
  assert.deepEqual(capability.formats, ['image'])
  assert.equal(capability.handlesScanned, true)
  assert.equal(capability.available, true)
})
