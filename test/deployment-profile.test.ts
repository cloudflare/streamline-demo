import assert from 'node:assert/strict'
import test from 'node:test'

import { getDeploymentProfile, rejectDisabledDeployment } from '../src/lib/deployment-profile.ts'

test('enables only the bounded owner deployment', () => {
  const owner = getDeploymentProfile('owner')
  assert.equal(owner?.enabled, true)
  assert.deepEqual(owner?.limits, {
    maxWidth: 1920,
    maxHeight: 1080,
    maxFps: 30,
    maxBitrateBps: 8_000_000,
    maxSessionSeconds: 28_800,
  })
  assert.equal(rejectDisabledDeployment('owner'), null)
})

test('enables the bounded public playground but fails closed for missing or unknown profiles', () => {
  const playground = getDeploymentProfile('playground')
  assert.equal(playground?.enabled, true)
  assert.deepEqual(playground?.limits, {
    maxWidth: 1280,
    maxHeight: 720,
    maxFps: 30,
    maxBitrateBps: 3_000_000,
    maxSessionSeconds: 1_800,
  })
  assert.equal(rejectDisabledDeployment('playground'), null)
  assert.equal(rejectDisabledDeployment(undefined)?.status, 503)
  assert.equal(rejectDisabledDeployment('unknown')?.status, 503)
})
