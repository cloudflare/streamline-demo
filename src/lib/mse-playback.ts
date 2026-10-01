export interface MsePlaybackStats {
  queueChunks: number
  queueBytes: number
  ready: boolean
  mediaSourceState: MediaSource['readyState']
  sourceBufferUpdating: boolean
}

export interface MsePlaybackOptions {
  video: HTMLMediaElement
  getMinimumBufferSeconds: () => number
  mode?: 'segments' | 'sequence'
  maxQueueBytes?: number
  retentionSeconds?: number
  pruneIntervalSeconds?: number
  quotaPruneSeconds?: number
  queueBeforeReady?: boolean
  mediaSourceFactory?: () => MediaSource
  createObjectURL?: (source: MediaSource) => string
  revokeObjectURL?: (url: string) => void
  onMediaSourceOpen?: () => void
  onMediaSourceError?: (event: Event) => void
  onSourceBufferError?: (event: Event) => void
  onUpdateEnd?: () => void
  onAppendError?: (error: unknown, errorName: string) => void
  onQuotaExceeded?: () => void
  onQueueOverflow?: (queuedBytes: number, incomingBytes: number) => void
  onPlaybackReady?: (bufferDuration: number) => void
}

export function getMseMimeCandidates(mimeType: string): string[] {
  const videoOnly = mimeType.replace(',mp4a.40.2', '')
  return videoOnly === mimeType ? [mimeType] : [mimeType, videoOnly]
}

export class MsePlayback {
  private readonly options: MsePlaybackOptions
  private mediaSource: MediaSource | null = null
  private sourceBuffer: SourceBuffer | null = null
  private objectUrl: string | null = null
  private bufferQueue: Uint8Array[] = []
  private bufferQueueBytes = 0
  private ready = false
  private autoStarted = false
  private completing = false
  private queueOverflowed = false
  private lastBufferPruneAt = 0
  private pendingInitReject: ((error: Error) => void) | null = null

  constructor(options: MsePlaybackOptions) {
    this.options = options
  }

  init(mimeTypes: string | readonly string[]): Promise<void> {
    this.pendingInitReject?.(new Error('MSE playback reinitialized'))
    this.teardownMediaSource()
    this.bufferQueue = []
    this.bufferQueueBytes = 0
    this.ready = false
    this.autoStarted = false
    this.completing = false
    this.queueOverflowed = false
    this.lastBufferPruneAt = 0

    return new Promise((resolve, reject) => {
      let settled = false
      const resolveInit = () => {
        if (settled) return
        settled = true
        if (this.pendingInitReject === rejectInit) this.pendingInitReject = null
        resolve()
      }
      const rejectInit = (error: Error) => {
        if (settled) return
        settled = true
        if (this.pendingInitReject === rejectInit) this.pendingInitReject = null
        reject(error)
      }
      this.pendingInitReject = rejectInit
      try {
        const mediaSource = this.options.mediaSourceFactory?.() ?? new MediaSource()
        const createObjectURL = this.options.createObjectURL ?? URL.createObjectURL.bind(URL)
        this.mediaSource = mediaSource
        this.objectUrl = createObjectURL(mediaSource)
        this.options.video.src = this.objectUrl

        mediaSource.addEventListener('sourceopen', () => {
          if (mediaSource !== this.mediaSource) return
          this.options.onMediaSourceOpen?.()
          try {
            const candidates = typeof mimeTypes === 'string' ? [mimeTypes] : mimeTypes
            const mimeType = candidates.find((candidate) => MediaSource.isTypeSupported(candidate))
            if (!mimeType) {
              rejectInit(new Error(`MSE does not support ${candidates.join(' or ')}`))
              return
            }

            const sourceBuffer = mediaSource.addSourceBuffer(mimeType)
            if (this.options.mode) sourceBuffer.mode = this.options.mode
            this.sourceBuffer = sourceBuffer
            sourceBuffer.addEventListener('updateend', () => {
              if (sourceBuffer !== this.sourceBuffer) return
              this.options.onUpdateEnd?.()
              this.maybeStartPlayback()
              this.processBufferQueue()
              this.finishCompletion()
            })
            sourceBuffer.addEventListener('error', (event) => {
              if (sourceBuffer !== this.sourceBuffer) return
              this.options.onSourceBufferError?.(event)
            })
            this.ready = true
            this.processBufferQueue()
            resolveInit()
          } catch (error) {
            rejectInit(error instanceof Error ? error : new Error(String(error)))
          }
        })

        mediaSource.addEventListener('error', (event) => {
          if (mediaSource !== this.mediaSource) return
          this.options.onMediaSourceError?.(event)
          rejectInit(new Error('MediaSource initialization failed'))
        })
      } catch (error) {
        rejectInit(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  append(data: Uint8Array): boolean {
    if (!this.ready && !this.options.queueBeforeReady) return false

    const maxQueueBytes = this.options.maxQueueBytes ?? Number.POSITIVE_INFINITY
    if (this.bufferQueueBytes + data.byteLength > maxQueueBytes) {
      if (!this.queueOverflowed) {
        this.queueOverflowed = true
        this.options.onQueueOverflow?.(this.bufferQueueBytes, data.byteLength)
      }
      return false
    }

    this.bufferQueue.push(data)
    this.bufferQueueBytes += data.byteLength
    this.processBufferQueue()
    return true
  }

  getStats(): MsePlaybackStats {
    return {
      queueChunks: this.bufferQueue.length,
      queueBytes: this.bufferQueueBytes,
      ready: this.ready,
      mediaSourceState: this.mediaSource?.readyState ?? 'closed',
      sourceBufferUpdating: this.sourceBuffer?.updating ?? false,
    }
  }

  complete(): void {
    this.completing = true
    this.processBufferQueue()
    this.finishCompletion()
  }

  cleanup(): void {
    this.pendingInitReject?.(new Error('MSE playback cleaned up'))
    this.ready = false
    this.autoStarted = false
    this.completing = false
    this.queueOverflowed = false
    this.bufferQueue = []
    this.bufferQueueBytes = 0
    this.lastBufferPruneAt = 0
    this.teardownMediaSource()
  }

  private processBufferQueue(): void {
    const sourceBuffer = this.sourceBuffer
    if (!this.ready || !sourceBuffer || sourceBuffer.updating || this.bufferQueue.length === 0) return

    const retentionSeconds = this.options.retentionSeconds
    const pruneIntervalSeconds = this.options.pruneIntervalSeconds ?? 10
    if (retentionSeconds !== undefined) {
      const currentTime = this.options.video.currentTime
      const pruneBefore = currentTime - retentionSeconds
      if (
        pruneBefore > 0
        && currentTime - this.lastBufferPruneAt >= pruneIntervalSeconds
        && sourceBuffer.buffered.length > 0
      ) {
        const removeEnd = Math.min(pruneBefore, sourceBuffer.buffered.end(0))
        if (removeEnd > sourceBuffer.buffered.start(0)) {
          this.lastBufferPruneAt = currentTime
          sourceBuffer.remove(0, removeEnd)
          return
        }
      }
    }

    const chunk = this.bufferQueue.shift()
    if (!chunk) return
    this.bufferQueueBytes -= chunk.byteLength

    try {
      sourceBuffer.appendBuffer(chunk as Uint8Array<ArrayBuffer>)
    } catch (error) {
      const errorName = getErrorName(error)
      if (errorName === 'QuotaExceededError') {
        this.bufferQueue.unshift(chunk)
        this.bufferQueueBytes += chunk.byteLength
        this.options.onQuotaExceeded?.()
        const buffered = this.options.video.buffered
        if (buffered.length > 0) {
          const removeEnd = buffered.start(0) + (this.options.quotaPruneSeconds ?? 5)
          try {
            sourceBuffer.remove(0, removeEnd)
          } catch {
            // A subsequent update will retry the queued chunk.
          }
        }
        return
      }

      this.options.onAppendError?.(error, errorName)
    }
  }

  private maybeStartPlayback(): void {
    if (this.autoStarted) return
    const buffered = this.options.video.buffered
    if (buffered.length === 0) return

    const bufferDuration = buffered.end(buffered.length - 1) - buffered.start(0)
    if (bufferDuration < this.options.getMinimumBufferSeconds()) return

    this.autoStarted = true
    if (this.options.onPlaybackReady) {
      this.options.onPlaybackReady(bufferDuration)
      return
    }
    this.options.video.play().catch(() => {})
  }

  private finishCompletion(): void {
    const mediaSource = this.mediaSource
    const sourceBuffer = this.sourceBuffer
    if (!this.completing || !mediaSource || !sourceBuffer || sourceBuffer.updating || this.bufferQueue.length > 0) return

    if (!this.autoStarted) {
      const buffered = this.options.video.buffered
      if (buffered.length > 0) {
        const bufferDuration = buffered.end(buffered.length - 1) - buffered.start(0)
        this.autoStarted = true
        if (this.options.onPlaybackReady) this.options.onPlaybackReady(bufferDuration)
        else this.options.video.play().catch(() => {})
      }
    }
    if (mediaSource.readyState === 'open') mediaSource.endOfStream()
    this.completing = false
  }

  private teardownMediaSource(): void {
    const mediaSource = this.mediaSource
    const objectUrl = this.objectUrl
    this.mediaSource = null
    this.sourceBuffer = null
    this.objectUrl = null

    if (mediaSource?.readyState === 'open') {
      try {
        mediaSource.endOfStream()
      } catch {
        // The source may already be closing.
      }
    }
    if (objectUrl) {
      const revokeObjectURL = this.options.revokeObjectURL ?? URL.revokeObjectURL.bind(URL)
      revokeObjectURL(objectUrl)
    }
    if (!objectUrl || this.options.video.src === objectUrl) this.options.video.src = ''
  }
}

function getErrorName(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('name' in error)) return ''
  return typeof error.name === 'string' ? error.name : ''
}
