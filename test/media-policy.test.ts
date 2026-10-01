import assert from 'node:assert/strict'
import test from 'node:test'

import { getDeploymentProfile } from '../src/lib/deployment-profile.ts'
import {
  applyLocalStartPolicy,
  applyStartPolicy,
  MediaPolicyError,
  publisherAccessCredentials,
} from '../src/lib/media-policy.ts'

const owner = getDeploymentProfile('owner')!
const inputKey = 'input-secret'
const outputKey = 'output-secret'
const env = {
  MEDIA_PROFILE_ID: 'default',
  MEDIA_RTMP_INPUT_PROFILE: JSON.stringify({
    key: inputKey,
    liveInputId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }),
  MEDIA_RTMP_OUTPUT_PROFILE: JSON.stringify({
    key: outputKey,
    liveInputId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  }),
}
const pipeline = [{
  op: 'encode',
  params: { codec: 'h264', preset: 'fast', bitrate: '8000k', resolution: '1920x1080', fps: 30 },
}]

test('enables explicitly requested diagnostics only in local development', () => {
  const request = {
    input: { type: 'webcam' },
    pipeline,
    output: { mode: 'websocket' },
    diagnostics: true,
  }

  assert.equal(applyStartPolicy(request, env, owner).diagnostics, false)
  assert.equal(applyLocalStartPolicy(request, env, owner).diagnostics, true)
  assert.equal(applyLocalStartPolicy({ ...request, diagnostics: false }, env, owner).diagnostics, false)
})

test('resolves named RTMP profiles without trusting browser destinations', () => {
  const resolved = applyStartPolicy({
    input: { type: 'rtmp', profile: 'default', url: 'rtmps://attacker.example/input', key: 'attacker-input' },
    pipeline,
    output: {
      mode: 'rtmp', profile: 'default', destination: 'rtmps://attacker.example/output', key: 'attacker-output',
    },
    session_id: 'session',
  }, env, owner)

  assert.deepEqual(resolved.input, { type: 'rtmp', key: inputKey })
  assert.deepEqual(resolved.output, { mode: 'rtmp', key: outputKey })
})

test('resolves direct PiP inputs without trusting browser media fields', () => {
  const resolved = applyStartPolicy({
    inputs: [
      {
        type: 'rtmp',
        profile: 'default',
        url: 'rtmps://attacker.example/input',
        key: 'attacker-input',
      },
      {
        type: 'webcam',
        url: 'https://attacker.example/webcam',
        key: 'attacker-webcam',
        transform: { scale: 0.25, position: 'top-right', x: 999 },
      },
    ],
    pipeline,
    output: { mode: 'rtmp', profile: 'default' },
    session_id: 'session-pip',
  }, env, owner)

  assert.deepEqual(resolved.inputs, [
    { type: 'rtmp', key: inputKey },
    { type: 'webcam', transform: { scale: 0.25, position: 'top-right' } },
  ])
  assert.deepEqual(resolved.output, { mode: 'rtmp', key: outputKey })
  assert.equal('input' in resolved, false)

  const hls = applyStartPolicy({
    inputs: [
      { type: 'hls', url: 'https://videodelivery.net/video_123/manifest/video.m3u8' },
      { type: 'webcam', transform: { scale: 0.25, position: 'top-right' } },
    ],
    pipeline,
    output: { mode: 'websocket' },
  }, env, owner)
  assert.deepEqual(hls.inputs, [
    { type: 'hls', url: 'https://videodelivery.net/video_123/manifest/video.m3u8' },
    { type: 'webcam', transform: { scale: 0.25, position: 'top-right' } },
  ])
})

test('rejects unsupported PiP input topology and transforms', () => {
  const request = (inputs: unknown) => ({
    inputs,
    pipeline,
    output: { mode: 'websocket' },
  })

  assert.throws(() => applyStartPolicy({
    ...request([
      { type: 'rtmp', profile: 'default' },
      { type: 'webcam', transform: { scale: 0.25, position: 'top-right' } },
    ]),
    input: { type: 'webcam' },
  }, env, owner), /exactly one of input or inputs/)
  assert.throws(() => applyStartPolicy(request([
    { type: 'webcam' },
    { type: 'rtmp', profile: 'default', transform: { scale: 0.25, position: 'top-right' } },
  ]), env, owner), /HLS or RTMP primary input followed by one webcam input/)
  assert.throws(() => applyStartPolicy(request([
    { type: 'rtmp', profile: 'default' },
    { type: 'webcam', transform: { scale: 0, position: 'top-right' } },
  ]), env, owner), /transform.scale must be between 0 and 1/)
  assert.throws(() => applyStartPolicy(request([
    { type: 'rtmp', profile: 'default' },
    { type: 'webcam', transform: { scale: 0.25, position: 'center' } },
  ]), env, owner), /transform.position is invalid/)
})

test('accepts only canonical Cloudflare Stream HLS manifests', () => {
  const valid = applyStartPolicy({
    input: { type: 'hls', url: 'https://videodelivery.net/video_123/manifest/video.m3u8' },
    pipeline,
    output: { mode: 'websocket', format: 'fmp4' },
  }, env, owner)
  assert.deepEqual(valid.input, {
    type: 'hls',
    url: 'https://videodelivery.net/video_123/manifest/video.m3u8',
  })

  assert.throws(() => applyStartPolicy({
    input: { type: 'hls', url: 'https://example.com/video.m3u8' },
    pipeline,
    output: { mode: 'websocket' },
  }, env, owner), MediaPolicyError)
  for (const suffix of ['?token=untrusted', '#fragment']) {
    assert.throws(() => applyStartPolicy({
      input: { type: 'hls', url: `https://videodelivery.net/video_123/manifest/video.m3u8${suffix}` },
      pipeline,
      output: { mode: 'websocket' },
    }, env, owner), /Cloudflare Stream manifest/)
  }
})

test('reconstructs every supported pipeline operation from exact fields', () => {
  const requestPipeline = [
    { op: 'overlay', params: { image: '/app/assets/cf-logo.png', position: 'top-right' } },
    { op: 'overlay', params: { image: 'annotation', position: 'full' } },
    { op: 'filter', params: { preset: 'blur', amount: 2 } },
    { op: 'filter', params: { preset: 'brightness', amount: -0.5 } },
    { op: 'filter', params: { preset: 'contrast', amount: 1.5 } },
    { op: 'filter', params: { preset: 'gamma', amount: 1.2 } },
    { op: 'filter', params: { preset: 'saturation', amount: 0.5 } },
    { op: 'filter', params: { preset: 'sharpen', amount: 3 } },
    { op: 'filter', params: { preset: 'flip' } },
    { op: 'filter', params: { preset: 'rotate', degrees: 270 } },
    { op: 'subtitle', params: { source: 'auto' } },
    { op: 'encode', params: { codec: 'h264', preset: 'fast', bitrate: '1500k', resolution: '1280x720', fps: 30, gop: 60 } },
  ]
  const resolved = applyStartPolicy({
    input: { type: 'webcam' },
    pipeline: requestPipeline,
    output: { mode: 'websocket' },
  }, env, owner)

  assert.deepEqual(resolved.pipeline, requestPipeline)
  assert.notStrictEqual(resolved.pipeline, requestPipeline)
  for (let index = 0; index < requestPipeline.length; index++) {
    assert.notStrictEqual((resolved.pipeline as unknown[])[index], requestPipeline[index])
  }
})

test('rejects unknown and operation-specific pipeline fields', () => {
  const invalidOperations = [
    { op: 'overlay', params: { image: '/app/assets/cf-logo.png', position: 'top-right' }, ignored: true },
    { op: 'overlay', params: { image: '/app/assets/cf-logo.png', position: 'bottom-left' } },
    { op: 'overlay', params: { image: 'annotation', position: 'full', opacity: 0.5 } },
    { op: 'subtitle', params: { source: 'auto', language: 'en' } },
    { op: 'filter', params: { preset: 'blur' } },
    { op: 'filter', params: { preset: 'brightness', amount: 2 } },
    { op: 'filter', params: { preset: 'toString', amount: 1 } },
    { op: 'filter', params: { preset: 'flip', amount: 1 } },
    { op: 'filter', params: { preset: 'rotate', degrees: 45 } },
    { op: 'encode', params: { codec: 'h264', tune: 'zerolatency' } },
    { op: 'encode', params: { codec: 'h264', fps: '30' } },
    { op: 'encode', params: { codec: 'h264', gop: 0 } },
  ]

  for (const operation of invalidOperations) {
    assert.throws(() => applyStartPolicy({
      input: { type: 'webcam' },
      pipeline: operation.op === 'encode' ? [operation] : [operation, ...pipeline],
      output: { mode: 'websocket' },
    }, env, owner), MediaPolicyError)
  }
})

test('canonicalizes an omitted optional subtitle source', () => {
  for (const subtitle of [{ op: 'subtitle' }, { op: 'subtitle', params: {} }]) {
    const resolved = applyStartPolicy({
      input: { type: 'webcam' },
      pipeline: [subtitle, ...pipeline],
      output: { mode: 'websocket' },
    }, env, owner)

    assert.deepEqual((resolved.pipeline as unknown[])[0], { op: 'subtitle', params: { source: 'auto' } })
  }
})

test('enforces owner encoding limits and disables synthetic input', () => {
  for (const params of [
    { codec: 'h264', resolution: '3840x2160' },
    { codec: 'h264', fps: 60 },
    { codec: 'h264', bitrate: '8.1M' },
    { codec: 'h264', preset: 'veryslow' },
    { codec: 'vp9' },
  ]) {
    assert.throws(() => applyStartPolicy({
      input: { type: 'webcam' },
      pipeline: [{ op: 'encode', params }],
      output: { mode: 'websocket' },
    }, env, owner), MediaPolicyError)
  }
  assert.throws(() => applyStartPolicy({
    input: { type: 'test' },
    pipeline,
    output: { mode: 'websocket' },
  }, env, owner), MediaPolicyError)
  assert.throws(() => applyStartPolicy({
    input: { type: 'webcam' },
    pipeline: [{ op: 'shell', params: {} }, ...pipeline],
    output: { mode: 'websocket' },
  }, env, owner), /operation is not supported/)
})

test('fails closed for missing media and publisher service credentials', () => {
  assert.throws(() => applyStartPolicy({
    input: { type: 'webcam' },
    pipeline,
    output: { mode: 'rtmp', profile: 'default' },
  }, {}, owner), /RTMP output profile is not configured/)

  assert.throws(() => applyStartPolicy({
    input: { type: 'webcam' },
    pipeline,
    output: { mode: 'rtmp', profile: 'default' },
  }, {
    ...env,
    MEDIA_RTMP_OUTPUT_PROFILE: JSON.stringify({ key: outputKey, liveInputId: '' }),
  }, owner), /Live Input ID/)

  assert.throws(() => applyStartPolicy({
    input: { type: 'webcam' },
    pipeline,
    output: { mode: 'rtmp', profile: 'default' },
  }, {
    ...env,
    MEDIA_RTMP_OUTPUT_PROFILE: JSON.stringify({
      rtmpsUrl: 'rtmps://live.cloudflare.com:443/live/legacy-secret',
      liveInputId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }),
  }, owner), /profile must contain key and liveInputId/)

  assert.throws(() => publisherAccessCredentials({ PUBLISHER_ACCESS_REQUIRED: 'true' }), /not configured/)
  assert.throws(() => publisherAccessCredentials({
    PUBLISHER_ACCESS_CLIENT_ID: 'id',
  }), /not configured/)
  assert.deepEqual(publisherAccessCredentials({
    PUBLISHER_ACCESS_CLIENT_ID: 'id',
    PUBLISHER_ACCESS_CLIENT_SECRET: 'secret',
  }), { client_id: 'id', client_secret: 'secret' })
})

test('requires a bounded URL-safe RTMP key', () => {
  for (const key of [
    '',
    'path/segment',
    'key?token=value',
    'key#fragment',
    'key with spaces',
    'rtmps://live.cloudflare.com:443/live/key',
    'unicode-key-ß',
    'x'.repeat(2012),
  ]) {
    assert.throws(() => applyStartPolicy({
      input: { type: 'webcam' },
      pipeline,
      output: { mode: 'rtmp', profile: 'default' },
    }, {
      ...env,
      MEDIA_RTMP_OUTPUT_PROFILE: JSON.stringify({
        key,
        liveInputId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }),
    }, owner), MediaPolicyError)
  }

  const maximumKey = 'x'.repeat(2011)
  const resolved = applyStartPolicy({
    input: { type: 'webcam' },
    pipeline,
    output: { mode: 'rtmp', profile: 'default' },
  }, {
    ...env,
    MEDIA_RTMP_OUTPUT_PROFILE: JSON.stringify({
      key: maximumKey,
      liveInputId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }),
  }, owner)
  assert.equal((resolved.output as Record<string, unknown>).key, maximumKey)
})
