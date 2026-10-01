import assert from 'node:assert/strict'
import test from 'node:test'

import {
  loadMediaOverrideStatus,
  SettingsRequestTimeoutError,
  updateMediaOverride,
} from '../src/lib/settings-api.ts'

const status = {
  writable: true,
  input: { source: 'missing' as const, valid: false },
  output: { source: 'missing' as const, valid: false },
}

test('loads and updates media override status through the focused API client', async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push({ input, init })
    return Response.json(status)
  }

  assert.deepEqual(await loadMediaOverrideStatus({ fetcher }), status)
  assert.deepEqual(await updateMediaOverride('input', {
    key: 'input-key',
    liveInputId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }, { fetcher }), status)
  assert.equal(requests[0].input, '/api/media-overrides')
  assert.equal(requests[0].init?.method, 'GET')
  assert.equal(requests[1].init?.method, 'PUT')
  assert.equal(requests[1].init?.body, JSON.stringify({
    input: {
      key: 'input-key',
      liveInputId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  }))
})

test('aborts media override requests at the configured timeout', async () => {
  const fetcher = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })

  await assert.rejects(loadMediaOverrideStatus({ fetcher, timeoutMs: 1 }), (error) => {
    assert.ok(error instanceof SettingsRequestTimeoutError)
    assert.match(error.message, /Settings request timed out/)
    return true
  })
})
