import assert from 'node:assert/strict'
import test from 'node:test'

import { createLocalContainerRequest, validateLocalContainerRequest } from '../src/lib/local-container-proxy.ts'
import { normalizeEmptyRequestBody, readBodyWithLimit } from '../src/lib/request-body.ts'

test('reads request bodies up to the configured byte limit', async () => {
  const accepted = new Request('https://example.com/start', {
    method: 'POST',
    body: '1234',
  })
  const rejected = new Request('https://example.com/start', {
    method: 'POST',
    body: '12345',
  })
  const declaredOversize = new Request('https://example.com/start', {
    method: 'POST',
    headers: { 'Content-Length': '5' },
    body: '1234',
  })

  assert.deepEqual(await readBodyWithLimit(accepted, 4), new TextEncoder().encode('1234'))
  assert.equal(await readBodyWithLimit(rejected, 4), null)
  assert.equal(await readBodyWithLimit(declaredOversize, 4), null)
})

test('accepts zero-byte request streams but rejects request payloads', async () => {
  const absent = new Request('https://example.com/relay/prepare', { method: 'POST' })
  const emptyStream = new Request('https://example.com/relay/prepare', {
    method: 'POST',
    body: '',
  })
  const payload = new Request('https://example.com/relay/prepare', {
    method: 'POST',
    body: 'x',
  })

  assert.notEqual(emptyStream.body, null)
  assert.equal(await normalizeEmptyRequestBody(absent), absent)
  const normalized = await normalizeEmptyRequestBody(emptyStream)
  assert.ok(normalized)
  assert.equal(normalized.body, null)
  assert.equal(normalized.method, 'POST')
  assert.equal(normalized.redirect, emptyStream.redirect)
  assert.equal(await normalizeEmptyRequestBody(payload), null)
})

test('proxies Astro HTTP routes to the local container without a production binding', async () => {
  const proxiedRequest = createLocalContainerRequest(new Request('http://localhost:4321/start?debug=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"input":{"type":"webcam"}}',
  }))

  assert.equal(proxiedRequest.url, 'http://localhost:8788/start?debug=1')
  assert.equal(proxiedRequest.method, 'POST')
  assert.equal(proxiedRequest.headers.get('Content-Type'), 'application/json')
  assert.equal(await proxiedRequest.text(), '{"input":{"type":"webcam"}}')
})

test('requires same-origin typed requests for local control routes', () => {
  const valid = new Request('http://localhost:4321/start', {
    method: 'POST',
    headers: {
      Origin: 'http://localhost:4321',
      'Content-Type': 'application/json',
    },
  })
  const crossOrigin = new Request('http://localhost:4321/stop', {
    method: 'POST',
    headers: { Origin: 'https://example.test' },
  })
  const wrongContentType = new Request('http://localhost:4321/start', {
    method: 'POST',
    headers: {
      Origin: 'http://localhost:4321',
      'Content-Type': 'text/plain',
    },
  })

  assert.equal(validateLocalContainerRequest(valid), null)
  assert.equal(validateLocalContainerRequest(crossOrigin)?.status, 403)
  assert.equal(validateLocalContainerRequest(wrongContentType)?.status, 415)
})
