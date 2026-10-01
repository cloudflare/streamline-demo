import assert from 'node:assert/strict'
import test from 'node:test'

import { withSecurityHeaders } from '../src/lib/security-headers.ts'

test('adds browser hardening headers and disables HTML caching', async () => {
  const response = withSecurityHeaders(new Response('<h1>Streamline</h1>', {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  }))

  assert.match(response.headers.get('Content-Security-Policy') || '', /script-src 'self'/)
  assert.match(response.headers.get('Content-Security-Policy') || '', /frame-ancestors 'none'/)
  assert.match(response.headers.get('Content-Security-Policy') || '', /frame-src[^;]*https:\/\/iframe\.videodelivery\.net/)
  assert.match(response.headers.get('Content-Security-Policy') || '', /img-src[^;]*https:\/\/\*\.videodelivery\.net/)
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY')
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer')
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(await response.text(), '<h1>Streamline</h1>')
})
