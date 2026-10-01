import { runWrangler } from './wrangler-command.mjs'

const required = [
  'PUBLISHER_ACCESS_CLIENT_ID',
  'PUBLISHER_ACCESS_CLIENT_SECRET',
]
const output = runWrangler(['secret', 'list', '--env=', '--format', 'json'])
/** @type {unknown} */
const parsed = JSON.parse(output)
if (!Array.isArray(parsed) || !parsed.every((secret) => (
  typeof secret === 'object' && secret !== null && 'name' in secret && typeof secret.name === 'string'
))) {
  throw new Error('Wrangler returned an invalid owner Worker secret list')
}
const configured = new Set(parsed.map((secret) => secret.name))
const missing = required.filter((name) => !configured.has(name))
if (missing.length > 0) throw new Error(`Missing owner Worker secrets: ${missing.join(', ')}`)

console.log(`Verified ${required.length} owner Worker secrets`)
