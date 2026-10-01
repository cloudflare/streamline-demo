import assert from 'node:assert/strict'
import test from 'node:test'

import { injectPreviewRelay } from '../src/lib/start-request-relay.ts'

const relay = {
  url: 'wss://example.com/relay/publish',
  token: 'server-token',
}

test('injects and overwrites the server-owned preview relay', () => {
  const body = {
    input: { type: 'hls', url: 'https://example.com/video.m3u8' },
    output: {
      mode: 'websocket',
      format: 'fmp4',
      relay: { url: 'wss://attacker.example', token: 'caller-token' },
    },
  }

  assert.deepEqual(injectPreviewRelay(body, relay), {
    input: body.input,
    output: { mode: 'websocket', format: 'fmp4', relay },
  })
})

test('leaves missing or malformed output unchanged for container validation', () => {
  const missing = { input: { type: 'webcam' } }
  const malformed = { input: { type: 'webcam' }, output: 'websocket' }

  assert.strictEqual(injectPreviewRelay(missing, relay), missing)
  assert.strictEqual(injectPreviewRelay(malformed, relay), malformed)
})

test('does not inject a relay into RTMP output', () => {
  const body = {
    input: { type: 'webcam' },
    output: { mode: 'rtmp', destination: 'rtmps://example.com/live' },
  }

  assert.strictEqual(injectPreviewRelay(body, relay), body)
})

test('does not trust relay data attached to an invalid output mode', () => {
  const body = {
    input: { type: 'webcam' },
    output: {
      mode: '',
      relay: { url: 'wss://attacker.example', token: 'caller-token' },
    },
  }

  assert.strictEqual(injectPreviewRelay(body, relay), body)
})
