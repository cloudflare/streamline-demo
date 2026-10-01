import assert from 'node:assert/strict'
import test from 'node:test'

import { StreamSessionRuntime } from '../src/lib/stream-session-runtime.ts'

const unusedVideo = {} as HTMLMediaElement

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(message)
}

test('owns relay preparation, direct session start, and session-ID-fenced stop', async () => {
  const calls: Array<{ path: string; init: RequestInit }> = []
  const states: string[] = []
  const phases: string[] = []
  const runtime = new StreamSessionRuntime({
    getBaseUrl: () => 'https://example.com',
    video: unusedVideo,
    createRequestId: () => calls.length === 0 ? 'unused' : 'stop-id',
    fetcher: async (input, init = {}) => {
      const path = new URL(String(input)).pathname
      calls.push({ path, init })
      if (path === '/relay/prepare') return Response.json({ session_id: 'session-1' })
      if (path === '/start') {
        return Response.json({
          status: 'started',
          mode: 'direct',
          output: { mode: 'rtmp' },
        })
      }
      return new Response(null, { status: 204 })
    },
    onStateChange: (state) => states.push(state),
    onPhase: (phase) => phases.push(phase),
    onBeforeStopped: () => states.push('before-stopped'),
    onStopped: () => states.push('stopped-callback'),
  })

  const response = await runtime.start({
    source: { kind: 'rtmp', profile: 'default', validationError: null },
    outputMode: 'rtmp',
    outputMime: 'video/mp4; codecs="avc1.42C01F"',
    buildRequest: (sessionId) => ({
      input: { type: 'rtmp', url: 'rtmps://example.com/live/input' },
      output: { mode: 'rtmp', destination: 'rtmps://example.com/live/output' },
      session_id: sessionId,
    }),
  })

  assert.equal(response?.mode, 'direct')
  assert.equal(runtime.state, 'running')
  assert.equal(runtime.sessionId, 'session-1')
  assert.deepEqual(phases, ['preparing-relay', 'starting-container'])
  assert.deepEqual(states, ['starting', 'running'])
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
    input: { type: 'rtmp', url: 'rtmps://example.com/live/input' },
    output: { mode: 'rtmp', destination: 'rtmps://example.com/live/output' },
    session_id: 'session-1',
  })

  const stopped = await runtime.stop('manual')
  assert.equal(stopped.result && 'status' in stopped.result ? stopped.result.status : null, 204)
  assert.equal(runtime.state, 'idle')
  assert.equal(runtime.sessionId, null)
  assert.deepEqual(states, [
    'starting',
    'running',
    'stopping',
    'before-stopped',
    'idle',
    'stopped-callback',
  ])
  assert.deepEqual(calls.map(({ path }) => path), ['/relay/prepare', '/start', '/stop'])
})

test('validates before acquiring a webcam or preparing a relay', async () => {
  let mediaRequests = 0
  let fetchRequests = 0
  const runtime = new StreamSessionRuntime({
    getBaseUrl: () => 'https://example.com',
    video: unusedVideo,
    getUserMedia: async () => {
      mediaRequests++
      throw new Error('should not run')
    },
    fetcher: async () => {
      fetchRequests++
      return new Response(null, { status: 204 })
    },
  })

  await assert.rejects(runtime.start({
    source: { kind: 'webcam', url: null, validationError: null },
    outputMode: 'rtmp',
    outputMime: 'video/mp4',
    buildRequest: () => {
      throw new Error('RTMP output URL is required')
    },
  }), /RTMP output URL is required/)

  assert.equal(mediaRequests, 0)
  assert.equal(fetchRequests, 0)
  assert.equal(runtime.state, 'idle')
})

test('uploads webcam input for an RTMP-primary PiP session', async (t) => {
  const phases: string[] = []
  let trackStops = 0
  let recorderStarts = 0
  let recorderStops = 0
  const originalMediaStream = globalThis.MediaStream
  const originalMediaRecorder = globalThis.MediaRecorder

  class TestMediaStream {
    private readonly tracks: MediaStreamTrack[]
    constructor(tracks: MediaStreamTrack[]) {
      this.tracks = tracks
    }
    getVideoTracks() { return this.tracks }
  }
  class TestMediaRecorder extends EventTarget {
    static isTypeSupported() { return true }
    state: RecordingState = 'inactive'
    start() {
      this.state = 'recording'
      recorderStarts++
    }
    stop() {
      this.state = 'inactive'
      recorderStops++
    }
  }
  Object.assign(globalThis, {
    MediaStream: TestMediaStream,
    MediaRecorder: TestMediaRecorder,
  })
  t.after(() => Object.assign(globalThis, {
    MediaStream: originalMediaStream,
    MediaRecorder: originalMediaRecorder,
  }))

  const stream = {
    getVideoTracks: () => [{ stop: () => trackStops++ }],
    getTracks: () => [{ stop: () => trackStops++ }],
  } as unknown as MediaStream
  const runtime = new StreamSessionRuntime({
    getBaseUrl: () => 'https://example.com',
    video: unusedVideo,
    getUserMedia: async () => stream,
    fetcher: async (input) => {
      const path = new URL(String(input)).pathname
      if (path === '/relay/prepare') return Response.json({ session_id: 'session-pip' })
      if (path === '/start') return Response.json({ mode: 'direct' })
      return new Response(null, { status: 204 })
    },
    onPhase: (phase) => phases.push(phase),
  })

  await runtime.start({
    source: { kind: 'rtmp', profile: 'default', validationError: null },
    outputMode: 'rtmp',
    outputMime: 'video/mp4',
    webcamIngest: true,
    buildRequest: (sessionId) => ({
      inputs: [
        { type: 'rtmp', profile: 'default' },
        { type: 'webcam', transform: { scale: 0.25, position: 'top-right' } },
      ],
      session_id: sessionId,
    }),
  })

  assert.equal(recorderStarts, 1)
  assert.deepEqual(phases, ['requesting-webcam', 'preparing-relay', 'starting-container'])
  await runtime.stop('cleanup')
  assert.equal(recorderStops, 1)
  assert.equal(trackStops, 1)
})

test('detaches a cancelled start and does not continue after an awaited webcam callback', async () => {
  const paths: string[] = []
  let releaseWebcamCallback: (() => void) | null = null
  let webcamCallbackStarted = false
  let trackStops = 0
  const runtime = new StreamSessionRuntime({
    getBaseUrl: () => 'https://example.com',
    video: unusedVideo,
    getUserMedia: async () => ({
      getTracks: () => [{ stop: () => trackStops++ }],
    }) as unknown as MediaStream,
    onWebcamAcquired: () => {
      webcamCallbackStarted = true
      return new Promise((resolve) => {
        releaseWebcamCallback = resolve
      })
    },
    fetcher: async (input) => {
      const path = new URL(String(input)).pathname
      paths.push(path)
      if (path === '/relay/prepare') return Response.json({ session_id: 'session-2' })
      if (path === '/start') return Response.json({ mode: 'direct' })
      return new Response(null, { status: 204 })
    },
  })

  const cancelledStart = runtime.start({
    source: { kind: 'webcam', url: null, validationError: null },
    outputMode: 'rtmp',
    outputMime: 'video/mp4',
    buildRequest: (sessionId) => ({ input: { type: 'webcam' }, session_id: sessionId }),
  })
  await waitFor(() => webcamCallbackStarted, 'webcam callback did not start')
  await runtime.stop('cancelled')

  const restarted = await runtime.start({
    source: { kind: 'rtmp', profile: 'default', validationError: null },
    outputMode: 'rtmp',
    outputMime: 'video/mp4',
    buildRequest: (sessionId) => ({
      input: { type: 'rtmp', url: 'rtmps://example.com/live/input' },
      session_id: sessionId,
    }),
  })
  const release = releaseWebcamCallback as (() => void) | null
  release?.()

  assert.deepEqual(restarted, { mode: 'direct' })
  assert.equal(await cancelledStart, null)
  assert.equal(trackStops, 1)
  assert.deepEqual(paths, ['/relay/prepare', '/start'])
  await runtime.stop('cleanup')
})

test('stops a relay created while cancellation is in flight', async () => {
  const paths: string[] = []
  let prepareStarted = false
  let resolvePrepare: (response: Response) => void = () => {
    throw new Error('relay preparation was not started')
  }
  const runtime = new StreamSessionRuntime({
    getBaseUrl: () => 'https://example.com',
    video: unusedVideo,
    fetcher: async (input) => {
      const path = new URL(String(input)).pathname
      paths.push(path)
      if (path === '/relay/prepare') {
        prepareStarted = true
        return new Promise((resolve) => {
          resolvePrepare = resolve
        })
      }
      return new Response(null, { status: 204 })
    },
  })

  const starting = runtime.start({
    source: { kind: 'rtmp', profile: 'default', validationError: null },
    outputMode: 'rtmp',
    outputMime: 'video/mp4',
    buildRequest: (sessionId) => ({ input: { type: 'rtmp', profile: 'default' }, session_id: sessionId }),
  })
  await waitFor(() => prepareStarted, 'relay preparation did not start')

  const stopping = runtime.stop('cancelled')
  resolvePrepare(Response.json({ session_id: 'session-created-during-stop' }))

  const stopped = await stopping
  assert.equal(stopped.result && 'status' in stopped.result ? stopped.result.status : null, 204)
  assert.equal(await starting, null)
  assert.deepEqual(paths, ['/relay/prepare', '/stop'])
})

test('a manual stop owns the lifecycle when it races automatic completion', async () => {
  const states: string[] = []
  let completed = 0
  let manualStopStarted = false
  let runtime: StreamSessionRuntime
  runtime = new StreamSessionRuntime({
    getBaseUrl: () => 'https://example.com',
    video: unusedVideo,
    fetcher: async (input) => {
      const path = new URL(String(input)).pathname
      if (path === '/relay/prepare') return Response.json({ session_id: 'session-3' })
      if (path === '/start') return Response.json({ mode: 'direct' })
      if (path === '/metrics') {
        return Response.json({ running: true, sessionActive: false })
      }
      return new Response(null, { status: 204 })
    },
    onStateChange: (state) => {
      states.push(state)
      if (state === 'stopping' && !manualStopStarted) {
        manualStopStarted = true
        void runtime.stop('manual')
      }
    },
    onCompleted: () => completed++,
  })

  await runtime.start({
    source: { kind: 'rtmp', profile: 'default', validationError: null },
    outputMode: 'rtmp',
    outputMime: 'video/mp4',
    buildRequest: (sessionId) => ({
      input: { type: 'rtmp', url: 'rtmps://example.com/live/input' },
      session_id: sessionId,
    }),
    pollMetrics: true,
    completeOnInactiveMetrics: true,
  })
  await waitFor(() => runtime.state === 'idle', 'manual stop did not win completion race')

  assert.equal(completed, 0)
  assert.deepEqual(states, ['starting', 'running', 'stopping', 'stopping', 'idle'])
})

test('a public session does not poll owner-only metrics', async () => {
  let metricsRequests = 0
  const runtime = new StreamSessionRuntime({
    getBaseUrl: () => 'https://example.com',
    video: unusedVideo,
    prepareSession: async () => ({ pollMetrics: false }),
    fetcher: async (input) => {
      const path = new URL(String(input)).pathname
      if (path === '/relay/prepare') return Response.json({ session_id: 'session-public' })
      if (path === '/start') return Response.json({ mode: 'direct' })
      if (path === '/metrics') metricsRequests++
      return new Response(null, { status: 204 })
    },
  })

  await runtime.start({
    source: { kind: 'hls', url: 'https://videodelivery.net/video/manifest/video.m3u8', validationError: null },
    outputMode: 'rtmp',
    outputMime: 'video/mp4',
    buildRequest: (sessionId) => ({ input: { type: 'hls' }, session_id: sessionId }),
    pollMetrics: true,
    metricsIntervalMs: 1,
  })
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(metricsRequests, 0)
  await runtime.stop('cleanup')
})

test('captures the annotation after the container has started', async () => {
  const order: string[] = []
  const runtime = new StreamSessionRuntime({
    getBaseUrl: () => 'https://example.com',
    video: unusedVideo,
    fetcher: async (input) => {
      const path = new URL(String(input)).pathname
      if (path === '/relay/prepare') return Response.json({ session_id: 'session-4' })
      if (path === '/start') {
        order.push('container-started')
        return Response.json({ mode: 'direct' })
      }
      return new Response(null, { status: 204 })
    },
  })

  await runtime.start({
    source: { kind: 'rtmp', profile: 'default', validationError: null },
    outputMode: 'rtmp',
    outputMime: 'video/mp4',
    buildRequest: (sessionId) => ({
      input: { type: 'rtmp', url: 'rtmps://example.com/live/input' },
      session_id: sessionId,
    }),
    getAnnotationBlob: async () => {
      order.push('annotation-captured')
      return null
    },
  })

  assert.deepEqual(order, ['container-started', 'annotation-captured'])
  await runtime.stop('cleanup')
})

test('cleans up before complete state and notifies after it', async () => {
  const order: string[] = []
  const runtime = new StreamSessionRuntime({
    getBaseUrl: () => 'https://example.com',
    video: unusedVideo,
    fetcher: async (input) => {
      const path = new URL(String(input)).pathname
      if (path === '/relay/prepare') return Response.json({ session_id: 'session-5' })
      if (path === '/start') return Response.json({ mode: 'direct' })
      if (path === '/metrics') return Response.json({ running: true, sessionActive: false })
      return new Response(null, { status: 204 })
    },
    onStateChange: (state) => order.push(state),
    onBeforeCompleted: () => order.push('before-completed'),
    onCompleted: () => order.push('completed-callback'),
  })

  await runtime.start({
    source: { kind: 'rtmp', profile: 'default', validationError: null },
    outputMode: 'rtmp',
    outputMime: 'video/mp4',
    buildRequest: (sessionId) => ({
      input: { type: 'rtmp', url: 'rtmps://example.com/live/input' },
      session_id: sessionId,
    }),
    pollMetrics: true,
    completeOnInactiveMetrics: true,
  })
  await waitFor(() => runtime.state === 'complete', 'session did not complete')

  assert.deepEqual(order, [
    'starting',
    'running',
    'stopping',
    'before-completed',
    'complete',
    'completed-callback',
  ])
})
