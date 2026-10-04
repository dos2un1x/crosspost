// detectIconExt 魔数嗅探 + MIME 兜底单测（2026-09-02，修复 .ico 误报）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectIconExt } from '../../bridge/icon-detect.mjs'

test('魔数嗅探：ICO（含 CUR）→ ico', () => {
  assert.equal(
    detectIconExt(Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x40, 0x40]), 'image/svg+xml'),
    'ico',
  )
  assert.equal(detectIconExt(Buffer.from([0x00, 0x00, 0x02, 0x00, 0x01, 0x00]), ''), 'ico')
})

test('魔数嗅探：PNG/JPEG/GIF/WEBP/SVG', () => {
  assert.equal(
    detectIconExt(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
      'application/octet-stream',
    ),
    'png',
  )
  assert.equal(
    detectIconExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), 'application/octet-stream'),
    'jpg',
  )
  assert.equal(detectIconExt(Buffer.from('GIF89a...'), 'application/octet-stream'), 'gif')
  assert.equal(
    detectIconExt(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])),
    'webp',
  )
  assert.equal(detectIconExt(Buffer.from('<?xml version="1.0"?><svg xmlns="x"></svg>')), 'svg')
  assert.equal(detectIconExt(Buffer.from('<svg width="10"></svg>')), 'svg')
})

test('兜底：上报 MIME 别名（.ico 常见别名 + 通用类型）', () => {
  const junk = Buffer.from('not-a-real-image!!')
  assert.equal(
    detectIconExt(junk, 'image/vnd.microsoft.icon'),
    'ico',
    'image/vnd.microsoft.icon 应判 ico',
  )
  assert.equal(detectIconExt(junk, 'image/x-icon'), 'ico')
  assert.equal(detectIconExt(junk, 'image/ico'), 'ico')
  assert.equal(
    detectIconExt(junk, 'application/octet-stream'),
    'ico',
    'application/octet-stream 应兜底判 ico',
  )
  assert.equal(detectIconExt(junk, 'image/png'), 'png')
})

test('无法识别 → null', () => {
  assert.equal(detectIconExt(Buffer.from('hello world'), 'text/plain'), null)
  assert.equal(detectIconExt(null, 'image/png'), null)
  assert.equal(detectIconExt(Buffer.alloc(0), 'image/png'), null)
})
