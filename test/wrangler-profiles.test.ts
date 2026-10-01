import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('keeps owner and public playground resources isolated', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'))
  const devConfig = JSON.parse(await readFile(new URL('../wrangler.dev.jsonc', import.meta.url), 'utf8'))
  const containerProxy = await readFile(new URL('../src/lib/container-proxy.ts', import.meta.url), 'utf8')
  const playground = config.env.playground

  assert.equal(config.name, 'your-streamline-owner')
  assert.equal(config.vars.DEPLOYMENT_PROFILE, 'owner')
  assert.deepEqual(config.compatibility_flags, [
    'global_fetch_strictly_public',
    'enable_request_signal',
    'request_signal_passthrough',
  ])
  assert.deepEqual(devConfig.compatibility_flags, config.compatibility_flags)
  assert.equal(config.containers[0].name, 'your-streamline-owner-media')
  assert.equal(config.containers[0].max_instances, 1)
  assert.equal(config.vars.MEDIA_RTMP_ALLOWED_HOSTS, undefined)
  assert.equal(config.vars.CONTAINER_ALLOWED_HOSTS, undefined)
  assert.equal(config.vars.STREAM_CUSTOMER_CODE, undefined)
  assert.equal(config.vars.STREAM_PLAYBACK_URL, undefined)
  assert.equal(playground.name, 'your-streamline-playground')
  assert.equal(playground.vars.DEPLOYMENT_PROFILE, 'playground')
  assert.equal(playground.vars.PUBLISHER_ACCESS_REQUIRED, 'false')
  assert.equal(
    playground.vars.PLAYGROUND_TURNSTILE_HOSTNAMES,
    'localhost,127.0.0.1,example.invalid',
  )
  assert.equal(playground.vars.PLAYGROUND_TURNSTILE_ACTION, 'streamline-playground')
  assert.equal(playground.vars.MEDIA_RTMP_ALLOWED_HOSTS, undefined)
  assert.equal(playground.vars.CONTAINER_ALLOWED_HOSTS, undefined)
  assert.equal(playground.vars.STREAM_CUSTOMER_CODE, undefined)
  assert.equal(playground.workers_dev, true)
  assert.equal(playground.preview_urls, false)
  assert.equal(playground.assets.run_worker_first, true)
  assert.equal(config.account_id, undefined)
  assert.equal(playground.account_id, undefined)
  assert.notEqual(playground.containers[0].name, config.containers[0].name)
  assert.ok(config.durable_objects.bindings.some((binding: { name: string }) => binding.name === 'PLAYGROUND_COORDINATOR'))
  assert.ok(playground.durable_objects.bindings.some((binding: { name: string }) => binding.name === 'PLAYGROUND_COORDINATOR'))
  assert.match(containerProxy, /MEDIA_CONTAINER_INSTANCE = 'streamline-demo-config-v3'/)
})
