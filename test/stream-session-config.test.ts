import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCoreSessionPlan,
  buildCoreStartRequest,
  buildProbeSessionPlan,
  buildProbeStartRequest,
  readStreamlineSettings,
} from '../src/lib/stream-session-config.ts'

test('builds a typed core preview request with ordered operations', () => {
  const plan = buildCoreSessionPlan({
    sourceType: 'stream-hls',
    videoId: 'video-id',
    outputResolution: '1920x1080',
    previewMode: true,
  }, {
    preset: 'overlay',
    annotationEnabled: true,
    filters: {
      blur: 2,
      brightness: 0,
      contrast: 1.2,
      saturation: 1,
      gamma: 1,
      sharpen: 0,
      flip: true,
      rotate: 90,
    },
    burnSubtitles: true,
  })

  assert.deepEqual(plan.pipeline.map((operation) => operation.op), [
    'overlay',
    'filter',
    'filter',
    'filter',
    'filter',
    'subtitle',
    'encode',
  ])
  assert.deepEqual(plan.pipeline[0], {
    op: 'overlay',
    params: { image: 'annotation', position: 'full' },
  })
  assert.deepEqual(plan.pipeline.find((operation) => operation.op === 'subtitle'), {
    op: 'subtitle',
    params: { source: 'auto' },
  })
  assert.deepEqual(plan.pipeline.at(-1), {
    op: 'encode',
    params: {
      codec: 'h264',
      preset: 'fast',
      bitrate: '1500k',
      resolution: '1920x1080',
    },
  })
  assert.deepEqual(buildCoreStartRequest(plan, 'session-1'), {
    input: {
      type: 'hls',
      url: 'https://videodelivery.net/video-id/manifest/video.m3u8',
    },
    pipeline: plan.pipeline,
    output: { mode: 'websocket', format: 'fmp4' },
    session_id: 'session-1',
  })
})

test('session-ID-fences RTMP output and keeps the static overlay exclusive', () => {
  const plan = buildCoreSessionPlan({
    sourceType: 'webcam',
    previewMode: false,
  }, {
    preset: 'overlay',
    annotationEnabled: false,
  })

  assert.deepEqual(plan.pipeline.map((operation) => operation.op), ['overlay', 'encode'])
  assert.equal(plan.pipeline.findLast((operation) => operation.op === 'encode')?.params.fps, 30)
  assert.deepEqual(buildCoreStartRequest(plan, 'session-2'), {
    input: { type: 'webcam' },
    pipeline: plan.pipeline,
    output: { mode: 'rtmp', profile: 'default' },
    session_id: 'session-2',
  })
})

test('rejects an unsupported rotation before sending a container request', () => {
  assert.throws(() => buildCoreSessionPlan({}, {
    preset: 'passthrough',
    annotationEnabled: false,
    filters: { rotate: 45 },
  }), /Rotate filter must be 0, 90, 180, or 270 degrees/)
})

test('builds selected HLS background and transformed webcam inputs for PiP', () => {
  const plan = buildCoreSessionPlan({
    sourceType: 'stream-hls',
    videoId: 'video-id',
    previewMode: false,
    outputResolution: '1920x1080',
  }, {
    preset: 'pip',
    annotationEnabled: false,
  })

  assert.deepEqual(plan.source, {
    kind: 'hls',
    url: 'https://videodelivery.net/video-id/manifest/video.m3u8',
    validationError: null,
  })
  assert.equal(plan.webcamIngest, true)
  assert.equal(plan.pipeline.findLast((operation) => operation.op === 'encode')?.params.fps, 30)
  assert.deepEqual(buildCoreStartRequest(plan, 'session-pip'), {
    inputs: [
      { type: 'hls', url: 'https://videodelivery.net/video-id/manifest/video.m3u8' },
      { type: 'webcam', transform: { scale: 0.25, position: 'top-right' } },
    ],
    pipeline: plan.pipeline,
    output: { mode: 'rtmp', profile: 'default' },
    session_id: 'session-pip',
  })
})

test('uses the selected RTMP background for PiP', () => {
  const plan = buildCoreSessionPlan({
    sourceType: 'stream-rtmp',
  }, {
    preset: 'pip',
    annotationEnabled: false,
  })

  assert.deepEqual(buildCoreStartRequest(plan, 'session-pip'), {
    inputs: [
      { type: 'rtmp', profile: 'default' },
      { type: 'webcam', transform: { scale: 0.25, position: 'top-right' } },
    ],
    pipeline: plan.pipeline,
    output: { mode: 'websocket', format: 'fmp4' },
    session_id: 'session-pip',
  })
})

test('rejects webcam-only PiP before sending a container request', () => {
  assert.throws(() => buildCoreSessionPlan({ sourceType: 'webcam' }, {
    preset: 'pip',
    annotationEnabled: false,
  }), /Picture-in-picture requires an HLS or RTMP input/)
})

test('reports a missing HLS source while RTMP uses the server profile', () => {
  const missingSource = buildCoreSessionPlan({
    sourceType: 'stream-hls',
  }, {
    preset: 'passthrough',
    annotationEnabled: false,
  })
  const serverDestination = buildCoreSessionPlan({
    previewMode: false,
  }, {
    preset: 'passthrough',
    annotationEnabled: false,
  })

  assert.throws(() => buildCoreStartRequest(missingSource), /Stream Video ID/)
  assert.deepEqual(buildCoreStartRequest(serverDestination).output, { mode: 'rtmp', profile: 'default' })
})

test('builds the default webcam probe plan', () => {
  const plan = buildProbeSessionPlan({}, false)
  const corePlan = buildCoreSessionPlan({}, { preset: 'passthrough', annotationEnabled: false })

  assert.deepEqual(plan.source, { kind: 'webcam', url: null, validationError: null })
  assert.equal(plan.outputMime, 'video/mp4; codecs="avc1.42C01F"')
  assert.deepEqual(plan.pipeline, [{
    op: 'encode',
    params: {
      codec: 'h264',
      preset: 'fast',
      bitrate: '1500k',
      resolution: '1280x720',
      fps: 30,
    },
  }])
  assert.deepEqual(plan.pipeline.at(-1), corePlan.pipeline.at(-1))
  assert.deepEqual(buildProbeStartRequest(plan, 'session-1'), {
    input: { type: 'webcam' },
    pipeline: plan.pipeline,
    output: { mode: 'websocket', format: 'fmp4' },
    session_id: 'session-1',
    diagnostics: true,
  })
  assert.deepEqual(plan.traceConfig, {
    sourceType: 'webcam',
    probePreset: 'passthrough',
    outputResolution: '1280x720',
    outputBitrate: '1500k',
    encodePreset: 'fast',
    annotationEnabled: false,
    bufferPrimingSeconds: 2,
    diagnostics: true,
  })
})

test('maps legacy Stream HLS settings to direct VOD input with audio playback', () => {
  const settings = readStreamlineSettings({
    getItem: () => JSON.stringify({
      sourceType: 'stream',
      videoId: 'video-id',
      bufferPriming: 3,
    }),
  })
  const plan = buildProbeSessionPlan(settings, false)

  assert.deepEqual(plan.source, {
    kind: 'hls',
    url: 'https://videodelivery.net/video-id/manifest/video.m3u8',
    validationError: null,
  })
  assert.equal(plan.outputMime, 'video/mp4; codecs="avc1.42C01F,mp4a.40.2"')
  assert.deepEqual(buildProbeStartRequest(plan, 'session-2'), {
    input: {
      type: 'hls',
      url: 'https://videodelivery.net/video-id/manifest/video.m3u8',
    },
    pipeline: plan.pipeline,
    output: { mode: 'websocket', format: 'fmp4' },
    session_id: 'session-2',
    diagnostics: true,
  })
  assert.equal(plan.traceConfig.bufferPrimingSeconds, 3)
})

test('preserves overlay ordering and the 1080p annotation MIME contract', () => {
  const plan = buildProbeSessionPlan({
    sourceType: 'stream-rtmp',
    probePreset: 'overlay',
    outputResolution: '1920x1080',
  }, true)

  assert.deepEqual(plan.pipeline.map((operation) => operation.op), ['overlay', 'overlay', 'encode'])
  assert.deepEqual(plan.pipeline[0], {
    op: 'overlay',
    params: { image: '/app/assets/streamline-logo.png', position: 'top-right' },
  })
  assert.deepEqual(plan.pipeline[1], {
    op: 'overlay',
    params: { image: 'annotation', position: 'full' },
  })
  assert.equal(plan.outputMime, 'video/mp4; codecs="avc1.42C028"')
  assert.equal(plan.traceConfig.outputBitrate, '1500k')
  const startRequest = buildProbeStartRequest(plan, null)
  assert.deepEqual(startRequest.input, { type: 'rtmp', profile: 'default' })
  assert.deepEqual(startRequest.output, { mode: 'websocket', format: 'fmp4' })
})

test('reports a missing HLS setting while RTMP uses the server profile', () => {
  const hls = buildProbeSessionPlan({ sourceType: 'stream-hls' }, false)
  const rtmp = buildProbeSessionPlan({ sourceType: 'stream-rtmp' }, false)

  assert.equal(hls.source.validationError, 'No Stream Video ID configured. Go to Settings.')
  assert.deepEqual(rtmp.source, { kind: 'rtmp', profile: 'default', validationError: null })
  assert.throws(() => buildProbeStartRequest(hls, null), /Stream Video ID/)
  assert.deepEqual(buildProbeStartRequest(rtmp, null).input, { type: 'rtmp', profile: 'default' })
})

test('reads settings defensively from local storage', () => {
  const storage = (value: string | null) => ({ getItem: () => value })

  assert.deepEqual(readStreamlineSettings(storage('{"sourceType":"webcam"}')), { sourceType: 'webcam' })
  assert.deepEqual(readStreamlineSettings(storage('not-json')), {})
  assert.deepEqual(readStreamlineSettings(storage('null')), {})
  assert.deepEqual(readStreamlineSettings(storage('[]')), {})
})

test('removes legacy RTMP and presentation URLs from browser storage', () => {
  let stored = JSON.stringify({
    streamUrl: 'rtmps://output',
    streamInputUrl: 'rtmps://input',
    streamPreviewUrl: 'https://example.com/input.m3u8',
    playbackUrl: 'https://example.com/player',
    sourceType: 'webcam',
  })
  const storage = {
    getItem: () => stored,
    setItem: (_key: string, value: string) => { stored = value },
  }

  assert.deepEqual(readStreamlineSettings(storage), { sourceType: 'webcam' })
  assert.equal(stored, '{"sourceType":"webcam"}')
})
