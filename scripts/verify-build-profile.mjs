import { readdir, readFile } from 'node:fs/promises'

/**
 * @typedef {{
 *   name?: unknown,
 *   workers_dev?: unknown,
 *   preview_urls?: unknown,
 *   vars?: {
 *     DEPLOYMENT_PROFILE?: unknown,
 *     ALLOWED_ORIGINS: string,
 *     PLAYGROUND_TURNSTILE_HOSTNAMES?: unknown,
 *     CONTAINER_ALLOWED_HOSTS?: unknown,
 *     STREAM_CUSTOMER_CODE?: unknown,
 *   },
 *   containers?: Array<{ name?: unknown }>,
 *   durable_objects?: { bindings?: Array<{ name?: string }> },
 *   assets?: { run_worker_first?: unknown },
 * }} BuildConfig
 */

const expected = process.argv[2]
if (expected !== 'owner' && expected !== 'playground') {
  throw new Error('Expected build profile must be owner or playground')
}

/** @type {BuildConfig} */
const config = JSON.parse(await readFile(new URL('../dist/server/wrangler.json', import.meta.url), 'utf8'))
const workerEntry = await readFile(new URL('../dist/server/entry.mjs', import.meta.url), 'utf8')
const chunkDirectory = new URL('../dist/server/chunks/', import.meta.url)
const chunkNames = (await readdir(chunkDirectory)).filter((name) => name.endsWith('.mjs'))
const builtModules = [workerEntry, ...await Promise.all(
  chunkNames.map((name) => readFile(new URL(name, chunkDirectory), 'utf8')),
)].join('\n')
const outboundByHostRegistryDefinitions = builtModules.match(/\b(?:const|let|var)\s+outboundByHostRegistry\s*=/g) ?? []
const profile = config.vars?.DEPLOYMENT_PROFILE
if (profile !== expected) throw new Error(`Built ${String(profile)} profile while expecting ${expected}`)
if (typeof config.name !== 'string' || !config.name) throw new Error('Built Worker is missing a name')
if (typeof config.containers?.[0]?.name !== 'string' || !config.containers[0].name) {
  throw new Error('Built profile is missing a container name')
}
if (!config.durable_objects?.bindings?.some((binding) => binding.name === 'MEDIA_CONTAINER')) {
  throw new Error('Built profile is missing the MEDIA_CONTAINER binding')
}
if (workerEntry.includes('static outbound =') || workerEntry.includes('static outboundByHost =')) {
  throw new Error('Built Worker shadows a Containers SDK outbound-handler setter')
}
if (workerEntry.includes('MediaContainer.outbound =')) {
  throw new Error('Built Worker catch-all interception would capture raw RTMPS on port 443')
}
if (outboundByHostRegistryDefinitions.length !== 1) {
  throw new Error('Built Worker must contain one Containers SDK outbound-handler registry')
}
const allowedOrigins = config.vars?.ALLOWED_ORIGINS
if (typeof allowedOrigins !== 'string') throw new Error('Built profile is missing ALLOWED_ORIGINS')
const allowedOriginHost = new URL(allowedOrigins).hostname
if (!builtModules.includes(JSON.stringify(allowedOriginHost))) {
  throw new Error(`Built Worker does not intercept the configured publisher host ${allowedOriginHost}`)
}
if (config.vars?.CONTAINER_ALLOWED_HOSTS !== undefined) {
  throw new Error('Built Worker allowlist would force catch-all TLS interception')
}
if (config.vars?.STREAM_CUSTOMER_CODE !== undefined) {
  throw new Error('Built Worker must derive account-independent Stream presentation URLs')
}
if (!builtModules.includes('streamline-demo-config-v3') || builtModules.includes('streamline-demo-config-v2')) {
  throw new Error('Built Worker does not use the fresh host-specific-interception container instance')
}
if (expected === 'playground') {
  if (config.workers_dev !== true || config.preview_urls !== false) {
    throw new Error('Playground must enable its Workers.dev hostname without preview URLs')
  }
  const configuredTurnstileHosts = config.vars?.PLAYGROUND_TURNSTILE_HOSTNAMES
  if (typeof configuredTurnstileHosts !== 'string') {
    throw new Error('Playground is missing its Turnstile hostname allowlist')
  }
  const turnstileHosts = configuredTurnstileHosts.split(',').map((host) => host.trim().toLowerCase())
  if (!turnstileHosts.includes(allowedOriginHost)) {
    throw new Error('Playground Turnstile allowlist must include its public origin hostname')
  }
  if (config.assets?.run_worker_first !== true) {
    throw new Error('Playground assets must pass through the profile guard')
  }
}

console.log(`Verified ${expected} build profile`)
