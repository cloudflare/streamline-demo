import { spawn, spawnSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const containerRoot = process.env.STREAMLINE_CONTAINER_SOURCE
  ? resolve(projectRoot, process.env.STREAMLINE_CONTAINER_SOURCE)
  : undefined
const containerImage = process.env.STREAMLINE_CONTAINER_IMAGE ?? 'streamline:latest'
const astroEntrypoint = fileURLToPath(new URL('../node_modules/astro/bin/astro.mjs', import.meta.url))
const healthUrl = 'http://localhost:8788/health'
const healthTimeoutMs = 30_000

/** @param {string[]} args */
export function parseStartLocalArgs(args) {
  if (args.length === 0) return { clean: false }
  if (args.length === 1 && args[0] === '--clean') return { clean: true }
  throw new Error('Usage: node scripts/start-local.mjs [--clean]')
}

/**
 * @typedef {{
 *   timeoutMs?: number,
 *   fetcher?: typeof fetch,
 *   now?: () => number,
 *   sleep?: (delayMs: number) => Promise<void>,
 *   url?: string,
 * }} ContainerHealthOptions
 */

/** @param {ContainerHealthOptions} options */
export async function waitForContainerHealth(options = {}) {
  const timeoutMs = options.timeoutMs ?? healthTimeoutMs
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs)))
  const deadline = now() + timeoutMs

  while (now() < deadline) {
    const remainingMs = deadline - now()
    try {
      const response = await fetcher(options.url ?? healthUrl, {
        signal: AbortSignal.timeout(Math.min(1_000, remainingMs)),
      })
      if (response.ok) return
    } catch {
      // Retry until the explicit startup deadline.
    }
    const delayMs = Math.min(1_000, deadline - now())
    if (delayMs > 0) await sleep(delayMs)
  }

  throw new Error(`Container did not become healthy within ${timeoutMs}ms`)
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 */
function runChecked(command, args, cwd = projectRoot) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`)
}

function removeLocalContainer() {
  spawnSync('docker', ['rm', '-f', 'streamline-dev'], { cwd: projectRoot, stdio: 'ignore' })
}

/**
 * @param {number | null} status
 * @param {NodeJS.Signals | null} signal
 * @returns {NodeJS.Signals | null}
 */
export function developmentServerExitSignal(status, signal) {
  if (signal === 'SIGINT' || signal === 'SIGTERM') return signal
  if (status === 0) return null
  if (status !== null) throw new Error(`Astro development server exited with status ${status}`)
  throw new Error(`Astro development server terminated by ${signal ?? 'an unknown signal'}`)
}

async function runDevelopmentServer() {
  const child = spawn(process.execPath, [astroEntrypoint, 'dev'], {
    cwd: projectRoot,
    env: { ...process.env, STREAMLINE_LOCAL_DEV: '1' },
    stdio: 'inherit',
  })
  const forwardSigint = () => child.kill('SIGINT')
  const forwardSigterm = () => child.kill('SIGTERM')
  process.once('SIGINT', forwardSigint)
  process.once('SIGTERM', forwardSigterm)
  try {
    const result = await new Promise((resolveExit, reject) => {
      child.once('error', reject)
      child.once('close', (status, signal) => resolveExit({ status, signal }))
    })
    return developmentServerExitSignal(result.status, result.signal)
  } finally {
    process.removeListener('SIGINT', forwardSigint)
    process.removeListener('SIGTERM', forwardSigterm)
  }
}

/**
 * @typedef {{
 *   waitForHealth?: () => Promise<void>,
 *   runDevelopmentServer?: () => Promise<NodeJS.Signals | null>,
 *   removeContainer?: () => void,
 * }} StartedLocalServicesOptions
 */

/** @param {StartedLocalServicesOptions} options */
export async function runStartedLocalServices(options = {}) {
  try {
    await (options.waitForHealth ?? waitForContainerHealth)()
    return await (options.runDevelopmentServer ?? runDevelopmentServer)()
  } catch (error) {
    const removeContainer = options.removeContainer ?? removeLocalContainer
    removeContainer()
    throw error
  }
}

/** @param {string[]} args */
async function main(args) {
  const { clean } = parseStartLocalArgs(args)
  removeLocalContainer()
  if (containerRoot) {
    runChecked('docker', ['build', ...(clean ? ['--no-cache'] : []), '-t', containerImage, '.'], containerRoot)
  } else if (!process.env.STREAMLINE_CONTAINER_IMAGE) {
    throw new Error('Set STREAMLINE_CONTAINER_SOURCE to a Streamline container directory or STREAMLINE_CONTAINER_IMAGE to a local image')
  }
  if (clean) {
    await Promise.all([
      rm(new URL('../dist/', import.meta.url), { recursive: true, force: true }),
      rm(new URL('../node_modules/.vite/', import.meta.url), { recursive: true, force: true }),
      rm(new URL('../node_modules/.vite-dev/', import.meta.url), { recursive: true, force: true }),
    ])
  }
  runChecked('docker', [
    'run', '-d', '--name', 'streamline-dev', '-p', '8788:8080',
    '-e', 'INSECURE_SKIP_VERIFY=1', containerImage,
  ])
  console.log('Waiting for container...')
  const signal = await runStartedLocalServices({
    waitForHealth: async () => {
      await waitForContainerHealth()
      console.log('Container ready')
    },
  })
  return signal
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invokedPath === import.meta.url) {
  main(process.argv.slice(2)).then((signal) => {
    if (signal) process.kill(process.pid, signal)
  }, (error) => {
    console.error(error instanceof Error ? error.message : 'Local development startup failed')
    process.exitCode = 1
  })
}
