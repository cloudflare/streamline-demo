import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { sourceWranglerConfig } from './deployment-config.mjs'

export { sourceWranglerConfig }

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const wranglerEntrypoint = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
export const WRANGLER_TIMEOUT_MS = 2 * 60 * 1000

/** @param {string[]} args */
export function buildWranglerArgs(args) {
  return [...args, '--config', sourceWranglerConfig]
}

/**
 * @typedef {{
 *   timeoutMs?: number,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   input?: string,
 * }} RunWranglerOptions
 */

/**
 * @param {string[]} args
 * @param {RunWranglerOptions} options
 */
export function runWrangler(args, options = {}) {
  const timeoutMs = options.timeoutMs ?? WRANGLER_TIMEOUT_MS
  const commandArgs = buildWranglerArgs(args)
  const result = spawnSync(process.execPath, [wranglerEntrypoint, ...commandArgs], {
    cwd: options.cwd ?? projectRoot,
    encoding: 'utf8',
    env: options.env ?? process.env,
    input: options.input,
    timeout: timeoutMs,
  })
  if (result.error) {
    if ('code' in result.error && result.error.code === 'ETIMEDOUT') {
      throw new Error(`wrangler ${commandArgs.join(' ')} timed out after ${timeoutMs}ms`)
    }
    throw new Error(`wrangler ${commandArgs.join(' ')} could not start: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`wrangler ${commandArgs.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`)
  }
  return result.stdout
}
