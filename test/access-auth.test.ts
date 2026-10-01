import assert from 'node:assert/strict'
import test from 'node:test'

import {
  authenticateAccessRequest,
  toInternalContainerRequest,
  withoutAccessServiceCredentials,
  withTrustedPrincipal,
} from '../src/lib/access-auth.ts'

const config = {
  teamDomain: 'team.cloudflareaccess.com',
  audience: 'owner-audience',
}

test('accepts verified identities admitted by the Access application policy', async () => {
  const request = new Request('https://example.com', {
    headers: { 'Cf-Access-Jwt-Assertion': 'signed-token' },
  })
  const identity = await authenticateAccessRequest(request, config, async () => ({
    type: 'app',
    email: 'Owner@Example.com',
    sub: 'owner-subject',
  }))
  assert.deepEqual(identity, { principal: 'owner-subject', email: 'owner@example.com' })

  assert.deepEqual(await authenticateAccessRequest(request, config, async () => ({
    type: 'app',
    email: 'other@example.com',
    sub: 'other-subject',
  })), { principal: 'other-subject', email: 'other@example.com' })
  assert.equal(await authenticateAccessRequest(new Request('https://example.com'), config), null)
})

test('rejects Access tokens without an application identity', async () => {
  const request = new Request('https://example.com', {
    headers: { 'Cf-Access-Jwt-Assertion': 'signed-token' },
  })
  for (const payload of [
    { type: 'service', email: 'user@example.com', sub: 'subject' },
    { type: 'app', sub: 'subject' },
    { type: 'app', email: 'user@example.com' },
  ]) {
    assert.equal(await authenticateAccessRequest(request, config, async () => payload), null)
  }
})

test('replaces caller principal headers and strips service credentials', () => {
  const request = new Request('https://example.com', {
    headers: {
      'X-Streamline-Principal': 'spoofed',
      'CF-Access-Client-Id': 'client-id',
      'CF-Access-Client-Secret': 'client-secret',
      Authorization: 'Bearer capability',
    },
  })
  const trusted = withTrustedPrincipal(request, 'verified')
  assert.equal(trusted.headers.get('X-Streamline-Principal'), 'verified')
  const stripped = withoutAccessServiceCredentials(trusted)
  assert.equal(stripped.headers.get('CF-Access-Client-Id'), null)
  assert.equal(stripped.headers.get('CF-Access-Client-Secret'), null)
  assert.equal(stripped.headers.get('Authorization'), 'Bearer capability')
})

test('forwards only protocol headers into the Durable Object and container', () => {
  const request = new Request('https://example.com/start', {
    headers: {
      Authorization: 'Bearer browser-token',
      Cookie: 'CF_Authorization=secret',
      'Cf-Access-Jwt-Assertion': 'access-jwt',
      'Cf-Container-Target-Port': '22',
      'Content-Type': 'application/json',
      Origin: 'https://example.com',
      'X-Streamline-Session-ID': 'session',
      'X-Streamline-Principal': 'verified',
    },
  })
  const internal = toInternalContainerRequest(request)
  assert.equal(internal.headers.get('Cookie'), null)
  assert.equal(internal.headers.get('Cf-Access-Jwt-Assertion'), null)
  assert.equal(internal.headers.get('Cf-Container-Target-Port'), null)
  assert.equal(internal.headers.get('Authorization'), null)
  assert.equal(internal.headers.get('Content-Type'), 'application/json')
  assert.equal(internal.headers.get('X-Streamline-Session-ID'), 'session')
  assert.equal(internal.headers.get('X-Streamline-Principal'), 'verified')

  assert.equal(toInternalContainerRequest(request, true).headers.get('Authorization'), 'Bearer browser-token')
})
