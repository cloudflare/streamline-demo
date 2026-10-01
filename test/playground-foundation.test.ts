import assert from 'node:assert/strict'
import test from 'node:test'

import { createAnonymousPrincipalCookie, readAnonymousPrincipal } from '../src/lib/anonymous-principal.ts'
import { selectMediaContainerRoute } from '../src/lib/container-proxy.ts'
import { evaluateAdmission, evaluateAnnotation, evaluateLease } from '../src/lib/playground-coordinator-policy.ts'
import { PlaygroundCoordinator } from '../src/lib/playground-coordinator.ts'
import { playgroundTurnstileConfig, verifyPlaygroundAdmission } from '../src/lib/playground-admission.ts'
import { isUnsupportedPlaygroundPage } from '../src/lib/playground-pages.ts'
import { getDeploymentProfile } from '../src/lib/deployment-profile.ts'
import { applyPlaygroundStartPolicy, MediaPolicyError } from '../src/lib/media-policy.ts'

const secretEnv = { PLAYGROUND_PRINCIPAL_SECRET: 'a'.repeat(32) }
const principal = '6f1f3d76-a743-4d90-86dd-7df0c0f5f2f2'

test('anonymous principals use an authenticated host-only cookie', async () => {
  const issued = await createAnonymousPrincipalCookie(secretEnv, 1_000)
  assert.ok(issued)
  assert.match(issued.cookie, /^__Host-streamline-playground=/)
  assert.match(issued.cookie, /HttpOnly; Secure; SameSite=Strict$/)
  const request = new Request('https://playground.example/', { headers: { Cookie: issued.cookie.split(';', 1)[0] } })
  assert.deepEqual(await readAnonymousPrincipal(request, secretEnv, 1_001), issued.principal)
  const tampered = new Request('https://playground.example/', {
    headers: { Cookie: request.headers.get('Cookie')!.replace(issued.principal.id, principal) },
  })
  assert.equal(await readAnonymousPrincipal(tampered, secretEnv, 1_001), null)
  assert.equal(await readAnonymousPrincipal(request, { PLAYGROUND_PRINCIPAL_SECRET: 'short' }, 1_001), null)
})

test('Turnstile admission is configuration-bound and fails closed', async () => {
  const env = {
    PLAYGROUND_TURNSTILE_SECRET: 'turnstile-secret',
    PLAYGROUND_TURNSTILE_HOSTNAMES: 'playground.example',
    PLAYGROUND_TURNSTILE_ACTION: 'streamline-playground',
  }
  const request = new Request('https://playground.example/playground/admit', {
    headers: { 'CF-Connecting-IP': '192.0.2.1' },
  })
  assert.equal(playgroundTurnstileConfig({ ...env, PLAYGROUND_TURNSTILE_HOSTNAMES: '' }), null)
  assert.equal(await verifyPlaygroundAdmission(request, env, 'token', async () => Response.json({
    success: true,
    action: 'streamline-playground',
    hostname: 'playground.example',
  })), true)
  assert.equal(await verifyPlaygroundAdmission(request, env, 'token', async () => Response.json({
    success: true,
    action: 'other-action',
    hostname: 'playground.example',
  })), false)
})

test('coordinator policy rate-limits admission and permits only three active leases', () => {
  const now = 1_000_000
  assert.equal(evaluateAdmission(Array.from({ length: 6 }, () => now), now).decision.allowed, false)
  assert.equal(evaluateAdmission([now - 600_001], now).decision.allowed, true)
  assert.equal(evaluateAnnotation(Array.from({ length: 12 }, () => now), now).decision.allowed, false)
  const first = evaluateLease({}, 'one', now)
  const second = evaluateLease(first.leases, 'two', now)
  const third = evaluateLease(second.leases, 'three', now)
  const fourth = evaluateLease(third.leases, 'four', now)
  assert.equal(first.decision.acquired, true)
  assert.equal(evaluateLease(third.leases, 'one', now).decision.acquired, false)
  assert.equal(fourth.decision.allowed, false)
  assert.equal(evaluateLease(third.leases, 'four', now + 35 * 60 * 1000 + 1).decision.allowed, true)
})

test('coordinator prunes expired admission and annotation subjects', async () => {
  const state = {
    admissions: { expired: [Date.now() - 10 * 60 * 1000 - 1] },
    annotations: { expired: [Date.now() - 60 * 1000 - 1] },
    leases: { expired: Date.now() - 1 },
  }
  const coordinator = new PlaygroundCoordinator({
    storage: {
      transaction: async (callback) => callback({
        get: async <T>() => state as T,
        put: async <T>(_key: string, value: T) => { Object.assign(state, value as Partial<typeof state>) },
      }),
    },
  })

  await coordinator.admit('active')

  assert.equal('expired' in state.admissions, false)
  assert.equal('expired' in state.annotations, false)
  assert.equal('expired' in state.leases, false)
})

test('playground routes per principal and fixes the allowed media contract', () => {
  assert.equal(selectMediaContainerRoute('playground', principal), `streamline-demo-playground-${principal}`)
  assert.equal(selectMediaContainerRoute('playground', 'untrusted'), null)
  assert.equal(selectMediaContainerRoute('owner'), 'streamline-demo-config-v3')
  const profile = getDeploymentProfile('playground')!
  const request = applyPlaygroundStartPolicy({
    input: { type: 'webcam' },
    pipeline: [{ op: 'encode', params: { codec: 'h264' } }],
    output: { mode: 'websocket', format: 'fmp4' },
    session_id: 'session-id',
  }, profile)
  assert.deepEqual(request.input, { type: 'webcam' })
  assert.deepEqual(request.output, { mode: 'websocket', format: 'fmp4' })
  const logoPipeline = applyPlaygroundStartPolicy({
    input: { type: 'webcam' },
    pipeline: [
      { op: 'overlay', params: { image: '/app/assets/streamline-logo.png', position: 'top-right' } },
      { op: 'encode', params: { codec: 'h264' } },
    ],
    output: { mode: 'websocket', format: 'fmp4' },
    session_id: 'session-id',
  }, profile).pipeline as unknown[]
  assert.deepEqual(logoPipeline[0], { op: 'overlay', params: { image: '/app/assets/streamline-logo.png', position: 'top-right' } })
  const annotationPipeline = applyPlaygroundStartPolicy({
    input: { type: 'webcam' },
    pipeline: [
      { op: 'overlay', params: { image: 'annotation', position: 'full' } },
      { op: 'encode', params: { codec: 'h264' } },
    ],
    output: { mode: 'websocket', format: 'fmp4' },
    session_id: 'session-id',
  }, profile).pipeline as unknown[]
  assert.deepEqual(annotationPipeline[0], { op: 'overlay', params: { image: 'annotation', position: 'full' } })
  assert.throws(() => applyPlaygroundStartPolicy({
    input: { type: 'rtmp', profile: 'default' },
    pipeline: [{ op: 'encode', params: { codec: 'h264' } }],
    output: { mode: 'websocket', format: 'fmp4' },
  }, profile), MediaPolicyError)
  assert.throws(() => applyPlaygroundStartPolicy({
    input: { type: 'webcam' },
    pipeline: [{ op: 'encode', params: { codec: 'h264' } }],
    output: { mode: 'rtmp', profile: 'default' },
  }, profile), MediaPolicyError)
})

test('playground serves supported processing pages but not diagnostics', () => {
  assert.equal(isUnsupportedPlaygroundPage('/overlay'), false)
  assert.equal(isUnsupportedPlaygroundPage('/annotation'), false)
  assert.equal(isUnsupportedPlaygroundPage('/filters'), false)
  assert.equal(isUnsupportedPlaygroundPage('/pip'), false)
  assert.equal(isUnsupportedPlaygroundPage('/subtitles'), false)
  assert.equal(isUnsupportedPlaygroundPage('/probe'), true)
  assert.equal(isUnsupportedPlaygroundPage('/'), false)
  assert.equal(isUnsupportedPlaygroundPage('/settings'), false)
})
