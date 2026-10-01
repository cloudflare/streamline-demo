import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { getMseMimeCandidates, MsePlayback } from '../src/lib/mse-playback.ts'

function ranges(values: Array<[number, number]>): TimeRanges {
  return {
    length: values.length,
    start: (index: number) => values[index][0],
    end: (index: number) => values[index][1],
  }
}

class FakeSourceBuffer extends EventTarget {
  mode = 'segments'
  updating = false
  buffered = ranges([])
  appended: Uint8Array[] = []
  removed: Array<[number, number]> = []
  appendError: unknown = null

  appendBuffer(data: Uint8Array) {
    if (this.appendError) throw this.appendError
    this.appended.push(data)
    this.updating = true
  }

  remove(start: number, end: number) {
    this.removed.push([start, end])
    this.updating = true
  }

  finishUpdate() {
    this.updating = false
    this.dispatchEvent(new Event('updateend'))
  }
}

class FakeMediaSource extends EventTarget {
  static supported = true
  static supportedMimeTypes: Set<string> | null = null

  static isTypeSupported(mimeType: string) {
    return this.supported && (!this.supportedMimeTypes || this.supportedMimeTypes.has(mimeType))
  }

  readyState = 'closed'
  readonly sourceBuffer = new FakeSourceBuffer()
  ended = false
  addSourceBufferCalls = 0
  addedMimeTypes: string[] = []

  addSourceBuffer(mimeType: string) {
    this.addSourceBufferCalls++
    this.addedMimeTypes.push(mimeType)
    return this.sourceBuffer
  }

  open() {
    this.readyState = 'open'
    this.dispatchEvent(new Event('sourceopen'))
  }

  endOfStream() {
    this.ended = true
    this.readyState = 'ended'
  }
}

const originalMediaSource = globalThis.MediaSource

afterEach(() => {
  FakeMediaSource.supported = true
  FakeMediaSource.supportedMimeTypes = null
  Object.defineProperty(globalThis, 'MediaSource', {
    configurable: true,
    value: originalMediaSource,
  })
})

function createVideo(buffered = ranges([])) {
  return {
    src: '',
    currentTime: 0,
    buffered,
    readyState: 4,
    paused: true,
    muted: false,
    play: async () => {},
  } as unknown as HTMLMediaElement
}

test('serializes appends and starts playback once the buffer is primed', async () => {
  Object.defineProperty(globalThis, 'MediaSource', {
    configurable: true,
    value: FakeMediaSource,
  })

  const mediaSource = new FakeMediaSource()
  const playbackStarts: number[] = []
  const video = createVideo(ranges([[0, 3]]))
  const playback = new MsePlayback({
    video,
    mode: 'sequence',
    getMinimumBufferSeconds: () => 2,
    mediaSourceFactory: () => mediaSource as unknown as MediaSource,
    createObjectURL: () => 'blob:test',
    revokeObjectURL: () => {},
    onPlaybackReady: (duration) => playbackStarts.push(duration),
  })

  const initialized = playback.init('video/mp4; codecs="avc1.42C01F"')
  mediaSource.open()
  await initialized

  assert.equal(mediaSource.sourceBuffer.mode, 'sequence')
  assert.equal(playback.append(new Uint8Array([1, 2])), true)
  assert.equal(playback.append(new Uint8Array([3, 4, 5])), true)
  assert.equal(mediaSource.sourceBuffer.appended.length, 1)
  assert.deepEqual(playbackStarts, [])
  assert.deepEqual(playback.getStats(), {
    queueChunks: 1,
    queueBytes: 3,
    ready: true,
    mediaSourceState: 'open',
    sourceBufferUpdating: true,
  })

  mediaSource.sourceBuffer.finishUpdate()

  assert.equal(mediaSource.sourceBuffer.appended.length, 2)
  assert.deepEqual(playbackStarts, [3])
})

test('plays and ends a completed buffer shorter than the priming threshold', async () => {
  Object.defineProperty(globalThis, 'MediaSource', {
    configurable: true,
    value: FakeMediaSource,
  })

  const mediaSource = new FakeMediaSource()
  const playbackStarts: number[] = []
  const playback = new MsePlayback({
    video: createVideo(ranges([[0, 0.5]])),
    getMinimumBufferSeconds: () => 2,
    mediaSourceFactory: () => mediaSource as unknown as MediaSource,
    createObjectURL: () => 'blob:test',
    revokeObjectURL: () => {},
    onPlaybackReady: (duration) => playbackStarts.push(duration),
  })

  const initialized = playback.init('video/mp4; codecs="avc1.42C01F"')
  mediaSource.open()
  await initialized
  playback.append(new Uint8Array([1, 2, 3]))
  playback.complete()
  assert.equal(mediaSource.ended, false)

  mediaSource.sourceBuffer.finishUpdate()

  assert.deepEqual(playbackStarts, [0.5])
  assert.equal(mediaSource.ended, true)
})

test('rejects queue growth past the configured byte limit once per session', async () => {
  Object.defineProperty(globalThis, 'MediaSource', {
    configurable: true,
    value: FakeMediaSource,
  })

  const mediaSource = new FakeMediaSource()
  const overflows: Array<[number, number]> = []
  const playback = new MsePlayback({
    video: createVideo(),
    maxQueueBytes: 4,
    getMinimumBufferSeconds: () => 2,
    mediaSourceFactory: () => mediaSource as unknown as MediaSource,
    createObjectURL: () => 'blob:test',
    revokeObjectURL: () => {},
    onQueueOverflow: (queued, incoming) => overflows.push([queued, incoming]),
  })

  const initialized = playback.init('video/mp4')
  mediaSource.open()
  await initialized
  mediaSource.sourceBuffer.updating = true

  assert.equal(playback.append(new Uint8Array(3)), true)
  assert.equal(playback.append(new Uint8Array(2)), false)
  assert.equal(playback.append(new Uint8Array(2)), false)
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(overflows, [[3, 2]])
  assert.deepEqual(playback.getStats(), {
    queueChunks: 1,
    queueBytes: 3,
    ready: true,
    mediaSourceState: 'open',
    sourceBufferUpdating: true,
  })
})

test('retains a chunk and prunes buffered media after quota exhaustion', async () => {
  Object.defineProperty(globalThis, 'MediaSource', {
    configurable: true,
    value: FakeMediaSource,
  })

  const mediaSource = new FakeMediaSource()
  const video = createVideo(ranges([[10, 20]]))
  const playback = new MsePlayback({
    video,
    getMinimumBufferSeconds: () => 2,
    mediaSourceFactory: () => mediaSource as unknown as MediaSource,
    createObjectURL: () => 'blob:test',
    revokeObjectURL: () => {},
  })

  const initialized = playback.init('video/mp4')
  mediaSource.open()
  await initialized
  mediaSource.sourceBuffer.appendError = { name: 'QuotaExceededError' }

  assert.equal(playback.append(new Uint8Array([1, 2])), true)
  assert.deepEqual(playback.getStats(), {
    queueChunks: 1,
    queueBytes: 2,
    ready: true,
    mediaSourceState: 'open',
    sourceBufferUpdating: true,
  })
  assert.deepEqual(mediaSource.sourceBuffer.removed, [[0, 15]])
})

test('cleanup rejects an initialization still waiting for sourceopen', async () => {
  Object.defineProperty(globalThis, 'MediaSource', {
    configurable: true,
    value: FakeMediaSource,
  })

  const mediaSource = new FakeMediaSource()
  const video = createVideo()
  const revoked: string[] = []
  const playback = new MsePlayback({
    video,
    getMinimumBufferSeconds: () => 2,
    mediaSourceFactory: () => mediaSource as unknown as MediaSource,
    createObjectURL: () => 'blob:test',
    revokeObjectURL: (url) => revoked.push(url),
  })

  const initialized = playback.init('video/mp4')
  playback.cleanup()

  await assert.rejects(initialized, /cleaned up/)
  assert.equal(video.src, '')
  assert.deepEqual(revoked, ['blob:test'])
})

test('queues media before sourceopen when explicitly enabled', async () => {
  Object.defineProperty(globalThis, 'MediaSource', {
    configurable: true,
    value: FakeMediaSource,
  })

  const mediaSource = new FakeMediaSource()
  const playback = new MsePlayback({
    video: createVideo(),
    queueBeforeReady: true,
    getMinimumBufferSeconds: () => 2,
    mediaSourceFactory: () => mediaSource as unknown as MediaSource,
    createObjectURL: () => 'blob:test',
    revokeObjectURL: () => {},
  })

  const initialized = playback.init('video/mp4')
  assert.equal(playback.append(new Uint8Array([1, 2, 3])), true)
  assert.deepEqual(playback.getStats(), {
    queueChunks: 1,
    queueBytes: 3,
    ready: false,
    mediaSourceState: 'closed',
    sourceBufferUpdating: false,
  })

  mediaSource.open()
  await initialized

  assert.deepEqual(mediaSource.sourceBuffer.appended, [new Uint8Array([1, 2, 3])])
  assert.deepEqual(playback.getStats(), {
    queueChunks: 0,
    queueBytes: 0,
    ready: true,
    mediaSourceState: 'open',
    sourceBufferUpdating: true,
  })
})

test('rejects the previous initialization and ignores its stale sourceopen', async () => {
  Object.defineProperty(globalThis, 'MediaSource', {
    configurable: true,
    value: FakeMediaSource,
  })

  const firstMediaSource = new FakeMediaSource()
  const secondMediaSource = new FakeMediaSource()
  const mediaSources = [firstMediaSource, secondMediaSource]
  const playback = new MsePlayback({
    video: createVideo(),
    getMinimumBufferSeconds: () => 2,
    mediaSourceFactory: () => mediaSources.shift() as unknown as MediaSource,
    createObjectURL: () => 'blob:test',
    revokeObjectURL: () => {},
  })

  const first = playback.init('video/mp4')
  const firstRejected = assert.rejects(first, /reinitialized/)
  const second = playback.init('video/mp4')
  await firstRejected

  firstMediaSource.open()
  assert.equal(firstMediaSource.addSourceBufferCalls, 0)

  secondMediaSource.open()
  await second
  assert.equal(secondMediaSource.addSourceBufferCalls, 1)
  assert.equal(playback.getStats().ready, true)
})

test('ends and revokes the previous media source before reinitializing', async () => {
  Object.defineProperty(globalThis, 'MediaSource', {
    configurable: true,
    value: FakeMediaSource,
  })

  const firstMediaSource = new FakeMediaSource()
  const secondMediaSource = new FakeMediaSource()
  const mediaSources = [firstMediaSource, secondMediaSource]
  const objectUrls = ['blob:first', 'blob:second']
  const revoked: string[] = []
  const video = createVideo()
  const playback = new MsePlayback({
    video,
    getMinimumBufferSeconds: () => 2,
    mediaSourceFactory: () => mediaSources.shift() as unknown as MediaSource,
    createObjectURL: () => objectUrls.shift() as string,
    revokeObjectURL: (url) => revoked.push(url),
  })

  const first = playback.init('video/mp4')
  firstMediaSource.open()
  await first
  const second = playback.init('video/mp4')

  assert.equal(firstMediaSource.ended, true)
  assert.deepEqual(revoked, ['blob:first'])
  assert.equal(video.src, 'blob:second')

  firstMediaSource.dispatchEvent(new Event('sourceopen'))
  assert.equal(video.src, 'blob:second')
  secondMediaSource.open()
  await second
})

test('rejects an unsupported output MIME type', async () => {
  Object.defineProperty(globalThis, 'MediaSource', {
    configurable: true,
    value: FakeMediaSource,
  })
  FakeMediaSource.supported = false

  const mediaSource = new FakeMediaSource()
  const playback = new MsePlayback({
    video: createVideo(),
    getMinimumBufferSeconds: () => 2,
    mediaSourceFactory: () => mediaSource as unknown as MediaSource,
    createObjectURL: () => 'blob:test',
    revokeObjectURL: () => {},
  })

  const initialized = playback.init('video/unsupported')
  mediaSource.open()

  await assert.rejects(initialized, /does not support/)
})

test('falls back to video-only MSE MIME when the audio codec declaration is unsupported', async () => {
  Object.defineProperty(globalThis, 'MediaSource', {
    configurable: true,
    value: FakeMediaSource,
  })
  const combined = 'video/mp4; codecs="avc1.42C01F,mp4a.40.2"'
  const videoOnly = 'video/mp4; codecs="avc1.42C01F"'
  FakeMediaSource.supportedMimeTypes = new Set([videoOnly])
  const mediaSource = new FakeMediaSource()
  const playback = new MsePlayback({
    video: createVideo(),
    getMinimumBufferSeconds: () => 2,
    mediaSourceFactory: () => mediaSource as unknown as MediaSource,
    createObjectURL: () => 'blob:test',
    revokeObjectURL: () => {},
  })

  const initialized = playback.init(getMseMimeCandidates(combined))
  mediaSource.open()
  await initialized

  assert.deepEqual(getMseMimeCandidates(combined), [combined, videoOnly])
  assert.deepEqual(mediaSource.addedMimeTypes, [videoOnly])
})
