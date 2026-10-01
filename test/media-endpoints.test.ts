import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchMediaEndpoints } from '../src/lib/media-endpoints.ts'

const INPUT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OUTPUT_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

test('loads only validated derived Stream presentation URLs', async () => {
  const endpoints = await fetchMediaEndpoints({}, async (input, init) => {
    assert.equal(input, '/api/media-overrides')
    assert.deepEqual(init?.headers, { Accept: 'application/json' })
    assert.equal(init?.signal instanceof AbortSignal, true)
    return Response.json({
      input: {
        hlsUrl: `https://videodelivery.net/${INPUT_ID}/manifest/video.m3u8`,
      },
      output: {
        playerUrl: `https://iframe.videodelivery.net/${OUTPUT_ID}`,
      },
    })
  })

  assert.deepEqual(endpoints, {
    inputHlsUrl: `https://videodelivery.net/${INPUT_ID}/manifest/video.m3u8`,
    outputPlayerUrl: `https://iframe.videodelivery.net/${OUTPUT_ID}`,
  })
})

test('allows unavailable presentation URLs without exposing profile internals', async () => {
  const endpoints = await fetchMediaEndpoints({}, async () => Response.json({
    input: { source: 'missing', valid: false },
    output: { source: 'missing', valid: false },
  }))

  assert.deepEqual(endpoints, {})
})

test('rejects untrusted or malformed presentation responses', async () => {
  for (const response of [
    new Response('Unauthorized', { status: 401 }),
    Response.json({ input: {}, output: { playerUrl: 'https://attacker.example/video/iframe' } }),
    Response.json({ input: { hlsUrl: `https://videodelivery.net/${INPUT_ID}/file` }, output: {} }),
    Response.json({ input: {}, output: { playerUrl: `https://videodelivery.net/${OUTPUT_ID}` } }),
    Response.json({ input: null, output: {} }),
  ]) {
    await assert.rejects(() => fetchMediaEndpoints({}, async () => response), Error)
  }
})

test('bounds a stalled media profile request', async () => {
  await assert.rejects(() => fetchMediaEndpoints({ timeoutMs: 1 }, async (_input, init) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })
  }), /Aborted/)
})
