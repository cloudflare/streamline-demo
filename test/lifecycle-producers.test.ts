import assert from 'node:assert/strict'
import test from 'node:test'

import { AnnotationPublisher } from '../src/lib/annotation-publisher.ts'
import { WebcamIngestProducer, type WebcamIngestError } from '../src/lib/webcam-ingest-producer.ts'

async function waitFor(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(message)
}

class FakeMediaRecorder extends EventTarget {
  state: RecordingState = 'inactive'
  startCalls: number[] = []
  stopCalls = 0

  start(timeslice?: number) {
    this.state = 'recording'
    this.startCalls.push(timeslice ?? 0)
  }

  stop() {
    this.state = 'inactive'
    this.stopCalls++
  }

  emit(data: Blob) {
    const event = new Event('dataavailable')
    Object.defineProperty(event, 'data', { value: data })
    this.dispatchEvent(event)
  }

  emitError(error: unknown) {
    const event = new Event('error')
    Object.defineProperty(event, 'error', { value: error })
    this.dispatchEvent(event)
  }

  emitStop() {
    this.state = 'inactive'
    this.dispatchEvent(new Event('stop'))
  }
}

test('publishes session-ID-fenced PNG annotations only after playback starts', async () => {
  let playbackStarted = false
  const requests: Array<{ url: string; init: RequestInit }> = []
  const sent: number[] = []
  const publisher = new AnnotationPublisher({
    getBaseUrl: () => 'https://example.com',
    isActive: () => true,
    isPlaybackStarted: () => playbackStarted,
    intervalMs: 60_000,
    fetcher: async (input, init = {}) => {
      requests.push({ url: String(input), init })
      return new Response(null, { status: 204 })
    },
    onSent: (size) => sent.push(size),
  })
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
  publisher.start(blob, 'session-1')

  await publisher.publishNow()
  assert.equal(requests.length, 0)

  playbackStarted = true
  await publisher.publishNow()
  publisher.stop()

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://example.com/api/annotation')
  assert.equal(requests[0].init.method, 'PUT')
  assert.strictEqual(requests[0].init.body, blob)
  const headers = new Headers(requests[0].init.headers)
  assert.equal(headers.get('Content-Type'), 'image/png')
  assert.equal(headers.get('X-Streamline-Session-ID'), 'session-1')
  assert.deepEqual(sent, [3])
})

test('aborts an annotation request without reporting a stale-run error', async () => {
  const errors: unknown[] = []
  let requestStarted = false
  const publisher = new AnnotationPublisher({
    getBaseUrl: () => 'https://example.com',
    isActive: () => true,
    isPlaybackStarted: () => true,
    intervalMs: 60_000,
    fetcher: (_input, init = {}) => new Promise((_resolve, reject) => {
      requestStarted = true
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }),
    onError: (error) => errors.push(error),
  })
  publisher.start(new Blob(['png']), 'session-1')

  const publishing = publisher.publishNow()
  await waitFor(() => requestStarted, 'annotation request did not start')
  publisher.stop()
  await publishing

  assert.deepEqual(errors, [])
})

test('publishes replacement annotation snapshots immediately', async () => {
  const bodies: Blob[] = []
  const publisher = new AnnotationPublisher({
    getBaseUrl: () => 'https://example.com',
    isActive: () => true,
    intervalMs: 60_000,
    fetcher: async (_input, init = {}) => {
      bodies.push(init.body as Blob)
      return new Response(null, { status: 204 })
    },
  })
  const initial = new Blob(['initial'])
  const cleared = new Blob([])
  const next = new Blob(['next'])

  publisher.start(initial, null)
  await waitFor(() => bodies.length === 1, 'initial annotation was not published')
  await publisher.setBlob(cleared)
  await publisher.setBlob(next)
  publisher.stop()

  assert.deepEqual(bodies, [initial, cleared, next])
})

test('coalesces in-flight annotation replacements to the latest snapshot', async () => {
  const bodies: Blob[] = []
  const resolvers: Array<(response: Response) => void> = []
  const publisher = new AnnotationPublisher({
    getBaseUrl: () => 'https://example.com',
    isActive: () => true,
    intervalMs: 60_000,
    fetcher: async (_input, init = {}) => {
      bodies.push(init.body as Blob)
      return new Promise((resolve) => resolvers.push(resolve))
    },
  })
  const initial = new Blob(['initial'])
  const cleared = new Blob([])
  const latest = new Blob(['latest'])

  publisher.start(initial, null)
  await waitFor(() => bodies.length === 1, 'initial annotation request did not start')
  const clearing = publisher.setBlob(cleared)
  const replacing = publisher.setBlob(latest)
  resolvers[0](new Response(null, { status: 204 }))
  await waitFor(() => bodies.length === 2, 'coalesced annotation request did not start')
  assert.strictEqual(bodies[1], latest)
  resolvers[1](new Response(null, { status: 204 }))
  await Promise.all([clearing, replacing])
  publisher.stop()

  assert.deepEqual(bodies, [initial, latest])
})

test('retries after 429 but halts periodic publishing after 409', async () => {
  const statuses = [429, 409]
  const errors: number[] = []
  let requests = 0
  const publisher = new AnnotationPublisher({
    getBaseUrl: () => 'https://example.com',
    isActive: () => true,
    intervalMs: 60_000,
    fetcher: async () => {
      requests++
      return new Response('not ready', { status: statuses.shift() ?? 204 })
    },
    onError: ({ status }) => {
      if (status !== undefined) errors.push(status)
    },
  })

  publisher.start(new Blob(['png']), null)
  await publisher.publishNow()
  await publisher.publishNow()
  await publisher.publishNow()
  publisher.stop()

  assert.equal(requests, 2)
  assert.deepEqual(errors, [429, 409])
})

test('publishes for an active RTMP session without a playback readiness gate', async () => {
  let requests = 0
  const publisher = new AnnotationPublisher({
    getBaseUrl: () => 'https://example.com',
    isActive: () => true,
    intervalMs: 60_000,
    fetcher: async () => {
      requests++
      return new Response(null, { status: 204 })
    },
  })

  publisher.start(new Blob(['png']), null)
  await waitFor(() => requests === 1, 'RTMP annotation was not published')
  publisher.stop()

  assert.equal(requests, 1)
})

test('serializes webcam ingest uploads and bounds queued bytes', async () => {
  const recorder = new FakeMediaRecorder()
  const requests: RequestInit[] = []
  const resolvers: Array<(response: Response) => void> = []
  const overflows: Array<[number, number]> = []
  const producer = new WebcamIngestProducer({
    getBaseUrl: () => 'https://example.com',
    maxQueueBytes: 8,
    now: () => 123,
    createRequestId: () => 'ingest-1',
    createRecorderStream: () => ({}) as MediaStream,
    createMediaRecorder: (_stream, options) => {
      assert.equal(options.mimeType, 'video/webm;codecs=vp8')
      assert.equal(options.videoBitsPerSecond, 2_500_000)
      return recorder as unknown as MediaRecorder
    },
    isTypeSupported: () => true,
    fetcher: async (_input, init = {}) => {
      requests.push(init)
      return new Promise((resolve) => resolvers.push(resolve))
    },
    onQueueOverflow: (pending, incoming) => overflows.push([pending, incoming]),
  })
  const stream = {
    getVideoTracks: () => [],
  } as unknown as MediaStream

  producer.start(stream, 'session-2')
  recorder.emit(new Blob([new Uint8Array(3)]))
  recorder.emit(new Blob([new Uint8Array(3)]))
  recorder.emit(new Blob([new Uint8Array(3)]))
  assert.deepEqual(producer.getStats(), {
    recorderState: 'recording',
    pendingBytes: 6,
    chunksSent: 2,
    pendingChunks: 2,
    requestsCompleted: 0,
    activeRequestId: null,
    activeRequestBytes: 0,
    activeRequestAgeMs: 0,
    lastRequestDurationMs: 0,
    lastRequestStatus: null,
    lastChunkAt: 123,
  })
  await waitFor(() => requests.length === 1, 'first ingest request did not start')

  assert.deepEqual(recorder.startCalls, [250])
  assert.deepEqual(overflows, [[6, 3]])
  assert.equal(requests.length, 1)
  assert.equal((requests[0].body as ArrayBuffer).byteLength, 3)
  const headers = new Headers(requests[0].headers)
  assert.equal(headers.get('Content-Type'), 'application/octet-stream')
  assert.equal(headers.get('X-Streamline-Session-ID'), 'session-2')
  assert.equal(headers.get('X-Ingest-Request-ID'), 'ingest-1')

  resolvers[0](new Response(null, { status: 204 }))
  await waitFor(() => requests.length === 2, 'second ingest request was not serialized')
  assert.equal((requests[1].body as ArrayBuffer).byteLength, 3)
  resolvers[1](new Response(null, { status: 204 }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await producer.stop()
  assert.equal(recorder.stopCalls, 1)
  assert.deepEqual(producer.getStats(), {
    recorderState: 'inactive',
    pendingBytes: 0,
    chunksSent: 0,
    pendingChunks: 0,
    requestsCompleted: 0,
    activeRequestId: null,
    activeRequestBytes: 0,
    activeRequestAgeMs: 0,
    lastRequestDurationMs: 0,
    lastRequestStatus: null,
    lastChunkAt: 0,
  })
})

test('reports the failed webcam ingest response', async () => {
  const recorder = new FakeMediaRecorder()
  const errors: unknown[] = []
  const producer = new WebcamIngestProducer({
    getBaseUrl: () => 'https://example.com',
    createRecorderStream: () => ({}) as MediaStream,
    createMediaRecorder: () => recorder as unknown as MediaRecorder,
    isTypeSupported: () => true,
    fetcher: async () => new Response('ffmpeg stdin closed', { status: 503 }),
    onUploadError: (error) => errors.push(error),
  })
  const stream = { getVideoTracks: () => [] } as unknown as MediaStream

  producer.start(stream, 'session-3')
  recorder.emit(new Blob([new Uint8Array(3)]))
  await waitFor(() => errors.length === 1, 'ingest error was not reported')
  await producer.stop()

  const [error] = errors as WebcamIngestError[]
  assert.equal(error.status, 503)
  assert.equal(error.responseBody, 'ffmpeg stdin closed')
  assert.equal(error.requestBytes, 3)
  assert.equal(typeof error.requestId, 'string')
  assert.equal(typeof error.durationMs, 'number')
})

test('aborts a webcam ingest request that stops responding', async () => {
  const recorder = new FakeMediaRecorder()
  const errors: WebcamIngestError[] = []
  const producer = new WebcamIngestProducer({
    getBaseUrl: () => 'https://example.com',
    uploadTimeoutMs: 5,
    createRequestId: () => 'timed-out-ingest',
    createRecorderStream: () => ({}) as MediaStream,
    createMediaRecorder: () => recorder as unknown as MediaRecorder,
    isTypeSupported: () => true,
    fetcher: (_input, init = {}) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    }),
    onUploadError: (error) => errors.push(error),
  })
  const stream = { getVideoTracks: () => [] } as unknown as MediaStream

  producer.start(stream, 'session-timeout')
  recorder.emit(new Blob([new Uint8Array(3)]))
  await waitFor(() => errors.length === 1, 'timed out ingest was not reported')

  assert.equal(errors[0].requestId, 'timed-out-ingest')
  assert.equal(errors[0].requestBytes, 3)
  assert.equal(errors[0].timedOut, true)
  assert.equal((errors[0].error as DOMException).name, 'TimeoutError')
  assert.ok((errors[0].durationMs ?? 0) >= 0)
  await producer.stop()
})

test('ignores a failed webcam ingest response from a stopped run', async () => {
  const firstRecorder = new FakeMediaRecorder()
  const secondRecorder = new FakeMediaRecorder()
  const recorders = [firstRecorder, secondRecorder]
  const errors: unknown[] = []
  const pending: { resolveBody?: (body: string) => void } = {}
  let requests = 0
  const producer = new WebcamIngestProducer({
    getBaseUrl: () => 'https://example.com',
    createRecorderStream: () => ({}) as MediaStream,
    createMediaRecorder: () => recorders.shift() as unknown as MediaRecorder,
    isTypeSupported: () => true,
    fetcher: async () => {
      requests++
      if (requests === 1) {
        const response = new Response(null, { status: 503 })
        response.text = () => new Promise((resolve) => {
          pending.resolveBody = resolve
        })
        return response
      }
      return new Response(null, { status: 204 })
    },
    onUploadError: (error) => errors.push(error),
  })
  const stream = { getVideoTracks: () => [] } as unknown as MediaStream

  producer.start(stream, 'session-1')
  firstRecorder.emit(new Blob(['first']))
  await waitFor(() => pending.resolveBody !== undefined, 'failed response body was not read')
  const stoppingFirst = producer.stop()
  producer.start(stream, 'session-2')
  secondRecorder.emit(new Blob(['second']))
  pending.resolveBody?.('old failure')
  await stoppingFirst
  await waitFor(() => requests === 2, 'new ingest request did not complete')

  assert.deepEqual(errors, [])
  await producer.stop()
})


test('aborts webcam ingest without reporting a stale-run upload error', async () => {
  const recorder = new FakeMediaRecorder()
  const errors: unknown[] = []
  let requestStarted = false
  const producer = new WebcamIngestProducer({
    getBaseUrl: () => 'https://example.com',
    createRecorderStream: () => ({}) as MediaStream,
    createMediaRecorder: () => recorder as unknown as MediaRecorder,
    isTypeSupported: () => true,
    fetcher: (_input, init = {}) => new Promise((_resolve, reject) => {
      requestStarted = true
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }),
    onUploadError: (error) => errors.push(error),
  })
  const stream = {
    getVideoTracks: () => [],
  } as unknown as MediaStream
  producer.start(stream, 'session-3')
  recorder.emit(new Blob([new Uint8Array(3)]))
  await waitFor(() => requestStarted, 'ingest request did not start')

  await producer.stop()

  assert.equal(recorder.stopCalls, 1)
  assert.deepEqual(errors, [])
})

test('an old webcam stop cannot reset a newly started run', async () => {
  const firstRecorder = new FakeMediaRecorder()
  const secondRecorder = new FakeMediaRecorder()
  const recorders = [firstRecorder, secondRecorder]
  const pending: { resolveFirst?: (response: Response) => void } = {}
  let requests = 0
  const producer = new WebcamIngestProducer({
    getBaseUrl: () => 'https://example.com',
    createRecorderStream: () => ({}) as MediaStream,
    createMediaRecorder: () => recorders.shift() as unknown as MediaRecorder,
    isTypeSupported: () => true,
    now: () => 456,
    fetcher: async () => {
      requests++
      if (requests === 1) {
        return new Promise((resolve) => {
          pending.resolveFirst = resolve
        })
      }
      return new Response(null, { status: 204 })
    },
  })
  const stream = { getVideoTracks: () => [] } as unknown as MediaStream

  producer.start(stream, 'session-1')
  firstRecorder.emit(new Blob(['first']))
  await waitFor(() => requests === 1, 'first ingest request did not start')
  const stoppingFirst = producer.stop()
  producer.start(stream, 'session-2')
  secondRecorder.emit(new Blob(['second']))
  await waitFor(() => requests === 2, 'second ingest request did not start')
  pending.resolveFirst?.(new Response(null, { status: 204 }))
  await stoppingFirst

  assert.deepEqual(producer.getStats(), {
    recorderState: 'recording',
    pendingBytes: 0,
    chunksSent: 1,
    pendingChunks: 0,
    requestsCompleted: 1,
    activeRequestId: null,
    activeRequestBytes: 0,
    activeRequestAgeMs: 0,
    lastRequestDurationMs: 0,
    lastRequestStatus: 204,
    lastChunkAt: 456,
  })
  assert.equal(firstRecorder.stopCalls, 1)
  assert.equal(secondRecorder.stopCalls, 0)
  await producer.stop()
})

test('reports MediaRecorder errors for the active run', async () => {
  const recorder = new FakeMediaRecorder()
  const errors: unknown[] = []
  const producer = new WebcamIngestProducer({
    getBaseUrl: () => 'https://example.com',
    createRecorderStream: () => ({}) as MediaStream,
    createMediaRecorder: () => recorder as unknown as MediaRecorder,
    isTypeSupported: () => true,
    onRecorderError: (error) => errors.push(error),
  })
  const stream = { getVideoTracks: () => [] } as unknown as MediaStream
  const error = new DOMException('recorder failed', 'UnknownError')

  producer.start(stream, null)
  recorder.emitError(error)
  await producer.stop()

  assert.deepEqual(errors, [error])
})

test('reports an unexpected MediaRecorder stop for the active run', async () => {
  const recorder = new FakeMediaRecorder()
  const errors: unknown[] = []
  const producer = new WebcamIngestProducer({
    getBaseUrl: () => 'https://example.com',
    createRecorderStream: () => ({}) as MediaStream,
    createMediaRecorder: () => recorder as unknown as MediaRecorder,
    isTypeSupported: () => true,
    onRecorderError: (error) => errors.push(error),
  })
  const stream = { getVideoTracks: () => [] } as unknown as MediaStream

  producer.start(stream, null)
  recorder.emitStop()
  await producer.stop()

  assert.equal((errors[0] as Error).message, 'MediaRecorder stopped unexpectedly')
})
