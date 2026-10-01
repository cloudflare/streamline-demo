import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OUTPUT_RESOLUTIONS,
  normalizeDisplaySettings,
  normalizeStreamlineSettings,
  readStreamlineSettings,
  writeDisplaySettings,
} from '../src/lib/settings-storage.ts'

test('normalizes the whitelisted settings schema and legacy HLS source', () => {
  assert.deepEqual(normalizeStreamlineSettings({
    previewMode: false,
    sourceType: 'stream',
    videoId: '  video-id  ',
    outputResolution: '960x540',
    bufferPriming: 20,
    probePreset: 'overlay',
    streamUrl: 'rtmps://legacy-secret',
    arbitrary: 'not-persisted',
  }), {
    previewMode: false,
    sourceType: 'stream-hls',
    videoId: 'video-id',
    outputResolution: '960x540',
    bufferPriming: 10,
    probePreset: 'overlay',
  })

  assert.deepEqual(normalizeStreamlineSettings({
    previewMode: 'false',
    sourceType: 'file',
    videoId: 123,
    outputResolution: '3840x2160',
    bufferPriming: '2',
    probePreset: 'filters',
  }), {})
  assert.equal(normalizeStreamlineSettings({ bufferPriming: -1 }).bufferPriming, 0.5)
  for (const outputResolution of OUTPUT_RESOLUTIONS) {
    assert.equal(normalizeStreamlineSettings({ outputResolution }).outputResolution, outputResolution)
  }
})

test('applies display defaults after normalization', () => {
  assert.deepEqual(normalizeDisplaySettings({
    previewMode: 'yes',
    outputResolution: 'invalid',
    bufferPriming: Number.NaN,
  }), {
    previewMode: true,
    sourceType: 'webcam',
    videoId: '',
    outputResolution: '1280x720',
    bufferPriming: 2,
  })
})

test('prunes legacy, unknown, and secret fields when reading storage', () => {
  let stored = JSON.stringify({
    previewMode: true,
    sourceType: 'stream',
    outputResolution: '640x360',
    bufferPriming: 0.1,
    probePreset: 'passthrough',
    streamUrl: 'rtmps://legacy-output',
    streamInputUrl: 'rtmps://legacy-input',
    streamPreviewUrl: 'https://example.com/manifest.m3u8',
    playbackUrl: 'https://example.com/player',
    rtmpKey: 'secret',
  })
  const storage = {
    getItem: () => stored,
    setItem: (_key: string, value: string) => { stored = value },
  }

  const settings = readStreamlineSettings(storage)
  assert.deepEqual(settings, {
    previewMode: true,
    sourceType: 'stream-hls',
    outputResolution: '640x360',
    bufferPriming: 0.5,
    probePreset: 'passthrough',
  })
  assert.deepEqual(JSON.parse(stored), settings)
})

test('writes only normalized display fields while preserving a safe probe preset', () => {
  let stored = JSON.stringify({ probePreset: 'overlay', rtmpKey: 'secret' })
  const storage = {
    getItem: () => stored,
    setItem: (_key: string, value: string) => { stored = value },
  }

  writeDisplaySettings({
    previewMode: false,
    sourceType: 'stream-rtmp',
    videoId: 'video-id',
    outputResolution: '1920x1080',
    bufferPriming: 12,
  }, storage)

  assert.deepEqual(JSON.parse(stored), {
    previewMode: false,
    sourceType: 'stream-rtmp',
    videoId: 'video-id',
    outputResolution: '1920x1080',
    bufferPriming: 10,
    probePreset: 'overlay',
  })
})
