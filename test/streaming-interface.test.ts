import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getSubtitlePresentation,
  shouldPollCoreMetrics,
  validateCoreStartResponse,
} from '../src/lib/streaming-interface.ts'
import { buildCoreSessionPlan } from '../src/lib/stream-session-config.ts'

test('validates the container output contract for preview and RTMP starts', () => {
  const preview = {
    status: 'started',
    mode: 'webcam',
    output: { mode: 'websocket', format: 'fmp4' },
  }
  const rtmp = {
    status: 'started',
    mode: 'direct',
    output: { mode: 'rtmp' },
  }

  assert.strictEqual(validateCoreStartResponse(preview, 'websocket'), preview)
  assert.strictEqual(validateCoreStartResponse(rtmp, 'rtmp'), rtmp)
  assert.throws(
    () => validateCoreStartResponse({ ...preview, output: { mode: 'websocket', format: 'mpegts' } }, 'websocket'),
    /invalid response/,
  )
  assert.throws(() => validateCoreStartResponse(rtmp, 'websocket'), /unexpected rtmp output/)
})

test('fully validates start response metadata before exposing it to the UI', () => {
  const response = {
    status: 'started',
    mode: 'direct',
    output: { mode: 'websocket', format: 'fmp4' },
    subtitle: { state: 'ready', language: 'en', cueCount: 12 },
  }
  assert.strictEqual(validateCoreStartResponse(response, 'websocket'), response)

  for (const invalid of [
    { ...response, status: 'starting' },
    { ...response, mode: 'unknown' },
    { ...response, subtitle: { state: 'ready', cueCount: -1 } },
    { ...response, subtitle: { state: 'ready', warning: 42 } },
    { status: 'started', mode: 'direct', output: { mode: 'rtmp', format: 'fmp4' } },
  ]) {
    assert.throws(() => validateCoreStartResponse(invalid, invalid.output.mode as 'websocket' | 'rtmp'), /invalid response/)
  }
})

test('presents ready and unavailable subtitle metadata without losing warnings', () => {
  assert.deepEqual(getSubtitlePresentation({
    state: 'ready',
    language: 'en',
    cueCount: 42,
  }), {
    visible: true,
    language: 'Language: en',
    cues: 'Cues: 42',
    message: 'Streaming with subtitle burn-in.',
    type: 'success',
  })

  assert.deepEqual(getSubtitlePresentation({
    state: 'unavailable',
    warning: 'No subtitle track was found.',
  }), {
    visible: true,
    language: 'Language: -',
    cues: 'Cues: -',
    message: 'No subtitle track was found.',
    type: 'warning',
  })
})

test('polls metrics only for VOD completion or RTMP output state', () => {
  const previewWebcam = buildCoreSessionPlan({}, {
    preset: 'passthrough',
    annotationEnabled: false,
  })
  const previewVod = buildCoreSessionPlan({
    sourceType: 'stream-hls',
    videoId: 'video-id',
  }, {
    preset: 'passthrough',
    annotationEnabled: false,
  })
  const previewRtmp = buildCoreSessionPlan({
    sourceType: 'stream-rtmp',
  }, {
    preset: 'passthrough',
    annotationEnabled: false,
  })
  const rtmpWebcam = buildCoreSessionPlan({
    previewMode: false,
  }, {
    preset: 'passthrough',
    annotationEnabled: false,
  })

  assert.equal(shouldPollCoreMetrics(previewWebcam), false)
  assert.equal(shouldPollCoreMetrics(previewVod), true)
  assert.equal(shouldPollCoreMetrics(previewRtmp), true)
  assert.equal(shouldPollCoreMetrics(rtmpWebcam), true)
})
