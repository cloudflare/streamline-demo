import assert from 'node:assert/strict'
import test from 'node:test'

import { buildProbeSessionPlan, buildProbeStartRequest } from '../src/lib/stream-session-config.ts'
import { StreamSessionController } from '../src/lib/stream-session-controller.ts'

test('prepares, starts, and session-ID-fences an HTTP session stop', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  let currentTime = 100
  const controller = new StreamSessionController({
    getBaseUrl: () => 'https://example.com',
    createRequestId: () => 'generated-id',
    now: () => currentTime,
    fetcher: async (input, init = {}) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/relay/prepare')) return Response.json({ session_id: 'session-1' })
      if (url.endsWith('/start')) return Response.json({ mode: 'webcam' })
      currentTime = 135
      return new Response(null, { status: 204 })
    },
  })

  const sessionId = await controller.createSession()
  controller.setSessionId(sessionId)
  const startRequest = buildProbeStartRequest(buildProbeSessionPlan({}, false), sessionId)
  const started = await controller.start(startRequest)
  const stopped = await controller.stop('stop-id')

  assert.deepEqual(started, { mode: 'webcam' })
  assert.deepEqual(stopped, {
    requestId: 'stop-id',
    sessionId: 'session-1',
    status: 204,
    durationMs: 35,
  })
  assert.equal(controller.sessionId, null)
  assert.deepEqual(calls.map((call) => call.url), [
    'https://example.com/relay/prepare',
    'https://example.com/start',
    'https://example.com/stop',
  ])
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), startRequest)
  const stopHeaders = new Headers(calls[2].init.headers)
  assert.equal(stopHeaders.get('X-Streamline-Session-ID'), 'session-1')
  assert.equal(stopHeaders.get('X-Stop-Request-ID'), 'stop-id')
  assert.equal(calls[2].init.keepalive, true)
})

test('aborts an in-flight start before sending stop', async () => {
  const paths: string[] = []
  const controller = new StreamSessionController({
    getBaseUrl: () => 'https://example.com',
    fetcher: (input, init = {}) => {
      const path = new URL(String(input)).pathname
      paths.push(path)
      if (path === '/start') {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('start aborted', 'AbortError'))
          })
        })
      }
      return Promise.resolve(new Response(null, { status: 204 }))
    },
  })
  controller.setSessionId('session-2')
  const startRequest = buildProbeStartRequest(buildProbeSessionPlan({}, false), 'session-2')

  const starting = controller.start(startRequest)
  const startRejected = assert.rejects(starting, { name: 'AbortError' })
  const stopped = await controller.stop('stop-id')
  await startRejected

  assert.deepEqual(paths, ['/start', '/stop'])
  assert.equal(stopped.sessionId, 'session-2')
  assert.ok('status' in stopped)
  assert.equal(stopped.status, 204)
})

test('waits for relay preparation and stops its committed session ID', async () => {
  const calls: string[] = []
  const controller = new StreamSessionController({
    getBaseUrl: () => 'https://example.com',
    fetcher: async (input) => {
      const path = new URL(String(input)).pathname
      calls.push(path)
      if (path === '/relay/prepare') {
        await new Promise((resolve) => setTimeout(resolve, 1))
        return Response.json({ session_id: 'committed-session' })
      }
      return new Response(null, { status: 204 })
    },
  })

  const preparing = controller.createSession()
  const stopped = await controller.stop('stop-during-prepare')

  assert.equal(await preparing, 'committed-session')
  assert.equal(stopped.sessionId, 'committed-session')
  assert.deepEqual(calls, ['/relay/prepare', '/stop'])
})

test('coalesces concurrent stop requests', async () => {
  const pending: { resolveStop?: (response: Response) => void } = {}
  let stopCalls = 0
  const controller = new StreamSessionController({
    getBaseUrl: () => 'https://example.com',
    fetcher: () => {
      stopCalls++
      return new Promise((resolve) => {
        pending.resolveStop = resolve
      })
    },
  })
  controller.setSessionId('session-stop')

  const first = controller.stop('first-id')
  const second = controller.stop('second-id')
  assert.strictEqual(first, second)
  assert.equal(stopCalls, 1)

  pending.resolveStop?.(new Response(null, { status: 204 }))
  const result = await first
  assert.equal(result.requestId, 'first-id')
})


test('times out stop requests and retains the active session ID for retry', async () => {
  const controller = new StreamSessionController({
    getBaseUrl: () => 'https://example.com',
    stopTimeoutMs: 1,
    fetcher: (_input, init = {}) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')))
    }),
  })
  controller.setSessionId('session-3')

  const result = await controller.stop('timeout-id')

  assert.ok('error' in result)
  assert.equal((result.error as Error).name, 'AbortError')
  assert.equal(controller.sessionId, 'session-3')
})

test('treats a non-2xx stop as an error and clears the session ID only after retry', async () => {
  const sessionIds: Array<string | null> = []
  let stopCalls = 0
  const controller = new StreamSessionController({
    getBaseUrl: () => 'https://example.com',
    fetcher: async (_input, init = {}) => {
      stopCalls++
      sessionIds.push(new Headers(init.headers).get('X-Streamline-Session-ID'))
      return stopCalls === 1
        ? new Response('still running', { status: 503 })
        : new Response(null, { status: 204 })
    },
  })
  controller.setSessionId('session-4')

  const failed = await controller.stop('first-stop')
  assert.ok('error' in failed)
  assert.equal(failed.status, 503)
  assert.match(String(failed.error), /still running/)
  assert.equal(controller.sessionId, 'session-4')

  const stopped = await controller.stop('retry-stop')
  assert.ok('status' in stopped)
  assert.equal(stopped.status, 204)
  assert.equal(controller.sessionId, null)
  assert.deepEqual(sessionIds, ['session-4', 'session-4'])
})

test('treats a superseded session ID as already stopped', async () => {
  const controller = new StreamSessionController({
    getBaseUrl: () => 'https://example.com',
    fetcher: async () => new Response('Relay session is no longer current', { status: 409 }),
  })
  controller.setSessionId('superseded-session')

  const result = await controller.stop('superseded-stop')

  assert.equal('error' in result, false)
  assert.equal(result.status, 409)
  assert.equal(controller.sessionId, null)
})

test('times out relay preparation and session start', async () => {
  const controller = new StreamSessionController({
    getBaseUrl: () => 'https://example.com',
    prepareTimeoutMs: 1,
    startTimeoutMs: 1,
    fetcher: (_input, init = {}) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(new DOMException('timed out', 'AbortError'))
      })
    }),
  })

  await assert.rejects(controller.createSession(), { name: 'AbortError' })
  controller.setSessionId('session-5')
  await assert.rejects(controller.start({
    input: { type: 'webcam' },
    pipeline: [],
    output: { mode: 'websocket' },
  }), { name: 'AbortError' })
})

test('allows pending relay or start work to be aborted explicitly', async () => {
  let requestStarted = false
  const controller = new StreamSessionController({
    getBaseUrl: () => 'https://example.com',
    fetcher: (_input, init = {}) => new Promise((_resolve, reject) => {
      requestStarted = true
      init.signal?.addEventListener('abort', () => {
        reject(new DOMException('cancelled', 'AbortError'))
      })
    }),
  })

  controller.setSessionId('session-6')
  const starting = controller.start({
    input: { type: 'webcam' },
    pipeline: [],
    output: { mode: 'websocket' },
  })
  assert.equal(requestStarted, true)
  controller.abortPendingRequests()

  await assert.rejects(starting, { name: 'AbortError' })
})

test('stops a cancelled relay with its own session ID', async () => {
  const captured: { init?: RequestInit } = {}
  const controller = new StreamSessionController({
    getBaseUrl: () => 'https://example.com',
    createRequestId: () => 'cancel-id',
    fetcher: async (_input, init = {}) => {
      captured.init = init
      return new Response(null, { status: 204 })
    },
  })

  await controller.stopCancelledRelay('stale-session')

  const headers = new Headers(captured.init?.headers)
  assert.equal(headers.get('X-Streamline-Session-ID'), 'stale-session')
  assert.equal(headers.get('X-Stop-Request-ID'), 'cancel-id')
})
