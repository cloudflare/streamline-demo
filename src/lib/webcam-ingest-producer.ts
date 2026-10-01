type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface WebcamIngestError {
  status?: number
  responseBody?: string
  error?: unknown
  requestId?: string
  requestBytes?: number
  durationMs?: number
  timedOut?: boolean
}

export interface WebcamIngestProducerOptions {
  getBaseUrl: () => string
  maxQueueBytes?: number
  chunkIntervalMs?: number
  uploadTimeoutMs?: number
  videoBitsPerSecond?: number
  fetcher?: Fetcher
  createRequestId?: () => string
  createRecorderStream?: (tracks: MediaStreamTrack[]) => MediaStream
  createMediaRecorder?: (stream: MediaStream, options: MediaRecorderOptions) => MediaRecorder
  isTypeSupported?: (mimeType: string) => boolean
  now?: () => number
  onStarted?: () => void
  onUploadError?: (details: WebcamIngestError) => void
  onQueueOverflow?: (pendingBytes: number, incomingBytes: number) => void
  onRecorderError?: (error: unknown) => void
  onRecorderStopError?: (error: unknown) => void
}

export interface WebcamIngestProducerStats {
  recorderState: RecordingState
  pendingBytes: number
  chunksSent: number
  pendingChunks: number
  requestsCompleted: number
  activeRequestId: string | null
  activeRequestBytes: number
  activeRequestAgeMs: number
  lastRequestDurationMs: number
  lastRequestStatus: number | null
  lastChunkAt: number
}

interface WebcamIngestRun {
  recorder: MediaRecorder
  uploadChain: Promise<void>
  pendingBytes: number
  chunksSent: number
  pendingChunks: number
  requestsCompleted: number
  activeRequestId: string | null
  activeRequestBytes: number
  activeRequestStartedAt: number | null
  lastRequestDurationMs: number
  lastRequestStatus: number | null
  lastChunkAt: number
  uploadControllers: Set<AbortController>
}

const DEFAULT_UPLOAD_TIMEOUT_MS = 15_000

export class WebcamIngestProducer {
  private readonly options: WebcamIngestProducerOptions
  private activeRun: WebcamIngestRun | null = null

  constructor(options: WebcamIngestProducerOptions) {
    this.options = options
  }

  start(stream: MediaStream, sessionId: string | null): void {
    if (this.activeRun) throw new Error('Webcam ingest is already running')

    const supportsMimeType = this.options.isTypeSupported ?? MediaRecorder.isTypeSupported.bind(MediaRecorder)
    const mimeType = supportsMimeType('video/webm;codecs=vp8')
      ? 'video/webm;codecs=vp8'
      : 'video/webm'
    const recorderStream = this.options.createRecorderStream?.(stream.getVideoTracks())
      ?? new MediaStream(stream.getVideoTracks())
    const recorderOptions = {
      mimeType,
      videoBitsPerSecond: this.options.videoBitsPerSecond ?? 2_500_000,
    }
    const recorder = this.options.createMediaRecorder?.(recorderStream, recorderOptions)
      ?? new MediaRecorder(recorderStream, recorderOptions)
    const run: WebcamIngestRun = {
      recorder,
      uploadChain: Promise.resolve(),
      pendingBytes: 0,
      chunksSent: 0,
      pendingChunks: 0,
      requestsCompleted: 0,
      activeRequestId: null,
      activeRequestBytes: 0,
      activeRequestStartedAt: null,
      lastRequestDurationMs: 0,
      lastRequestStatus: null,
      lastChunkAt: 0,
      uploadControllers: new Set(),
    }
    this.activeRun = run

    recorder.addEventListener('dataavailable', (event) => {
      const chunk = (event as BlobEvent).data
      if (chunk.size === 0 || this.activeRun !== run) return

      const maxQueueBytes = this.options.maxQueueBytes ?? 8 * 1024 * 1024
      if (run.pendingBytes + chunk.size > maxQueueBytes) {
        this.options.onQueueOverflow?.(run.pendingBytes, chunk.size)
        return
      }

      run.pendingBytes += chunk.size
      run.chunksSent++
      run.pendingChunks++
      run.lastChunkAt = this.now()
      run.uploadChain = run.uploadChain.then(async () => {
        const requestId = this.options.createRequestId?.() ?? crypto.randomUUID()
        let requestStartedAt: number | null = null
        let timedOut = false
        const requestDuration = () => requestStartedAt === null
          ? undefined
          : Math.max(this.now() - requestStartedAt, 0)
        try {
          const buffer = await chunk.arrayBuffer()
          if (this.activeRun !== run) return
          const controller = new AbortController()
          run.uploadControllers.add(controller)
          requestStartedAt = this.now()
          run.activeRequestId = requestId
          run.activeRequestBytes = chunk.size
          run.activeRequestStartedAt = requestStartedAt
          const timeout = setTimeout(() => {
            timedOut = true
            controller.abort(new DOMException('Webcam ingest request timed out', 'TimeoutError'))
          }, this.options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS)
          try {
            const headers = new Headers({ 'Content-Type': 'application/octet-stream' })
            if (sessionId) headers.set('X-Streamline-Session-ID', sessionId)
            headers.set('X-Ingest-Request-ID', requestId)
            const fetcher = this.options.fetcher ?? fetch
            const response = await fetcher(`${this.options.getBaseUrl()}/ingest`, {
              method: 'POST',
              body: buffer,
              headers,
              signal: controller.signal,
            })
            if (this.activeRun !== run) return
            run.requestsCompleted++
            run.lastRequestStatus = response.status
            if (!response.ok) {
              const responseBody = (await response.text()).slice(0, 1024)
              if (this.activeRun !== run) return
              this.options.onUploadError?.({
                status: response.status,
                responseBody,
                requestId,
                requestBytes: chunk.size,
                durationMs: requestDuration(),
              })
            }
          } finally {
            clearTimeout(timeout)
            run.uploadControllers.delete(controller)
            if (run.activeRequestId === requestId) {
              run.lastRequestDurationMs = requestDuration() ?? 0
              run.activeRequestId = null
              run.activeRequestBytes = 0
              run.activeRequestStartedAt = null
            }
          }
        } catch (error) {
          if (this.activeRun === run) {
            this.options.onUploadError?.({
              error,
              requestId,
              requestBytes: chunk.size,
              durationMs: requestDuration(),
              timedOut,
            })
          }
        } finally {
          run.pendingBytes -= chunk.size
          run.pendingChunks--
        }
      })
    })

    recorder.addEventListener('error', (event) => {
      if (this.activeRun !== run) return
      this.options.onRecorderError?.((event as Event & { error?: unknown }).error ?? event)
    })
    recorder.addEventListener('stop', () => {
      if (this.activeRun !== run) return
      this.options.onRecorderError?.(new Error('MediaRecorder stopped unexpectedly'))
    })

    try {
      recorder.start(this.options.chunkIntervalMs ?? 250)
    } catch (error) {
      if (this.activeRun === run) this.activeRun = null
      throw error
    }
    this.options.onStarted?.()
  }

  async stop(): Promise<void> {
    const run = this.activeRun
    if (!run) return
    this.activeRun = null
    try {
      if (run.recorder.state !== 'inactive') run.recorder.stop()
    } catch (error) {
      this.options.onRecorderStopError?.(error)
    }

    for (const controller of run.uploadControllers) controller.abort()
    run.uploadControllers.clear()
    await run.uploadChain
  }

  getStats(): WebcamIngestProducerStats {
    const run = this.activeRun
    return {
      recorderState: run?.recorder.state ?? 'inactive',
      pendingBytes: run?.pendingBytes ?? 0,
      chunksSent: run?.chunksSent ?? 0,
      pendingChunks: run?.pendingChunks ?? 0,
      requestsCompleted: run?.requestsCompleted ?? 0,
      activeRequestId: run?.activeRequestId ?? null,
      activeRequestBytes: run?.activeRequestBytes ?? 0,
      activeRequestAgeMs: run?.activeRequestStartedAt !== null && run?.activeRequestStartedAt !== undefined
        ? Math.max(this.now() - run.activeRequestStartedAt, 0)
        : 0,
      lastRequestDurationMs: run?.lastRequestDurationMs ?? 0,
      lastRequestStatus: run?.lastRequestStatus ?? null,
      lastChunkAt: run?.lastChunkAt ?? 0,
    }
  }

  private now(): number {
    return this.options.now?.() ?? performance.now()
  }
}
