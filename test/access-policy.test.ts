import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ownerApplicationPolicy,
  planPolicyReconciliation,
  policyPlanBlockers,
  policyUpdateRequest,
} from '../scripts/access-policy.mjs'

test('owner policy admits both the owner email and employee domain', () => {
  assert.deepEqual(ownerApplicationPolicy('owner@example.com', 'cloudflare.com'), {
    name: 'Allow Streamline owner and employees',
    decision: 'allow',
    precedence: 1,
    include: [
      { email: { email: 'owner@example.com' } },
      { email_domain: { domain: 'cloudflare.com' } },
    ],
  })
})

test('reuses the sole legacy policy when renaming it', () => {
  const legacy = {
    id: 'legacy-policy',
    name: 'Allow the Streamline owner email',
    decision: 'allow',
    precedence: 1,
  }
  const desired = ownerApplicationPolicy('owner@example.com', 'cloudflare.com')
  assert.deepEqual(planPolicyReconciliation([legacy], desired, ['Allow the Streamline owner email']), {
    matching: legacy,
    obsolete: [],
  })
})

test('does not adopt an unknown sole policy', () => {
  const desired = ownerApplicationPolicy('owner@example.com', 'cloudflare.com')
  const unknown = { id: 'unknown', name: 'Manually managed policy', precedence: 1 }

  assert.deepEqual(planPolicyReconciliation([unknown], desired), {
    matching: undefined,
    obsolete: [unknown],
  })
})

test('does not select an unknown policy by precedence when several exist', () => {
  const desired = ownerApplicationPolicy('owner@example.com', 'cloudflare.com')
  const policies = [
    { id: 'unknown-one', name: 'Unknown one', precedence: 1 },
    { id: 'unknown-two', name: 'Unknown two', precedence: 2 },
  ]
  assert.deepEqual(planPolicyReconciliation(policies, desired), {
    matching: undefined,
    obsolete: policies,
  })
})

test('keeps the desired policy and removes other policies', () => {
  const desired = ownerApplicationPolicy('owner@example.com', 'cloudflare.com')
  const current = { id: 'current', ...desired }
  const obsolete = { id: 'obsolete', name: 'Manual policy', decision: 'allow', precedence: 2 }
  assert.deepEqual(planPolicyReconciliation([obsolete, current], desired), {
    matching: current,
    obsolete: [obsolete],
  })
})

test('prefers the exact desired name over a legacy name regardless of list order', () => {
  const desired = ownerApplicationPolicy('owner@example.com', 'cloudflare.com')
  const legacy = { id: 'legacy', name: 'Allow the Streamline owner email', decision: 'allow', precedence: 1 }
  const current = { id: 'current', ...desired }

  assert.deepEqual(planPolicyReconciliation(
    [legacy, current],
    desired,
    ['Allow the Streamline owner email'],
  ), {
    matching: current,
    obsolete: [legacy],
  })
})

test('updates reusable policies through the account endpoint without precedence', () => {
  const desired = ownerApplicationPolicy('owner@example.com', 'cloudflare.com')
  assert.deepEqual(policyUpdateRequest('application', {
    id: 'reusable-policy',
    reusable: true,
  }, desired), {
    path: '/access/policies/reusable-policy',
    body: {
      name: 'Allow Streamline owner and employees',
      decision: 'allow',
      include: [
        { email: { email: 'owner@example.com' } },
        { email_domain: { domain: 'cloudflare.com' } },
      ],
    },
  })
})

test('updates legacy policies through the application endpoint', () => {
  const desired = ownerApplicationPolicy('owner@example.com', 'cloudflare.com')
  assert.deepEqual(policyUpdateRequest('application', { id: 'legacy-policy' }, desired), {
    path: '/access/apps/application/policies/legacy-policy',
    body: desired,
  })
})

test('blocks updates to reusable policies shared by multiple applications', () => {
  assert.deepEqual(policyPlanBlockers({
    policies: [],
    matching: { name: 'Shared policy', reusable: true, app_count: 2 },
    obsolete: [],
  }), ['Shared policy is reusable across 2 applications'])
})

test('blocks automatic removal of additional reusable policies', () => {
  assert.deepEqual(policyPlanBlockers({
    policies: [],
    matching: { name: 'Managed policy' },
    obsolete: [{ name: 'Shared extra', reusable: true }],
  }), ['additional reusable policies require manual detachment: Shared extra'])
})
