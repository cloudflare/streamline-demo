import { AnnotationPublisher, type AnnotationPublisherError } from './annotation-publisher.ts'
import { getMseMimeCandidates, MsePlayback, type MsePlaybackStats } from './mse-playback.ts'
import { RelayViewer, type RelayPayloadDetails } from './relay-viewer.ts'
import type { StreamSessionSource } from './stream-session-config.ts'
import { StreamSessionController, type StreamSessionStopResult } from './stream-session-controller.ts'
import {
  WebcamIngestProducer,
  type WebcamIngestError,
  type WebcamIngestProducerStats,
} from './webcam-ingest-producer.ts'

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const DEFAULT_MAX_QUEUE_BYTES = 8 * 1024 * 1024
const DEFAULT_INGEST_TIMEOUT_MS = 15_000
const DEFAULT_OUTPUT_STALL_MS = 15_000
const DEFAULT_METRICS_INTERVAL_MS = 2_000

export type StreamSessionRuntimeState = 'idle' | 'starting' | 'running' | 'stopping' | 'complete'

export type StreamSessionRuntimePhase =
  | 'loading-annotation'
  | 'requesting-webcam'
  | 'preparing-relay'
  | 'initializing-playback'
  | 'connecting-relay'
  | 'starting-container'
  | 'waiting-for-local-output'

export type StreamSessionRuntimeFailure =
  | 'webcam-ingest'
  | 'webcam-queue-overflow'
  | 'media-recorder'
  | 'mse-media-source'
  | 'mse-source-buffer'
  | 'mse-append'
  | 'mse-queue-overflow'

export interface StreamSessionMetrics {
  running?: boolean
  sessionActive?: boolean
  outputMode?: string
  subtitle?: {
    state: string
    language?: string
    cueCount?: number
    warning?: string
  }
  ffmpeg?: {
    state?: string
    frame?: number
    fps?: number
    bitrate?: string
    outTimeUs?: number
    speed?: number
    dupFrames?: number
    dropFrames?: number
    updatedAt?: string
  }
  progressAgeMs?: number
  lastOutputAt?: string
  outputAgeMs?: number
  restartCount?: number
  lastRestartAt?: string
  lastFfmpegExitError?: string
  outputSubscriber?: boolean
  outputQueueDepth?: number
  reconnectBufferBytes?: number
  reconnectOverflowed?: boolean
  ingestWriting?: boolean
  ingestWriteAgeMs?: number
  ingestWriteBytes?: number
  lastIngestWriteMs?: number
}

export interface StreamSessionRuntimeStartOptions<TResponse = Record<string, unknown>> {
  source: StreamSessionSource
  outputMode: 'websocket' | 'rtmp'
  outputMime: string
  buildRequest: (sessionId: string | null) => object
  validateResponse?: (response: unknown) => TResponse
  getPreflightAnnotationBlob?: () => Promise<Blob | null>
  getAnnotationBlob?: () => Promise<Blob | null>
  webcamIngest?: boolean
  pollMetrics?: boolean
  completeOnInactiveMetrics?: boolean
  metricsIntervalMs?: number
}

export interface StreamSessionRuntimeStopDetails {
  reason: string
  result: StreamSessionStopResult | null
}

export interface StreamSessionRuntimeOptions {
  getBaseUrl: () => string
  video: HTMLMediaElement
  isLocalDevelopment?: () => boolean
  fetcher?: Fetcher
  now?: () => number
  createRequestId?: () => string
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  getMinimumBufferSeconds?: () => number
  getMseRetentionSeconds?: (live: boolean) => number
  getMsePruneIntervalSeconds?: (live: boolean) => number
  maxMseQueueBytes?: number
  maxIngestQueueBytes?: number
  ingestUploadTimeoutMs?: number
  outputStallMs?: number
  annotationIntervalMs?: number
  isAnnotationReady?: () => boolean
  prepareSession?: () => Promise<{ pollMetrics: false } | void>
  onStateChange?: (state: StreamSessionRuntimeState) => void
  onPhase?: (phase: StreamSessionRuntimePhase) => void
  onWebcamAcquired?: (stream: MediaStream) => void | Promise<void>
  onWebcamReleased?: () => void
  onWebcamStarted?: () => void
  onWebcamUploadError?: (details: WebcamIngestError) => void
  onWebcamQueueOverflow?: (pendingBytes: number, incomingBytes: number) => void
  onMediaRecorderError?: (error: unknown) => void
  onMediaRecorderStopError?: (error: unknown) => void
  onAnnotationSent?: (size: number) => void
  onAnnotationLoaded?: (blob: Blob) => void
  onAnnotationError?: (details: AnnotationPublisherError) => void
  onMseSourceOpen?: () => void
  onMseMediaSourceError?: (event: Event) => void
  onMseSourceBufferError?: (event: Event) => void
  onMseUpdateEnd?: () => void
  onMseAppendError?: (error: unknown, errorName: string) => void
  onMseQuotaExceeded?: () => void
  onMseQueueOverflow?: (queuedBytes: number, incomingBytes: number) => void
  onPlaybackReady?: (bufferDuration: number) => void
  onRelayOpen?: (reason: string, connection: number) => void
  onRelayPayload?: (payload: Uint8Array, details: RelayPayloadDetails) => void
  onRelayEnd?: () => void
  onRelayClose?: (event: CloseEvent, opened: boolean) => void
  onRelayError?: (connection: number) => void
  onRelayStalled?: (ageMs: number) => void
  onRelayReconnectScheduled?: (closeCode: number, attempt: number, delayMs: number) => void
  onRelayReconnected?: (attempt: number) => void
  onRelayReconnectFailed?: (attempt: number, error: unknown) => void
  onMetrics?: (metrics: StreamSessionMetrics) => void
  getLastKnownFailure?: () => string | null
  onRemoteStopStarted?: (details: {
    reason: string
    requestId: string
    sessionId: string | null
  }) => void
  onRemoteStopFinished?: (details: {
    reason: string
    result: StreamSessionStopResult
  }) => void
  onBeforeStopped?: (details: StreamSessionRuntimeStopDetails) => void
  onStopped?: (details: StreamSessionRuntimeStopDetails) => void
  onBeforeCompleted?: (failure: string | null) => void
  onCompleted?: (failure: string | null) => void
  onReplaced?: () => void
  onFatalError?: (failure: StreamSessionRuntimeFailure, message: string) => void
}

interface ActiveSession {
  source: StreamSessionSource
  outputMode: 'websocket' | 'rtmp'
  pollMetrics: boolean
  completeOnInactiveMetrics: boolean
  metricsIntervalMs: number
}

export class StreamSessionRuntime {
  private readonly options: StreamSessionRuntimeOptions
  private readonly sessionController: StreamSessionController
  private readonly webcamIngestProducer: WebcamIngestProducer
  private readonly annotationPublisher: AnnotationPublisher
  private runtimeState: StreamSessionRuntimeState = 'idle'
  private runId = 0
  private runActive = false
  private sessionStarted = false
  private stream: MediaStream | null = null
  private activeSession: ActiveSession | null = null
  private msePlayback: MsePlayback | null = null
  private relayViewer: RelayViewer | null = null
  private startPromise: Promise<unknown | null> | null = null
  private stopPromise: Promise<StreamSessionRuntimeStopDetails> | null = null
  private completionPromise: Promise<void> | null = null
  private completionStopPromise: Promise<StreamSessionStopResult> | null = null
  private completionTimer: ReturnType<typeof setTimeout> | null = null
  private metricsTimer: ReturnType<typeof setInterval> | null = null
  private metricsController: AbortController | null = null
  private metricsInFlight = false
  private metricsSamples = 0
  private observedRunning = false

  constructor(options: StreamSessionRuntimeOptions) {
    this.options = options
    this.sessionController = new StreamSessionController({
      getBaseUrl: options.getBaseUrl,
      fetcher: options.fetcher,
      now: options.now,
      createRequestId: options.createRequestId,
    })
    this.webcamIngestProducer = new WebcamIngestProducer({
      getBaseUrl: options.getBaseUrl,
      fetcher: options.fetcher,
      now: options.now,
      createRequestId: () => this.createRequestId(),
      maxQueueBytes: options.maxIngestQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES,
      uploadTimeoutMs: options.ingestUploadTimeoutMs ?? DEFAULT_INGEST_TIMEOUT_MS,
      onStarted: options.onWebcamStarted,
      onUploadError: (details) => {
        if (!this.runActive) return
        options.onWebcamUploadError?.(details)
        void this.fail(
          'webcam-ingest',
          details.status === 409
            ? 'The streaming session was replaced.'
            : details.timedOut
              ? `Streaming stopped because a webcam upload received no response for ${formatSeconds(details.durationMs)}.`
              : 'Webcam ingest failed.',
        )
      },
      onQueueOverflow: (pendingBytes, incomingBytes) => {
        options.onWebcamQueueOverflow?.(pendingBytes, incomingBytes)
        void this.fail(
          'webcam-queue-overflow',
          `Streaming stopped because webcam upload buffering exceeded ${formatMiB(options.maxIngestQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES)}.`,
        )
      },
      onRecorderError: (error) => {
        options.onMediaRecorderError?.(error)
        void this.fail('media-recorder', 'MediaRecorder failed.')
      },
      onRecorderStopError: options.onMediaRecorderStopError,
    })
    this.annotationPublisher = new AnnotationPublisher({
      getBaseUrl: options.getBaseUrl,
      fetcher: options.fetcher,
      isActive: () => this.runActive && this.sessionStarted,
      isReady: options.isAnnotationReady,
      intervalMs: options.annotationIntervalMs,
      onSent: options.onAnnotationSent,
      onError: options.onAnnotationError,
    })
  }

  get state(): StreamSessionRuntimeState {
    return this.runtimeState
  }

  get sessionId(): string | null {
    return this.sessionController.sessionId
  }

  get active(): boolean {
    return this.runActive && this.runtimeState !== 'stopping'
  }

  start<TResponse = Record<string, unknown>>(
    startOptions: StreamSessionRuntimeStartOptions<TResponse>,
  ): Promise<TResponse | null> {
    if (this.startPromise) return this.startPromise as Promise<TResponse | null>
    const startPromise = this.performStart(startOptions)
    this.startPromise = startPromise
    const clearStartPromise = () => {
      if (this.startPromise === startPromise) this.startPromise = null
    }
    void startPromise.then(clearStartPromise, clearStartPromise)
    return startPromise
  }

  stop(reason = 'manual', preservePlayback = false): Promise<StreamSessionRuntimeStopDetails> {
    if (this.stopPromise) return this.stopPromise
    const stopPromise = this.performStop(reason, preservePlayback)
    this.stopPromise = stopPromise
    const clearStopPromise = () => {
      if (this.stopPromise === stopPromise) this.stopPromise = null
    }
    void stopPromise.then(clearStopPromise, clearStopPromise)
    return stopPromise
  }

  setAnnotationBlob(blob: Blob, publishImmediately = true): Promise<void> {
    return this.annotationPublisher.setBlob(blob, publishImmediately)
  }

  getMseStats(): MsePlaybackStats | null {
    return this.msePlayback?.getStats() ?? null
  }

  getWebcamStats(): WebcamIngestProducerStats {
    return this.webcamIngestProducer.getStats()
  }

  private async performStart<TResponse>(
    startOptions: StreamSessionRuntimeStartOptions<TResponse>,
  ): Promise<TResponse | null> {
    if (this.runtimeState !== 'idle' && this.runtimeState !== 'complete') return null
    if (this.stopPromise) await this.stopPromise
    if (this.completionPromise) await this.completionPromise
    if (this.completionStopPromise) await this.completionStopPromise
    if (this.runtimeState !== 'idle' && this.runtimeState !== 'complete') return null

    if (this.sessionController.sessionId) {
      const staleStop = await this.stopRemote('stale-session')
      if ('error' in staleStop) {
        throw new Error(`Previous relay cleanup failed: ${errorMessage(staleStop.error)}`)
      }
    }

    this.resetRetainedPlayback()
    const runId = ++this.runId
    this.runActive = true
    this.sessionStarted = false
    this.metricsSamples = 0
    this.observedRunning = false
    this.sessionController.setSessionId(null)
    this.activeSession = {
      source: startOptions.source,
      outputMode: startOptions.outputMode,
      pollMetrics: startOptions.pollMetrics ?? false,
      completeOnInactiveMetrics: startOptions.completeOnInactiveMetrics ?? false,
      metricsIntervalMs: startOptions.metricsIntervalMs ?? DEFAULT_METRICS_INTERVAL_MS,
    }
    this.setState('starting')
    const webcamIngest = startOptions.webcamIngest ?? startOptions.source.kind === 'webcam'

    let runSessionId: string | null = null
    try {
      if (startOptions.source.validationError) throw new Error(startOptions.source.validationError)
      const preparation = await this.options.prepareSession?.()
      if (!this.isCurrentRun(runId)) return null
      if (preparation?.pollMetrics === false && this.activeSession) this.activeSession.pollMetrics = false
      startOptions.buildRequest(null)

      let annotationBlob: Blob | null = null
      if (startOptions.getPreflightAnnotationBlob) {
        this.options.onPhase?.('loading-annotation')
        annotationBlob = await startOptions.getPreflightAnnotationBlob()
        if (!this.isCurrentRun(runId)) return null
        if (annotationBlob) this.options.onAnnotationLoaded?.(annotationBlob)
      }

      if (webcamIngest) {
        this.options.onPhase?.('requesting-webcam')
        const getUserMedia = this.options.getUserMedia
          ?? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
        const acquiredStream = await getUserMedia({
          video: { width: 1280, height: 720, frameRate: 30 },
          audio: false,
        })
        if (!this.isCurrentRun(runId)) {
          acquiredStream.getTracks().forEach((track) => track.stop())
          return null
        }
        this.stream = acquiredStream
        await this.options.onWebcamAcquired?.(acquiredStream)
        if (!this.isCurrentRun(runId)) return null
      }

      const localDevelopment = this.options.isLocalDevelopment?.() ?? false
      if (localDevelopment) {
        runSessionId = this.createRequestId()
        this.sessionController.setSessionId(runSessionId)
      } else {
        this.options.onPhase?.('preparing-relay')
        const sessionId = await this.sessionController.createSession()
        if (!this.isCurrentRun(runId)) {
          if (!this.stopPromise) await this.sessionController.stopCancelledRelay(sessionId)
          return null
        }
        runSessionId = sessionId
      }

      if (startOptions.outputMode === 'websocket') {
        this.options.onPhase?.('initializing-playback')
        this.msePlayback = this.createMsePlayback(runId, isLiveSource(startOptions.source))
        await this.msePlayback.init(getMseMimeCandidates(startOptions.outputMime))
        if (!this.isCurrentRun(runId)) return null
        this.relayViewer = this.createRelayViewer(runId)

        if (!localDevelopment) {
          this.options.onPhase?.('connecting-relay')
          await this.relayViewer.connect()
          if (!this.isCurrentRun(runId)) return null
        }
      }

      this.options.onPhase?.('starting-container')
      const responseValue = await this.sessionController.start(startOptions.buildRequest(runSessionId))
      if (!this.isCurrentRun(runId)) {
        if (!this.stopPromise) await this.sessionController.stopCancelledRelay(runSessionId)
        return null
      }
      const response = startOptions.validateResponse
        ? startOptions.validateResponse(responseValue)
        : responseValue as TResponse
      this.sessionStarted = true

      if (startOptions.getAnnotationBlob) {
        this.options.onPhase?.('loading-annotation')
        annotationBlob = await startOptions.getAnnotationBlob()
        if (!this.isCurrentRun(runId)) return null
        if (annotationBlob) this.options.onAnnotationLoaded?.(annotationBlob)
      }
      if (annotationBlob) this.annotationPublisher.start(annotationBlob, runSessionId)
      if (webcamIngest) {
        if (!this.stream) throw new Error('Webcam stream is unavailable')
        this.webcamIngestProducer.start(this.stream, runSessionId)
      }

      if (startOptions.outputMode === 'websocket' && localDevelopment) {
        this.options.onPhase?.('waiting-for-local-output')
        await this.relayViewer?.connectWhenAvailable(
          20,
          100,
          () => this.isLocalOutputAvailable(runId),
        )
        if (!this.isCurrentRun(runId)) return null
      }

      if (this.activeSession.pollMetrics) this.startMetricsPolling(runId)
      if (startOptions.outputMode === 'websocket') this.relayViewer?.startWatchdog()
      this.setState('running')
      return response
    } catch (error) {
      if (!this.isCurrentRun(runId)) return null
      await this.stop('start-failed')
      throw error
    }
  }

  private async performStop(
    reason: string,
    preservePlayback: boolean,
  ): Promise<StreamSessionRuntimeStopDetails> {
    const previousState = this.runtimeState
    const hadRemoteWork = this.sessionStarted
      || this.sessionController.sessionId !== null
      || this.sessionController.isCreatingSession
      || previousState === 'running'

    ++this.runId
    this.runActive = false
    this.sessionStarted = false
    this.startPromise = null
    this.setState('stopping')
    const webcamStop = this.stopLocalResources(preservePlayback, reason)
    const remoteStop = hadRemoteWork
      ? this.completionStopPromise ?? this.stopRemote(reason)
      : null
    if (!hadRemoteWork) this.sessionController.abortPendingRequests()
    await webcamStop
    const result = remoteStop ? await remoteStop : null
    this.activeSession = null
    const details = { reason, result }
    this.options.onBeforeStopped?.(details)
    this.setState('idle')
    this.options.onStopped?.(details)
    return details
  }

  private stopLocalResources(preservePlayback: boolean, reason: string): Promise<void> {
    const webcamStop = this.webcamIngestProducer.stop()
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop())
      this.stream = null
      this.options.onWebcamReleased?.()
    }
    this.annotationPublisher.stop()
    this.relayViewer?.stop(reason)
    this.relayViewer = null
    if (preservePlayback) this.msePlayback?.complete()
    else {
      this.msePlayback?.cleanup()
      this.msePlayback = null
    }
    this.stopMetricsPolling()
    return webcamStop
  }

  private createMsePlayback(runId: number, live: boolean): MsePlayback {
    return new MsePlayback({
      video: this.options.video,
      mode: 'sequence',
      maxQueueBytes: this.options.maxMseQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES,
      retentionSeconds: this.options.getMseRetentionSeconds?.(live) ?? (live ? 6 : 30),
      pruneIntervalSeconds: this.options.getMsePruneIntervalSeconds?.(live) ?? (live ? 3 : 10),
      getMinimumBufferSeconds: this.options.getMinimumBufferSeconds ?? (() => 2),
      onMediaSourceOpen: this.options.onMseSourceOpen,
      onMediaSourceError: (event) => {
        this.options.onMseMediaSourceError?.(event)
        if (this.isCurrentRun(runId)) void this.fail('mse-media-source', 'Browser playback failed.')
      },
      onSourceBufferError: (event) => {
        this.options.onMseSourceBufferError?.(event)
        if (this.isCurrentRun(runId)) void this.fail('mse-source-buffer', 'Browser playback failed.')
      },
      onUpdateEnd: this.options.onMseUpdateEnd,
      onAppendError: (error, errorName) => {
        this.options.onMseAppendError?.(error, errorName)
        if (this.isCurrentRun(runId)) void this.fail('mse-append', 'Browser playback append failed.')
      },
      onQuotaExceeded: this.options.onMseQuotaExceeded,
      onQueueOverflow: (queuedBytes, incomingBytes) => {
        this.options.onMseQueueOverflow?.(queuedBytes, incomingBytes)
        if (this.isCurrentRun(runId)) {
          void this.fail(
            'mse-queue-overflow',
            `Streaming stopped because browser playback buffering exceeded ${formatMiB(this.options.maxMseQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES)}.`,
          )
        }
      },
      onPlaybackReady: this.options.onPlaybackReady,
    })
  }

  private createRelayViewer(runId: number): RelayViewer {
    return new RelayViewer({
      getUrl: () => this.getOutputUrl(),
      isActive: () => this.isCurrentRun(runId),
      getReconnectKey: () => this.sessionController.sessionId,
      stallTimeoutMs: this.options.outputStallMs ?? DEFAULT_OUTPUT_STALL_MS,
      now: this.options.now,
      onOpen: this.options.onRelayOpen,
      onPayload: (payload, details) => {
        if (!this.isCurrentRun(runId)) return
        this.options.onRelayPayload?.(payload, details)
        this.msePlayback?.append(payload)
      },
      onEnd: () => {
        if (!this.isCurrentRun(runId)) return
        this.msePlayback?.complete()
        this.options.onRelayEnd?.()
        void this.completeFromRelayEnd(runId)
      },
      onClose: (event, opened) => {
        this.options.onRelayClose?.(event, opened)
        if (opened && event.code === 1012 && this.isCurrentRun(runId)) {
          void this.handleReplacement(runId)
        }
      },
      onError: this.options.onRelayError,
      onStalled: this.options.onRelayStalled,
      onReconnectScheduled: this.options.onRelayReconnectScheduled,
      onReconnected: this.options.onRelayReconnected,
      onReconnectFailed: this.options.onRelayReconnectFailed,
    })
  }

  private getOutputUrl(): string {
    const sessionId = encodeURIComponent(this.sessionController.sessionId || '')
    if (this.options.isLocalDevelopment?.() ?? false) {
      return `ws://localhost:8788/output?session_id=${sessionId}`
    }
    const location = window.location
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    return `${protocol}://${location.host}/relay/view?session_id=${sessionId}`
  }

  private startMetricsPolling(runId: number): void {
    this.stopMetricsPolling()
    const sample = () => {
      void this.sampleMetrics(runId)
    }
    this.metricsTimer = setInterval(sample, this.activeSession?.metricsIntervalMs ?? DEFAULT_METRICS_INTERVAL_MS)
    sample()
  }

  private async sampleMetrics(runId: number): Promise<void> {
    if (!this.isCurrentRun(runId) || this.metricsInFlight) return
    this.metricsInFlight = true
    const controller = new AbortController()
    this.metricsController = controller
    try {
      const response = await this.fetchMetrics(controller.signal)
      const sessionId = this.sessionController.sessionId
      if (response.status === 409 && sessionId && this.isCurrentRun(runId)) {
        await this.handleReplacement(runId)
        return
      }
      if (!response.ok || !this.isCurrentRun(runId)) return
      const metrics = await response.json() as StreamSessionMetrics
      if (!this.isCurrentRun(runId)) return
      this.metricsSamples++
      this.observedRunning ||= metrics.running === true
      this.options.onMetrics?.(metrics)

      if (this.activeSession?.completeOnInactiveMetrics && metrics.sessionActive === false) {
        const isVod = this.activeSession.source.kind === 'hls'
        if (!isVod && !this.observedRunning && this.metricsSamples < 2) return
        const failure = metrics.lastFfmpegExitError || null
        if (!failure && this.activeSession.outputMode === 'websocket') {
          if (!this.completionTimer) {
            this.completionTimer = setTimeout(() => {
              this.completionTimer = null
              if (this.isCurrentRun(runId)) void this.complete(runId, null)
            }, 500)
          }
          return
        }
        await this.complete(runId, failure)
      }
    } catch (error) {
      if (this.isCurrentRun(runId) && !isAbortError(error)) {
        console.error('Container metrics request failed', error)
      }
    } finally {
      if (this.metricsController === controller) {
        this.metricsController = null
        this.metricsInFlight = false
      }
    }
  }

  private async completeFromRelayEnd(runId: number): Promise<void> {
    if (!this.isCurrentRun(runId)) return
    let failure: string | null = null
    try {
      failure = this.options.getLastKnownFailure?.() ?? null
    } catch {
      // Completion must not depend on optional diagnostics.
    }
    try {
      const response = await this.fetchMetrics(AbortSignal.timeout(2_000))
      if (response.ok) {
        const metrics = await response.json() as StreamSessionMetrics
        failure = metrics.lastFfmpegExitError || null
      }
    } catch {
      // Explicit EOS still provides a deterministic completion fallback.
    }
    if (this.isCurrentRun(runId)) await this.complete(runId, failure)
  }

  private complete(runId: number, failure: string | null): Promise<void> {
    if (!this.isCurrentRun(runId)) return Promise.resolve()
    if (this.completionPromise) return this.completionPromise
    const completionPromise = this.performComplete(failure)
    this.completionPromise = completionPromise
    const clearCompletionPromise = () => {
      if (this.completionPromise === completionPromise) this.completionPromise = null
    }
    void completionPromise.then(clearCompletionPromise, clearCompletionPromise)
    return completionPromise
  }

  private async performComplete(failure: string | null): Promise<void> {
    if (this.completionTimer) clearTimeout(this.completionTimer)
    this.completionTimer = null
    const completionRunId = ++this.runId
    this.runActive = false
    this.sessionStarted = false
    this.setState('stopping')
    const webcamStop = this.stopLocalResources(true, 'source-complete')
    await webcamStop
    if (this.runId !== completionRunId || this.runtimeState !== 'stopping') return
    this.activeSession = null
    const completionStop = this.stopRemote('source-complete')
    this.completionStopPromise = completionStop
    await completionStop
    if (this.completionStopPromise === completionStop) this.completionStopPromise = null
    if (this.runId !== completionRunId || this.runtimeState !== 'stopping') return
    this.options.onBeforeCompleted?.(failure)
    this.setState('complete')
    this.options.onCompleted?.(failure)
  }

  private stopMetricsPolling(): void {
    if (this.metricsTimer) clearInterval(this.metricsTimer)
    this.metricsTimer = null
    this.metricsController?.abort()
    this.metricsController = null
    this.metricsInFlight = false
    if (this.completionTimer) clearTimeout(this.completionTimer)
    this.completionTimer = null
  }

  private async handleReplacement(runId: number): Promise<void> {
    if (!this.isCurrentRun(runId)) return
    await this.stop('relay-replaced')
    this.options.onReplaced?.()
  }

  private async fail(failure: StreamSessionRuntimeFailure, message: string): Promise<void> {
    if (!this.runActive) return
    await this.stop('runtime-error')
    this.options.onFatalError?.(failure, message)
  }

  private async stopRemote(reason: string): Promise<StreamSessionStopResult> {
    const requestId = this.createRequestId()
    this.options.onRemoteStopStarted?.({
      reason,
      requestId,
      sessionId: this.sessionController.sessionId,
    })
    const result = await this.sessionController.stop(requestId)
    this.options.onRemoteStopFinished?.({ reason, result })
    return result
  }

  private fetchMetrics(signal: AbortSignal): Promise<Response> {
    const headers = new Headers()
    const sessionId = this.sessionController.sessionId
    if (sessionId) headers.set('X-Streamline-Session-ID', sessionId)
    const fetcher = this.options.fetcher ?? fetch
    return fetcher(`${this.options.getBaseUrl()}/metrics`, { headers, signal })
  }

  private async isLocalOutputAvailable(runId: number): Promise<boolean> {
    if (!this.isCurrentRun(runId)) return false
    try {
      const response = await this.fetchMetrics(AbortSignal.timeout(1_000))
      if (!response.ok || !this.isCurrentRun(runId)) return false
      const metrics = await response.json() as StreamSessionMetrics
      return metrics.running === true || (metrics.reconnectBufferBytes ?? 0) > 0
    } catch {
      return false
    }
  }

  private resetRetainedPlayback(): void {
    this.relayViewer?.reset()
    this.relayViewer = null
    this.msePlayback?.cleanup()
    this.msePlayback = null
    this.annotationPublisher.stop()
    this.stopMetricsPolling()
  }

  private setState(state: StreamSessionRuntimeState): void {
    this.runtimeState = state
    this.options.onStateChange?.(state)
  }

  private isCurrentRun(runId: number): boolean {
    return runId === this.runId && this.runActive && this.runtimeState !== 'stopping'
  }

  private createRequestId(): string {
    return this.options.createRequestId?.() ?? crypto.randomUUID()
  }
}

function isLiveSource(source: StreamSessionSource): boolean {
  return source.kind === 'webcam' || source.kind === 'rtmp'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function formatMiB(bytes: number): string {
  return `${bytes / (1024 * 1024)} MiB`
}

function formatSeconds(durationMs?: number): string {
  return `${Math.round((durationMs ?? DEFAULT_INGEST_TIMEOUT_MS) / 1000)} seconds`
}
