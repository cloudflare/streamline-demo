import { readFile } from 'node:fs/promises'
import {
  ownerApplicationPolicy,
  planPolicyReconciliation,
  policyPlanBlockers,
  policyUpdateRequest,
} from './access-policy.mjs'
import { sourceWranglerConfig } from './deployment-config.mjs'
import { runWrangler } from './wrangler-command.mjs'

/**
 * @typedef {{
 *   id: string | null,
 *   name: string,
 *   domain: string,
 *   type: string,
 *   aud?: string,
 *   planned?: boolean,
 * }} AccessApplication
 */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   decision: string,
 *   precedence?: number,
 *   reusable?: boolean,
 *   app_count?: number,
 * }} AccessPolicy
 */

/**
 * @typedef {{
 *   name: string,
 *   decision: string,
 *   precedence: number,
 *   include: Array<Record<string, Record<string, string>>>,
 * }} DesiredPolicy
 */

/**
 * @typedef {{
 *   application: AccessApplication,
 *   desired: DesiredPolicy,
 *   matching: AccessPolicy | undefined,
 *   obsolete: AccessPolicy[],
 *   policies: AccessPolicy[],
 * }} PolicyPlan
 */

/** @typedef {{ id: string, name: string }} ServiceToken */
/** @typedef {ServiceToken & { client_id: string, client_secret: string }} CreatedServiceToken */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const args = new Set(process.argv.slice(2))
const phaseIndex = process.argv.indexOf('--phase')
const phase = phaseIndex === -1 ? 'prepare' : process.argv[phaseIndex + 1]
const apply = args.has('--apply')
if (phase !== 'prepare' && phase !== 'lock') throw new Error('--phase must be prepare or lock')

/** @type {unknown} */
const config = JSON.parse(await readFile(sourceWranglerConfig, 'utf8'))
if (!isRecord(config) || !isRecord(config.vars)) {
  throw new Error('The active Wrangler configuration must contain an account_id, name, and vars object')
}
const configVars = config.vars
const accountId = config.account_id
const allowedOrigins = configVars.ALLOWED_ORIGINS
const ownerEmail = configVars.ACCESS_OWNER_EMAIL
const employeeEmailDomain = configVars.ACCESS_EMPLOYEE_EMAIL_DOMAIN
const expectedAudience = configVars.ACCESS_OWNER_AUD
const configName = config.name
if (typeof accountId !== 'string'
  || typeof configName !== 'string'
  || typeof allowedOrigins !== 'string'
  || typeof expectedAudience !== 'string') {
  throw new Error('The active Wrangler configuration contains invalid Access configuration')
}
if (typeof ownerEmail !== 'string' || !ownerEmail
  || typeof employeeEmailDomain !== 'string' || !employeeEmailDomain) {
  throw new Error('Set ACCESS_OWNER_EMAIL and ACCESS_EMPLOYEE_EMAIL_DOMAIN in the active Wrangler configuration')
}
const apiToken = process.env.STREAMLINE_ACCESS_API_TOKEN
if (!apiToken) throw new Error('Set STREAMLINE_ACCESS_API_TOKEN to a restricted Access API token')

const hostname = new URL(allowedOrigins).host
const ownerDomain = hostname
const publisherDomain = `${hostname}/relay/publish`
const ownerAppName = 'Streamline Demo owner access'
const publisherAppName = 'Streamline relay publisher'
const serviceTokenName = 'Streamline relay publisher'
const accessApiTimeoutMs = 30_000

class AccessApiTimeoutError extends Error {
  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} cause
   */
  constructor(method, path, cause) {
    super(`${method} ${path} timed out after ${accessApiTimeoutMs}ms`, { cause })
    this.name = 'AccessApiTimeoutError'
  }
}

/**
 * @param {string} path
 * @param {RequestInit} init
 * @returns {Promise<Record<string, unknown>>}
 */
async function apiEnvelope(path, init = {}) {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(accessApiTimeoutMs),
    })
    /** @type {unknown} */
    const body = await response.json()
    if (!isRecord(body)) {
      throw new Error(`${init.method ?? 'GET'} ${path} returned an invalid response`)
    }
    if (!response.ok || body.success !== true) {
      throw new Error(`${init.method ?? 'GET'} ${path} failed (${response.status}): ${JSON.stringify(body.errors)}`)
    }
    return body
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new AccessApiTimeoutError(init.method ?? 'GET', path, error)
    }
    throw error
  }
}

/**
 * @template T
 * @param {string} path
 * @param {RequestInit} init
 * @returns {Promise<T>}
 */
async function api(path, init = {}) {
  return /** @type {T} */ ((await apiEnvelope(path, init)).result)
}

/**
 * @template T
 * @param {string} path
 * @returns {Promise<T[]>}
 */
async function listApi(path) {
  /** @type {unknown[]} */
  const results = []
  for (let page = 1; ; page++) {
    const separator = path.includes('?') ? '&' : '?'
    const body = await apiEnvelope(`${path}${separator}page=${page}&per_page=50`)
    if (!Array.isArray(body.result)) throw new Error(`GET ${path} did not return a list`)
    results.push(...body.result)
    const totalPages = isRecord(body.result_info) ? body.result_info.total_pages : undefined
    if ((typeof totalPages === 'number' && page >= totalPages) || (totalPages == null && body.result.length < 50)) {
      return /** @type {T[]} */ (results)
    }
  }
}

/**
 * @param {string[]} args
 * @param {string} [input]
 */
function wrangler(args, input) {
  const env = { ...process.env }
  delete env.CLOUDFLARE_API_TOKEN
  delete env.STREAMLINE_ACCESS_API_TOKEN
  return runWrangler(args, { env, input })
}

/**
 * @param {string} name
 * @param {string} value
 */
function putWorkerSecret(name, value) {
  wrangler(['secret', 'put', name, '--env='], `${value}\n`)
}

function workerSecretNames() {
  const output = wrangler(['secret', 'list', '--env=', '--format', 'json'])
  /** @type {unknown} */
  const parsed = JSON.parse(output)
  if (!Array.isArray(parsed) || !parsed.every((secret) => (
    isRecord(secret) && typeof secret.name === 'string'
  ))) {
    throw new Error('Wrangler returned an invalid owner Worker secret list')
  }
  return new Set(parsed.map((secret) => secret.name))
}

/**
 * @param {AccessApplication[]} applications
 * @param {string} name
 * @param {string} domain
 * @returns {Promise<AccessApplication>}
 */
async function ensureApplication(applications, name, domain) {
  let application = applications.find((candidate) => candidate.domain === domain)
  if (application) {
    if (application.type !== 'self_hosted') throw new Error(`${domain} is not a self-hosted Access application`)
    return application
  }
  if (!apply) return { id: null, name, domain, type: 'self_hosted', planned: true }
  /** @type {AccessApplication} */
  const createdApplication = await api('/access/apps', {
    method: 'POST',
    body: JSON.stringify({
      name,
      domain,
      type: 'self_hosted',
      session_duration: '24h',
      app_launcher_visible: false,
    }),
  })
  applications.push(createdApplication)
  return createdApplication
}

/**
 * @param {AccessApplication} application
 * @param {DesiredPolicy} desired
 * @param {string[]} previousNames
 * @returns {Promise<PolicyPlan>}
 */
async function createPolicyPlan(application, desired, previousNames = []) {
  if (!application.id) return { application, desired, matching: undefined, obsolete: [], policies: [] }
  /** @type {AccessPolicy[]} */
  const attached = await listApi(`/access/apps/${application.id}/policies`)
  const policies = attached.map((policy) => {
    const reusable = reusablePolicies.find((candidate) => candidate.id === policy.id)
    return reusable ? { ...policy, reusable: true, app_count: reusable.app_count } : policy
  })
  const { matching, obsolete } = planPolicyReconciliation(policies, desired, previousNames)
  return { application, desired, matching, obsolete, policies }
}

/** @param {PolicyPlan} plan */
function policyPlanResult(plan) {
  return {
    action: plan.matching ? 'update' : 'create',
    policy: plan.desired.name,
    remove: plan.obsolete.map((policy) => policy.name),
    blockedBy: policyPlanBlockers(plan),
  }
}

/** @param {PolicyPlan} plan */
async function applyPolicyPlan(plan) {
  const { application, desired, matching, obsolete } = plan
  if (!application.id) throw new Error(`Access application ${application.domain} has no id`)
  const blockers = policyPlanBlockers(plan)
  if (blockers.length) throw new Error(`${application.domain} policy preflight failed: ${blockers.join('; ')}`)
  if (matching) {
    const update = policyUpdateRequest(application.id, matching, desired)
    await api(update.path, {
      method: 'PUT',
      body: JSON.stringify(update.body),
    })
  } else {
    await api(`/access/apps/${application.id}/policies`, {
      method: 'POST',
      body: JSON.stringify(desired),
    })
  }
  for (const policy of obsolete) {
    await api(`/access/apps/${application.id}/policies/${policy.id}`, { method: 'DELETE' })
  }
  /** @type {AccessPolicy[]} */
  const finalPolicies = await listApi(`/access/apps/${application.id}/policies`)
  if (finalPolicies.length !== 1
    || finalPolicies[0].name !== desired.name
    || finalPolicies[0].decision !== desired.decision) {
    throw new Error(`Access policy reconciliation did not converge for ${application.domain}`)
  }
  return { action: 'reconciled', policy: desired.name, removed: obsolete.map((policy) => policy.name) }
}

/**
 * @param {string} detail
 * @param {unknown} cause
 */
function serviceTokenOutcomeUnknown(detail, cause) {
  return new Error(
    `Service token creation outcome is unknown: ${detail}. Inspect Access service tokens named "${serviceTokenName}" and remove any exact-name match before rerunning access preparation.`,
    { cause },
  )
}

/**
 * @param {AccessApiTimeoutError} timeoutError
 * @returns {Promise<never>}
 */
async function reconcileTimedOutServiceTokenCreation(timeoutError) {
  /** @type {ServiceToken[]} */
  let matchingTokens
  try {
    const tokens = await listApi(`/access/service_tokens?name=${encodeURIComponent(serviceTokenName)}`)
    matchingTokens = tokens.filter((token) => token.name === serviceTokenName)
  } catch (error) {
    throw serviceTokenOutcomeUnknown('the exact-name follow-up lookup failed', error)
  }

  if (matchingTokens.length === 0) {
    throw serviceTokenOutcomeUnknown(
      'the follow-up lookup did not show a token, but the timed-out request may still complete',
      timeoutError,
    )
  }
  if (matchingTokens.length !== 1 || typeof matchingTokens[0].id !== 'string') {
    throw serviceTokenOutcomeUnknown(
      `the follow-up lookup found ${matchingTokens.length} exact-name tokens and could not identify one safe token to delete`,
      timeoutError,
    )
  }

  const [createdToken] = matchingTokens
  try {
    await api(`/access/service_tokens/${createdToken.id}`, { method: 'DELETE' })
  } catch (error) {
    throw serviceTokenOutcomeUnknown(`token ${createdToken.id} was found but cleanup failed`, error)
  }
  throw new Error(
    `Service token creation timed out, but token ${createdToken.id} was found by exact name and deleted. Retry npm run access:prepare.`,
    { cause: timeoutError },
  )
}

/** @type {AccessApplication[]} */
const applications = await listApi('/access/apps')
/** @type {AccessPolicy[]} */
const reusablePolicies = await listApi('/access/policies')
const existingPublisherApp = applications.find((candidate) => candidate.domain === publisherDomain)
if (existingPublisherApp && existingPublisherApp.type !== 'self_hosted') {
  throw new Error(`${publisherDomain} is not a self-hosted Access application`)
}
if (phase === 'prepare' && existingPublisherApp?.id) {
  const existingPolicies = await listApi(`/access/apps/${existingPublisherApp.id}/policies`)
  if (existingPolicies.some((policy) => policy.decision === 'non_identity')) {
    throw new Error('Publisher Access is already locked; prepare will not downgrade it to Bypass')
  }
}

/** @type {ServiceToken[]} */
const serviceTokens = await listApi('/access/service_tokens')
let serviceToken = serviceTokens.find((candidate) => candidate.name === serviceTokenName)
let serviceTokenCreated = false
if (phase === 'lock' && !serviceToken) {
  throw new Error('Run npm run access:prepare before locking publisher Access')
}
if (apply && serviceToken) {
  const secrets = workerSecretNames()
  for (const name of ['PUBLISHER_ACCESS_CLIENT_ID', 'PUBLISHER_ACCESS_CLIENT_SECRET']) {
    if (!secrets.has(name)) {
      throw new Error(`Existing service token secret is unrecoverable and Worker secret ${name} is missing`)
    }
  }
}

const ownerApp = await ensureApplication(applications, ownerAppName, ownerDomain)
const publisherApp = await ensureApplication(applications, publisherAppName, publisherDomain)
if (ownerApp.aud && ownerApp.aud !== expectedAudience) {
  throw new Error(`Owner Access audience is ${ownerApp.aud}; the active Wrangler configuration expects ${expectedAudience}`)
}
const ownerPolicy = ownerApplicationPolicy(ownerEmail, employeeEmailDomain)
/** @type {DesiredPolicy} */
let publisherPolicy
if (phase === 'lock') {
  if (!serviceToken) throw new Error('Publisher service token disappeared during Access reconciliation')
  publisherPolicy = {
    name: 'Allow the Streamline relay service token',
    decision: 'non_identity',
    precedence: 1,
    include: [{ service_token: { token_id: serviceToken.id } }],
  }
} else {
  publisherPolicy = {
    name: 'Temporary bypass during Service Auth rollout',
    decision: 'bypass',
    precedence: 1,
    include: [{ everyone: {} }],
  }
}
const ownerPlan = await createPolicyPlan(ownerApp, ownerPolicy, [
  'Allow the Streamline owner email',
  `${configName} - Production`,
])
const publisherPlan = await createPolicyPlan(publisherApp, publisherPolicy, [
  'Temporary bypass during Service Auth rollout',
  'Allow the Streamline relay service token',
])
if (apply) {
  for (const plan of [ownerPlan, publisherPlan]) {
    const blockers = policyPlanBlockers(plan)
    if (blockers.length) {
      throw new Error(`${plan.application.domain} policy preflight failed: ${blockers.join('; ')}`)
    }
  }
}
const ownerResult = apply ? await applyPolicyPlan(ownerPlan) : policyPlanResult(ownerPlan)

if (!serviceToken && apply) {
  /** @type {CreatedServiceToken} */
  let createdToken
  try {
    createdToken = await api('/access/service_tokens', {
      method: 'POST',
      body: JSON.stringify({ name: serviceTokenName, duration: '8760h' }),
    })
  } catch (error) {
    if (error instanceof AccessApiTimeoutError) {
      await reconcileTimedOutServiceTokenCreation(error)
    }
    throw error
  }
  serviceToken = createdToken
  serviceTokenCreated = true
  try {
    putWorkerSecret('PUBLISHER_ACCESS_CLIENT_ID', createdToken.client_id)
    putWorkerSecret('PUBLISHER_ACCESS_CLIENT_SECRET', createdToken.client_secret)
  } catch (error) {
    await api(`/access/service_tokens/${createdToken.id}`, { method: 'DELETE' })
    throw error
  }
}
const publisherResult = apply ? await applyPolicyPlan(publisherPlan) : policyPlanResult(publisherPlan)

console.log(JSON.stringify({
  mode: apply ? 'applied' : 'plan',
  phase,
  owner: { domain: ownerDomain, audience: ownerApp.aud ?? '<created-on-apply>', result: ownerResult },
  publisher: { domain: publisherDomain, result: publisherResult },
  serviceToken: serviceToken
    ? { id: serviceToken.id, name: serviceToken.name, created: serviceTokenCreated }
    : { name: serviceTokenName, action: 'create during prepare' },
}, null, 2))
