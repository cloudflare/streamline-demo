import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  developmentServerExitSignal,
  parseStartLocalArgs,
  runStartedLocalServices,
  waitForContainerHealth,
} from '../scripts/start-local.mjs'
import {
  buildWranglerArgs,
  sourceWranglerConfig,
} from '../scripts/wrangler-command.mjs'

test('maps local container commands to the shared script and clean flag', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.scripts['dev:container'], 'node scripts/start-local.mjs')
  assert.equal(pkg.scripts['dev:container:clean'], 'node scripts/start-local.mjs --clean')
  assert.match(pkg.scripts.typecheck, /tsc --project tsconfig\.scripts\.json/)
  assert.deepEqual(parseStartLocalArgs([]), { clean: false })
  assert.deepEqual(parseStartLocalArgs(['--clean']), { clean: true })
  assert.throws(() => parseStartLocalArgs(['--unknown']), /Usage/)
})

test('requires container health before the explicit deadline', async () => {
  let currentTime = 0
  let attempts = 0
  await waitForContainerHealth({
    timeoutMs: 3_000,
    now: () => currentTime,
    sleep: async (delayMs: number) => { currentTime += delayMs },
    fetcher: async () => new Response(null, { status: ++attempts === 2 ? 200 : 503 }),
  })
  assert.equal(attempts, 2)

  currentTime = 0
  await assert.rejects(waitForContainerHealth({
    timeoutMs: 2_000,
    now: () => currentTime,
    sleep: async (delayMs: number) => { currentTime += delayMs },
    fetcher: async () => { throw new Error('not ready') },
  }), /within 2000ms/)
})

test('uses the public Wrangler config when no private overlay is selected', () => {
  assert.deepEqual(buildWranglerArgs(['secret', 'list', '--env=', '--format', 'json']), [
    'secret',
    'list',
    '--env=',
    '--format',
    'json',
    '--config',
    sourceWranglerConfig,
  ])
  assert.equal(sourceWranglerConfig, fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)))
})

test('preserves normal development server signal termination', () => {
  assert.equal(developmentServerExitSignal(null, 'SIGINT'), 'SIGINT')
  assert.equal(developmentServerExitSignal(null, 'SIGTERM'), 'SIGTERM')
  assert.equal(developmentServerExitSignal(0, null), null)
  assert.throws(() => developmentServerExitSignal(null, 'SIGKILL'), /terminated by SIGKILL/)
})

test('removes a started container only when service startup fails', async () => {
  let removals = 0
  await assert.rejects(runStartedLocalServices({
    waitForHealth: async () => { throw new Error('health failed') },
    runDevelopmentServer: async () => null,
    removeContainer: () => { removals++ },
  }), /health failed/)
  assert.equal(removals, 1)

  const signal = await runStartedLocalServices({
    waitForHealth: async () => {},
    runDevelopmentServer: async () => 'SIGINT',
    removeContainer: () => { removals++ },
  })
  assert.equal(signal, 'SIGINT')
  assert.equal(removals, 1)

  const cleanExit = await runStartedLocalServices({
    waitForHealth: async () => {},
    runDevelopmentServer: async () => null,
    removeContainer: () => { removals++ },
  })
  assert.equal(cleanExit, null)
  assert.equal(removals, 1)
})
