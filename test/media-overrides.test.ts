import assert from 'node:assert/strict'
import test from 'node:test'

import { getDeploymentProfile } from '../src/lib/deployment-profile.ts'
import { applyStartPolicy } from '../src/lib/media-policy.ts'
import {
  handleMediaOverrideRequest,
  hasMediaOverrides,
  MEDIA_OVERRIDES_KEY,
  mediaOverrideStatus,
  prepareMediaOverrideRequest,
  readMediaOverrides,
  resolveMediaProfileEnvironment,
  updateMediaOverrides,
} from '../src/lib/media-overrides.ts'

class MemoryStorage {
  values = new Map<string, unknown>()

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value)
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key)
  }
}

const INPUT_DEFAULT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OUTPUT_DEFAULT_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const INPUT_OVERRIDE_ID = 'cccccccccccccccccccccccccccccccc'
const OUTPUT_OVERRIDE_ID = 'dddddddddddddddddddddddddddddddd'
const INPUT_DEFAULT_KEY = 'default-input'
const OUTPUT_DEFAULT_KEY = 'default-output'
const env = {
  MEDIA_RTMP_INPUT_PROFILE: JSON.stringify({ key: INPUT_DEFAULT_KEY, liveInputId: INPUT_DEFAULT_ID }),
  MEDIA_RTMP_OUTPUT_PROFILE: JSON.stringify({ key: OUTPUT_DEFAULT_KEY, liveInputId: OUTPUT_DEFAULT_ID }),
}

test('stores validated owner profiles without changing deployment defaults', () => {
  const current = {}
  const overrides = updateMediaOverrides(current, {
    input: {
      key: ' owner-input ',
      liveInputId: INPUT_OVERRIDE_ID.toUpperCase(),
    },
    output: {
      key: 'owner-output',
      liveInputId: OUTPUT_OVERRIDE_ID,
    },
  }, 1234)

  assert.deepEqual(current, {})
  assert.deepEqual(overrides, {
    input: {
      key: 'owner-input',
      liveInputId: INPUT_OVERRIDE_ID,
      updatedAt: 1234,
    },
    output: {
      key: 'owner-output',
      liveInputId: OUTPUT_OVERRIDE_ID,
      updatedAt: 1234,
    },
  })
  assert.deepEqual(resolveMediaProfileEnvironment(env, overrides), {
    ...env,
    MEDIA_RTMP_INPUT_PROFILE: JSON.stringify({
      key: overrides.input?.key,
      liveInputId: INPUT_OVERRIDE_ID,
    }),
    MEDIA_RTMP_OUTPUT_PROFILE: JSON.stringify({
      key: overrides.output?.key,
      liveInputId: OUTPUT_OVERRIDE_ID,
    }),
  })
})

test('updates profiles atomically and null restores all deployment defaults', () => {
  const current = updateMediaOverrides({}, {
    input: {
      key: 'owner-input',
      liveInputId: INPUT_OVERRIDE_ID,
    },
    output: {
      key: 'owner-output',
      liveInputId: OUTPUT_OVERRIDE_ID,
    },
  }, 1000)
  const overrides = updateMediaOverrides(current, { input: null }, 2000)

  assert.deepEqual(overrides, { output: current.output })
  assert.equal(hasMediaOverrides(overrides), true)
  assert.equal(hasMediaOverrides(updateMediaOverrides(overrides, { output: null })), false)
})

test('applies paired overrides on start, falls back after clearing, and revalidates stored values', () => {
  const profile = getDeploymentProfile('owner')!
  const request = {
    input: { type: 'webcam' },
    pipeline: [{
      op: 'encode',
      params: { codec: 'h264', preset: 'fast', bitrate: '8000k', resolution: '1920x1080', fps: 30 },
    }],
    output: { mode: 'rtmp', profile: 'default' },
  }
  const override = {
    key: 'owner-output',
    liveInputId: OUTPUT_OVERRIDE_ID,
    updatedAt: 1,
  }
  const overridden = applyStartPolicy(request, resolveMediaProfileEnvironment(env, { output: override }), profile)
  const defaults = applyStartPolicy(request, resolveMediaProfileEnvironment(env, {}), profile)

  assert.equal((overridden.output as Record<string, unknown>).key, override.key)
  assert.equal((defaults.output as Record<string, unknown>).key, OUTPUT_DEFAULT_KEY)
  assert.throws(() => applyStartPolicy(
    request,
    resolveMediaProfileEnvironment(env, { output: { ...override, liveInputId: 'invalid' } }),
    profile,
  ), /Live Input ID/)
})

test('returns derived URLs without returning RTMPS URLs or stream keys', () => {
  const status = mediaOverrideStatus({
    input: {
      key: 'owner-input',
      liveInputId: INPUT_OVERRIDE_ID,
      updatedAt: 1234,
    },
  }, env)

  assert.deepEqual(status, {
    writable: true,
    input: {
      source: 'override',
      valid: true,
      updatedAt: 1234,
      hlsUrl: `https://videodelivery.net/${INPUT_OVERRIDE_ID}/manifest/video.m3u8`,
    },
    output: {
      source: 'default',
      valid: true,
      playerUrl: `https://iframe.videodelivery.net/${OUTPUT_DEFAULT_ID}`,
    },
  })
  assert.doesNotMatch(JSON.stringify(status), /owner-input|default-output/)
})

test('reports missing or incomplete defaults without exposing their values', () => {
  const config = {}
  assert.deepEqual(mediaOverrideStatus({}, config), {
    writable: true,
    input: { source: 'missing', valid: false },
    output: { source: 'missing', valid: false },
  })
  assert.deepEqual(mediaOverrideStatus({}, {
    ...config,
    MEDIA_RTMP_INPUT_PROFILE: JSON.stringify({ key: 'input-key' }),
  }).input, { source: 'default', valid: false })
})

test('rejects partial profiles, unexpected fields, and unsafe keys', () => {
  for (const value of [
    {},
    { unexpected: 'value' },
    { input: {} },
    { input: { key: 'input-key' } },
    { input: { key: 'path/segment', liveInputId: INPUT_OVERRIDE_ID } },
    { input: { key: 'input-key', liveInputId: 'not-an-id' } },
    { output: { key: 42, liveInputId: OUTPUT_OVERRIDE_ID } },
    { output: { rtmpsUrl: 'rtmps://live.cloudflare.com:443/live/key', liveInputId: OUTPUT_OVERRIDE_ID } },
  ]) {
    assert.throws(() => updateMediaOverrides({}, value), Error)
  }
})

test('requires a trusted principal and persists write-only API updates', async () => {
  const storage = new MemoryStorage()
  const unauthorized = await handleMediaOverrideRequest(
    new Request('https://example.com/api/media-overrides'),
    env,
    storage,
  )
  assert.equal(unauthorized.status, 401)

  const response = await handleMediaOverrideRequest(new Request('https://example.com/api/media-overrides', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Streamline-Principal': 'owner',
    },
    body: JSON.stringify({
      output: {
        key: 'owner-output',
        liveInputId: OUTPUT_OVERRIDE_ID,
      },
    }),
  }), env, storage)

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  const body = await response.json() as Record<string, Record<string, unknown>>
  assert.deepEqual(body.input, {
    source: 'default',
    valid: true,
    hlsUrl: `https://videodelivery.net/${INPUT_DEFAULT_ID}/manifest/video.m3u8`,
  })
  assert.equal(body.output.source, 'override')
  assert.equal(body.output.valid, true)
  assert.equal(typeof body.output.updatedAt, 'number')
  const stored = storage.values.get(MEDIA_OVERRIDES_KEY) as { output: { key: string } }
  assert.equal(stored.output.key, 'owner-output')
})

test('enforces the outer same-origin and request-shape boundary', async () => {
  const endpoint = 'https://example.com/api/media-overrides'
  const method = await prepareMediaOverrideRequest(new Request(endpoint, { method: 'POST' }))
  assert.equal((method as Response).status, 405)

  const crossOrigin = await prepareMediaOverrideRequest(new Request(endpoint, {
    method: 'PUT',
    headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
    body: '{}',
  }))
  assert.equal((crossOrigin as Response).status, 403)

  const wrongType = await prepareMediaOverrideRequest(new Request(endpoint, {
    method: 'PUT',
    headers: { Origin: 'https://example.com', 'Content-Type': 'text/plain' },
    body: '{}',
  }))
  assert.equal((wrongType as Response).status, 415)

  const oversized = await prepareMediaOverrideRequest(new Request(endpoint, {
    method: 'PUT',
    headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' },
    body: 'x'.repeat(5000),
  }))
  assert.equal((oversized as Response).status, 413)

  const prepared = await prepareMediaOverrideRequest(new Request(endpoint, {
    method: 'PUT',
    headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' },
    body: '{"output":null}',
  }))
  assert.equal(prepared instanceof Request, true)
  assert.equal(await (prepared as Request).text(), '{"output":null}')
})

test('clears persisted profiles without returning RTMPS keys', async () => {
  const storage = new MemoryStorage()
  storage.values.set(MEDIA_OVERRIDES_KEY, {
    output: {
      key: 'owner-output',
      liveInputId: OUTPUT_OVERRIDE_ID,
      updatedAt: 1234,
    },
  })
  const response = await handleMediaOverrideRequest(new Request('https://example.com/api/media-overrides', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Streamline-Principal': 'owner',
    },
    body: JSON.stringify({ output: null }),
  }), env, storage)

  assert.equal(response.status, 200)
  assert.equal(storage.values.has(MEDIA_OVERRIDES_KEY), false)
  assert.doesNotMatch(await response.text(), /owner-output|default-output/)
})

test('bounds and validates API update bodies', async () => {
  const headers = {
    'Content-Type': 'application/json',
    'X-Streamline-Principal': 'owner',
  }
  const storage = new MemoryStorage()
  const wrongType = await handleMediaOverrideRequest(new Request('https://example.com/api/media-overrides', {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'text/plain' },
    body: '{}',
  }), env, storage)
  assert.equal(wrongType.status, 415)

  const oversized = await handleMediaOverrideRequest(new Request('https://example.com/api/media-overrides', {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      output: {
        key: 'x'.repeat(5000),
        liveInputId: OUTPUT_OVERRIDE_ID,
      },
    }),
  }), env, storage)
  assert.equal(oversized.status, 413)
})

test('uses v2 overrides while discarding legacy full-URL overrides without parsing them', async () => {
  const storage = new MemoryStorage()
  const current = {
    output: {
      key: 'current-key',
      liveInputId: OUTPUT_OVERRIDE_ID,
      updatedAt: 5678,
    },
  }
  storage.values.set(MEDIA_OVERRIDES_KEY, current)
  storage.values.set('media-overrides', {
    output: {
      rtmpsUrl: 'rtmps://live.cloudflare.com:443/live/legacy-secret',
      liveInputId: OUTPUT_OVERRIDE_ID,
      updatedAt: 1234,
    },
  })

  assert.deepEqual(await readMediaOverrides(storage), current)
  assert.equal(storage.values.has('media-overrides'), false)
  assert.equal(storage.values.has(MEDIA_OVERRIDES_KEY), true)
})
