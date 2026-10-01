import {
  buildCoreSessionPlan,
  buildCoreStartRequest,
  parseStreamSessionStartResponse,
  readStreamlineSettings,
  type FilterValues,
  type StreamlineSettings,
  type StreamSessionPlan,
  type StreamSessionStartResponse,
  type StreamSessionStartSubtitleMetadata,
} from './stream-session-config.ts'
import {
  StreamSessionRuntime,
  type StreamSessionMetrics,
  type StreamSessionRuntimePhase,
  type StreamSessionRuntimeState,
  type StreamSessionRuntimeStopDetails,
} from './stream-session-runtime.ts'
import { fetchMediaEndpoints } from './media-endpoints.ts'
import { preparePlaygroundAdmission } from './playground-admission-interface.ts'

const ANNOTATION_REPUBLISH_MS = 60_000

export const STREAMING_EVENTS = {
  beforeStart: 'streamline:before-start',
  started: 'streamline:started',
  startError: 'streamline:start-error',
  stateChange: 'streamline:state-change',
  status: 'streamline:status',
  stopped: 'streamline:stopped',
  completed: 'streamline:completed',
} as const

export type StreamingState = StreamSessionRuntimeState
export type StreamingStatusType = 'info' | 'success' | 'warning' | 'error'

export interface StreamingStartOptions {
  settings: StreamlineSettings
  burnSubtitles: boolean
}

export interface StreamingBeforeStartDetail {
  options: StreamingStartOptions
  validationError?: string
}

export interface StreamingStartedDetail {
  plan: StreamSessionPlan
  response: StreamSessionStartResponse
}

export interface StreamingStartErrorDetail {
  message: string
  error?: unknown
}

export interface StreamingStateChangeDetail {
  state: StreamingState
  active: boolean
}

export interface StreamingStatusDetail {
  message: string
  type: StreamingStatusType
}

export interface SubtitlePresentation {
  visible: boolean
  language: string
  cues: string
  message: string | null
  type: StreamingStatusType
}

interface HlsInstance {
  loadSource(url: string): void
  attachMedia(video: HTMLVideoElement): void
  on(event: string, callback: () => void): void
  destroy(): void
}

declare global {
  interface Window {
    getFilterValues?: () => FilterValues
    startStreaming?: () => Promise<boolean>
    restartStreaming?: () => Promise<boolean>
    isStreamingActive?: () => boolean
  }
}

export function shouldPollCoreMetrics(plan: Pick<StreamSessionPlan, 'source' | 'output'>): boolean {
  return plan.source.kind !== 'webcam' || plan.output.mode === 'rtmp'
}

export function getSubtitlePresentation(
  subtitle?: StreamSessionStartSubtitleMetadata,
): SubtitlePresentation {
  if (!subtitle) {
    return {
      visible: false,
      language: 'Language: -',
      cues: 'Cues: -',
      message: null,
      type: 'info',
    }
  }

  const language = subtitle.language || '-'
  const cueCount = subtitle.cueCount ?? '-'
  if (subtitle.warning) {
    return {
      visible: true,
      language: `Language: ${language}`,
      cues: `Cues: ${cueCount}`,
      message: subtitle.warning,
      type: 'warning',
    }
  }
  if (subtitle.state === 'ready') {
    return {
      visible: true,
      language: `Language: ${language}`,
      cues: `Cues: ${cueCount}`,
      message: 'Streaming with subtitle burn-in.',
      type: 'success',
    }
  }
  return {
    visible: true,
    language: `Language: ${language}`,
    cues: `Cues: ${cueCount}`,
    message: `Subtitle state: ${subtitle.state}`,
    type: subtitle.state === 'unavailable' ? 'warning' : 'info',
  }
}

export function validateCoreStartResponse(
  value: unknown,
  expectedOutputMode: StreamSessionPlan['output']['mode'],
): StreamSessionStartResponse {
  return parseStreamSessionStartResponse(value, expectedOutputMode)
}

export function initializeStreamingInterface(): void {
  for (const root of document.querySelectorAll<HTMLElement>('[data-streaming-interface]')) {
    if (root.dataset.initialized === 'true') continue
    root.dataset.initialized = 'true'
    new CoreStreamingInterface(root)
  }
}

class CoreStreamingInterface {
  private readonly root: HTMLElement
  private readonly preset: string
  private readonly annotationMode: boolean
  private readonly localVideo: HTMLVideoElement
  private readonly previewVideo: HTMLVideoElement
  private readonly streamOutputWrapper: HTMLElement
  private readonly outputTitle: HTMLElement
  private readonly startBtn: HTMLButtonElement
  private readonly stopBtn: HTMLButtonElement
  private readonly status: HTMLElement
  private readonly previewDebugOverlay: HTMLElement
  private readonly annotationCanvas: HTMLCanvasElement | null
  private readonly clearAnnotationsBtn: HTMLButtonElement | null
  private readonly runtime: StreamSessionRuntime
  private state: StreamingState = 'idle'
  private activePlan: StreamSessionPlan | null = null
  private startPromise: Promise<boolean> | null = null
  private stopPromise: Promise<void> | null = null
  private lastMetricState = ''
  private lastContainerMetrics: StreamSessionMetrics | null = null
  private recoveryTimer: ReturnType<typeof setInterval> | null = null
  private debugTimer: ReturnType<typeof setInterval> | null = null
  private previewChunksReceived = 0
  private previewBytesReceived = 0
  private lastPreviewChunkAt = 0
  private lastLiveRecoveryAt = 0
  private hlsPlayer: HlsInstance | null = null
  private annotationContext: CanvasRenderingContext2D | null = null
  private annotationDirty = false
  private activePointerId: number | null = null
  private lastAnnotationPoint: { x: number; y: number } | null = null
  private annotationRevision = 0
  private outputPresentationRevision = 0
  private outputPresentationController: AbortController | null = null

  constructor(root: HTMLElement) {
    this.root = root
    this.preset = root.dataset.preset || 'passthrough'
    this.annotationMode = root.dataset.annotationMode === 'true'
    this.localVideo = requiredElement(root, '#localVideo')
    this.previewVideo = requiredElement(root, '#previewVideo')
    this.streamOutputWrapper = requiredElement(root, '#streamOutputWrapper')
    this.outputTitle = requiredElement(root, '#outputTitle')
    this.startBtn = requiredElement(root, '#startBtn')
    this.stopBtn = requiredElement(root, '#stopBtn')
    this.status = requiredElement(root, '#status')
    this.previewDebugOverlay = requiredElement(root, '#previewDebugOverlay')
    this.annotationCanvas = root.querySelector<HTMLCanvasElement>('#annotationCanvas')
    this.clearAnnotationsBtn = root.querySelector<HTMLButtonElement>('#clearAnnotationsBtn')
    this.annotationContext = this.annotationCanvas?.getContext('2d') ?? null

    this.runtime = new StreamSessionRuntime({
      getBaseUrl: () => window.location.origin,
      video: this.previewVideo,
      isLocalDevelopment,
      getMinimumBufferSeconds: () => readStreamlineSettings().bufferPriming ?? 2,
      annotationIntervalMs: ANNOTATION_REPUBLISH_MS,
      prepareSession: preparePlaygroundAdmission,
      onStateChange: (state) => this.setState(state),
      onPhase: (phase) => this.applyRuntimePhase(phase),
      onWebcamAcquired: async (stream) => {
        this.localVideo.srcObject = stream
        await this.localVideo.play().catch(() => {})
      },
      onWebcamReleased: () => {
        this.localVideo.srcObject = null
      },
      onWebcamUploadError: (details) => {
        console.error('Webcam ingest failed', {
          ...details,
          webcam: this.runtime.getWebcamStats(),
          container: this.lastContainerMetrics,
        })
      },
      onWebcamQueueOverflow: (pendingBytes, incomingBytes) => {
        console.error('Webcam ingest queue overflow', {
          pendingBytes,
          incomingBytes,
          webcam: this.runtime.getWebcamStats(),
          container: this.lastContainerMetrics,
        })
      },
      onMediaRecorderError: (error) => {
        console.error('MediaRecorder error', error)
      },
      onMediaRecorderStopError: (error) => console.error('MediaRecorder stop failed', error),
      onAnnotationError: ({ status, error }) => {
        console.error('Annotation publish failed', status ?? error)
        this.setStatus(
          status === 409 ? 'Annotation session is no longer current.' : 'Annotation update was not accepted.',
          status === 409 ? 'error' : 'warning',
        )
      },
      onMseMediaSourceError: (event) => console.error('MediaSource error', event),
      onMseSourceBufferError: (event) => console.error('SourceBuffer error', event),
      onMseAppendError: (error) => console.error('MSE append failed', error),
      onMseUpdateEnd: () => this.updatePreviewDebugOverlay(),
      onPlaybackReady: () => {
        this.previewVideo.play().catch(() => {
          this.previewVideo.muted = true
          this.previewVideo.play().catch(() => {})
        })
      },
      onRelayPayload: (_payload, details) => {
        this.previewChunksReceived++
        this.previewBytesReceived += _payload.byteLength
        this.lastPreviewChunkAt = details.receivedAt
        if (details.recoveredFromStall) this.setStatus('Media output recovered.', 'success')
      },
      onRelayClose: (event, opened) => {
        if (opened && event.code !== 1012) {
          this.setStatus(`Durable Relay connection closed (${event.code}).`, 'warning')
        }
      },
      onRelayError: () => this.setStatus('Durable Relay connection error.', 'warning'),
      onRelayStalled: () => this.setStatus('Durable Relay is connected but media is stale.', 'warning'),
      onRelayReconnected: () => this.setStatus('Durable Relay reconnected.', 'success'),
      onRelayReconnectFailed: (_attempt, error) => console.error('Durable Relay reconnect failed', error),
      onMetrics: (metrics) => this.applyMetrics(metrics),
      onBeforeStopped: () => this.cleanupTerminalRun(),
      onStopped: (details) => this.emitStopped(details),
      onBeforeCompleted: () => this.cleanupTerminalRun(),
      onCompleted: (failure) => this.handleCompletion(failure),
      onReplaced: () => {
        this.setStatus('Streaming stopped because another relay session replaced it.', 'warning')
      },
      onFatalError: (_failure, message) => this.setStatus(message, 'error'),
    })

    this.startBtn.addEventListener('click', () => {
      void this.startStreaming()
    })
    this.stopBtn.addEventListener('click', () => {
      void this.stopStreaming('button')
    })
    this.previewVideo.addEventListener('waiting', () => this.maybeRecoverLivePlayback('waiting'))
    this.previewVideo.addEventListener('stalled', () => this.maybeRecoverLivePlayback('stalled'))
    this.previewVideo.addEventListener('error', () => this.updatePreviewDebugOverlay())
    window.addEventListener('pagehide', () => {
      if (this.state === 'starting' || this.state === 'running' || this.runtime.sessionId) {
        void this.stopStreaming('pagehide', true)
      }
    })

    this.initializeAnnotationCanvas()
    this.applyOutputModeUI(readStreamlineSettings().previewMode ?? true)
    this.installPublicHooks()
    this.setState('idle')

    const build = root.dataset.previewDebugBuild
    if (build) console.warn(`[streamline-build] ${build}`)
  }

  private installPublicHooks(): void {
    window.startStreaming = () => this.startStreaming()
    window.restartStreaming = () => this.restartStreaming()
    window.isStreamingActive = () => this.state === 'running'
  }

  private startStreaming(): Promise<boolean> {
    if (this.startPromise) return this.startPromise
    const startPromise = this.performStartStreaming()
    this.startPromise = startPromise
    const clearStartPromise = () => {
      if (this.startPromise === startPromise) this.startPromise = null
    }
    void startPromise.then(clearStartPromise, clearStartPromise)
    return startPromise
  }

  private async performStartStreaming(): Promise<boolean> {
    if (this.state !== 'idle' && this.state !== 'complete') return false
    this.stopPlaybackMonitoring()
    this.hideStreamSourcePanel()
    this.lastMetricState = ''
    this.lastContainerMetrics = null
    this.previewChunksReceived = 0
    this.previewBytesReceived = 0
    this.lastPreviewChunkAt = 0
    this.lastLiveRecoveryAt = 0
    this.applySubtitleMetadata(undefined)

    const startOptions: StreamingStartOptions = {
      settings: { ...readStreamlineSettings() },
      burnSubtitles: false,
    }
    const beforeStart = new CustomEvent<StreamingBeforeStartDetail>(STREAMING_EVENTS.beforeStart, {
      cancelable: true,
      detail: { options: startOptions },
    })
    document.dispatchEvent(beforeStart)
    if (beforeStart.defaultPrevented) {
      const message = beforeStart.detail.validationError || 'Streaming start was cancelled.'
      this.setStatus(message, 'error')
      this.emit<StreamingStartErrorDetail>(STREAMING_EVENTS.startError, { message })
      return false
    }

    let plan: StreamSessionPlan
    try {
      plan = buildCoreSessionPlan(startOptions.settings, {
        preset: this.preset,
        annotationEnabled: this.annotationMode,
        filters: this.preset === 'filters' ? window.getFilterValues?.() : undefined,
        burnSubtitles: startOptions.burnSubtitles,
      })
      buildCoreStartRequest(plan)
    } catch (error) {
      const message = errorMessage(error)
      this.setStatus(message, 'error')
      this.emit<StreamingStartErrorDetail>(STREAMING_EVENTS.startError, { message, error })
      return false
    }

    this.activePlan = plan
    this.applyOutputModeUI(plan.output.mode === 'websocket')
    if (this.annotationMode) this.resizeAnnotationCanvas(true, plan.outputResolution)

    try {
      if (!plan.webcamIngest) {
        await this.showStreamSourcePanel(startOptions.settings, plan)
      }

      const previewOutput = plan.output.mode === 'websocket'
      const response = await this.runtime.start({
        source: plan.source,
        outputMode: plan.output.mode,
        outputMime: plan.outputMime,
        buildRequest: (sessionId) => buildCoreStartRequest(plan, sessionId),
        validateResponse: (value) => validateCoreStartResponse(value, plan.output.mode),
        webcamIngest: plan.webcamIngest,
        getAnnotationBlob: this.annotationMode && this.annotationCanvas
          ? () => this.canvasPngBlob()
          : undefined,
        pollMetrics: shouldPollCoreMetrics(plan),
        completeOnInactiveMetrics: true,
      })
      if (!response) return false

      if (previewOutput) {
        this.startPlaybackMonitoring(isLiveSource(plan))
      }

      this.applySubtitleMetadata(response.subtitle)
      const subtitlePresentation = getSubtitlePresentation(response.subtitle)
      if (subtitlePresentation.message) {
        this.setStatus(subtitlePresentation.message, subtitlePresentation.type)
      } else if (this.annotationMode) {
        this.setStatus('Streaming with annotation overlay enabled.', 'success')
      } else if (this.preset === 'overlay') {
        this.setStatus('Streaming with overlay!', 'success')
      } else if (this.preset === 'pip') {
        this.setStatus('Streaming with webcam picture-in-picture.', 'success')
      } else if (plan.output.mode === 'rtmp') {
        this.setStatus('Streaming to the configured RTMP destination.', 'success')
      } else {
        this.setStatus('Streaming through Durable Relay.', 'success')
      }
      this.updateStreamSourceStatus('Processing...')
      this.emit<StreamingStartedDetail>(STREAMING_EVENTS.started, { plan, response })
      return true
    } catch (error) {
      const message = errorMessage(error)
      this.setStatus(`Error: ${message}`, 'error')
      this.emit<StreamingStartErrorDetail>(STREAMING_EVENTS.startError, { message, error })
      console.error('Start streaming failed', error)
      return false
    }
  }

  private async restartStreaming(): Promise<boolean> {
    if (this.state !== 'running') return false
    await this.stopStreaming('restart', true)
    if (this.runtime.state !== 'idle') return false
    return this.startStreaming()
  }

  private stopStreaming(reason: string, silent = false): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.startPromise = null
    const stopPromise = this.performStop(reason, silent)
    this.stopPromise = stopPromise
    const clearStopPromise = () => {
      if (this.stopPromise === stopPromise) this.stopPromise = null
    }
    void stopPromise.then(clearStopPromise, clearStopPromise)
    return stopPromise
  }

  private async performStop(reason: string, silent: boolean): Promise<void> {
    const { result: stopResult } = await this.runtime.stop(reason)
    if (!silent) {
      if (stopResult && 'error' in stopResult) {
        this.setStatus(`Stopped locally; server stop failed: ${errorMessage(stopResult.error)}`, 'warning')
      } else {
        this.setStatus('Stopped')
      }
    }
  }

  private applyRuntimePhase(phase: StreamSessionRuntimePhase): void {
    const messages: Record<StreamSessionRuntimePhase, string> = {
      'loading-annotation': 'Preparing annotation overlay...',
      'requesting-webcam': 'Requesting camera access...',
      'preparing-relay': 'Preparing Durable Relay...',
      'initializing-playback': 'Initializing browser playback...',
      'connecting-relay': 'Connecting Durable Relay...',
      'starting-container': 'Starting container session...',
      'waiting-for-local-output': 'Waiting for local container output...',
    }
    this.setStatus(messages[phase])
  }

  private applyMetrics(metrics: StreamSessionMetrics): void {
    this.lastContainerMetrics = metrics
    this.applySubtitleMetadata(metrics.subtitle)
    const ffmpegState = metrics.ffmpeg?.state || (metrics.running ? 'running' : 'waiting')
    this.updateStreamSourceStatus(ffmpegState === 'continue' ? 'Processing...' : ffmpegState)
    if (ffmpegState === this.lastMetricState) return

    this.lastMetricState = ffmpegState
    if (['stalled', 'restarting'].includes(ffmpegState)) {
      this.setStatus(`Container state: ${ffmpegState}.`, 'warning')
    } else if (ffmpegState === 'restart-failed') {
      this.setStatus('Container restart failed; retrying.', 'error')
    } else if (this.activePlan?.output.mode === 'rtmp' && metrics.running) {
      this.setStatus('Streaming to the configured RTMP destination.', 'success')
    }
  }

  private cleanupTerminalRun(): void {
    this.stopPlaybackMonitoring()
    this.hideStreamSourcePanel()
    this.activePlan = null
    this.lastContainerMetrics = null
  }

  private emitStopped({ reason, result: stopResult }: StreamSessionRuntimeStopDetails): void {
    this.emit(STREAMING_EVENTS.stopped, { reason, stopResult })
  }

  private handleCompletion(failure: string | null): void {
    this.setStatus(failure ? `Processing failed: ${failure}` : 'Playback complete', failure ? 'error' : 'success')
    this.emit(STREAMING_EVENTS.completed, { failure })
  }

  private startPlaybackMonitoring(live: boolean): void {
    this.stopPlaybackMonitoring()
    if (live) {
      this.recoveryTimer = setInterval(() => this.maybeRecoverLivePlayback('drift-check'), 500)
    }
    if (this.isPreviewDebugEnabled()) {
      this.debugTimer = setInterval(() => this.updatePreviewDebugOverlay(), 1_000)
      this.updatePreviewDebugOverlay()
    }
  }

  private stopPlaybackMonitoring(): void {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer)
    if (this.debugTimer) clearInterval(this.debugTimer)
    this.recoveryTimer = null
    this.debugTimer = null
    this.previewDebugOverlay.style.display = 'none'
  }

  private maybeRecoverLivePlayback(trigger: 'waiting' | 'stalled' | 'drift-check'): boolean {
    if (!this.runtime.active || !this.activePlan || !isLiveSource(this.activePlan)) return false
    const buffered = this.previewVideo.buffered
    if (buffered.length === 0) return false
    const now = performance.now()
    if (now - this.lastLiveRecoveryAt < 1_500) return false

    const lastIndex = buffered.length - 1
    const rangeStart = buffered.start(lastIndex)
    const rangeEnd = buffered.end(lastIndex)
    const current = this.previewVideo.currentTime
    const drift = rangeEnd - current
    const inLatestRange = current >= rangeStart && current <= rangeEnd
    const msSinceChunk = this.lastPreviewChunkAt ? now - this.lastPreviewChunkAt : Number.POSITIVE_INFINITY
    const shouldSeek = !inLatestRange
      || (trigger === 'drift-check' && drift > 5)
      || ((trigger === 'waiting' || trigger === 'stalled') && drift < 0.35 && msSinceChunk > 750)
    if (!shouldSeek) return false

    const targetLatency = drift > 12 ? 0.75 : trigger === 'drift-check' ? 2 : 0.75
    let target = Math.max(rangeStart + 0.05, rangeEnd - targetLatency)
    if (target >= rangeEnd) target = Math.max(rangeStart + 0.05, rangeEnd - 0.05)
    if (inLatestRange) {
      target = Math.max(target, Math.min(rangeEnd - 0.01, current + 0.05))
      if (target <= current + 0.01) return false
    }
    try {
      this.previewVideo.currentTime = target
      this.lastLiveRecoveryAt = now
      this.previewVideo.play().catch(() => {})
      return true
    } catch {
      return false
    }
  }

  private updatePreviewDebugOverlay(): void {
    const mse = this.runtime.getMseStats()
    if (!this.isPreviewDebugEnabled() || !mse || !this.runtime.active) {
      this.previewDebugOverlay.style.display = 'none'
      return
    }
    this.previewDebugOverlay.style.display = 'block'
    const ranges = bufferedRanges(this.previewVideo)
    const latestEnd = ranges.at(-1)?.[1]
    const drift = latestEnd === undefined ? null : latestEnd - this.previewVideo.currentTime
    const ingest = this.runtime.getWebcamStats()
    setText(this.root, '#debugChunks', `${this.previewChunksReceived} / ${ingest.chunksSent}`)
    setText(this.root, '#debugBuffer', ranges.map(([start, end]) => `${start.toFixed(1)}-${end.toFixed(1)}`).join(', ') || 'none')
    setText(this.root, '#debugDrift', drift === null ? '-' : `${drift.toFixed(2)}s`)
    setText(this.root, '#debugRate', `${this.previewVideo.playbackRate.toFixed(2)}x`)
    const state = this.previewVideo.error
      ? `ERR:${this.previewVideo.error.code}`
      : mse.sourceBufferUpdating
        ? 'appending'
        : this.previewVideo.paused
          ? 'paused'
          : this.previewVideo.readyState >= 3
            ? 'playing'
            : 'buffering'
    setText(this.root, '#debugState', state)

    if (this.isPreviewDebugEnabled()) {
      console.log('[preview-debug]', {
        chunks: this.previewChunksReceived,
        bytes: this.previewBytesReceived,
        lastChunkAgeMs: this.lastPreviewChunkAt ? performance.now() - this.lastPreviewChunkAt : null,
        ranges,
        drift,
        mse,
        ingest,
      })
    }
  }

  private isPreviewDebugEnabled(): boolean {
    return new URLSearchParams(window.location.search).has('debugPreview')
      || localStorage.getItem('streamlineDebugPreview') === '1'
  }

  private initializeAnnotationCanvas(): void {
    if (!this.annotationMode || !this.annotationCanvas) return
    this.configureAnnotationContext()
    this.resizeAnnotationCanvas(false)
    this.localVideo.addEventListener('loadedmetadata', () => this.resizeAnnotationCanvas(true))
    window.addEventListener('resize', () => this.resizeAnnotationCanvas(true))
    this.annotationCanvas.addEventListener('pointerdown', (event) => this.startAnnotationStroke(event))
    this.annotationCanvas.addEventListener('pointermove', (event) => this.continueAnnotationStroke(event))
    this.annotationCanvas.addEventListener('pointerup', (event) => this.finishAnnotationStroke(event))
    this.annotationCanvas.addEventListener('pointercancel', (event) => this.cancelAnnotationStroke(event))
    this.annotationCanvas.addEventListener('pointerleave', (event) => this.cancelAnnotationStroke(event))
    this.clearAnnotationsBtn?.addEventListener('click', () => this.clearAnnotationCanvas(true))
    this.updateAnnotationControls()
  }

  private configureAnnotationContext(): void {
    if (!this.annotationContext) return
    this.annotationContext.lineCap = 'round'
    this.annotationContext.lineJoin = 'round'
    this.annotationContext.strokeStyle = '#f48120'
    this.annotationContext.lineWidth = 6
  }

  private resizeAnnotationCanvas(preserveContents = true, resolution?: string): boolean {
    if (!this.annotationCanvas) return false
    const [width, height] = parseResolution(
      resolution || readStreamlineSettings().outputResolution || '1280x720',
    )
    if (this.annotationCanvas.width === width && this.annotationCanvas.height === height) return true

    let snapshot: HTMLCanvasElement | null = null
    if (preserveContents && this.annotationCanvas.width > 0 && this.annotationCanvas.height > 0) {
      snapshot = document.createElement('canvas')
      snapshot.width = this.annotationCanvas.width
      snapshot.height = this.annotationCanvas.height
      snapshot.getContext('2d')?.drawImage(this.annotationCanvas, 0, 0)
    }
    this.annotationCanvas.width = width
    this.annotationCanvas.height = height
    this.annotationContext = this.annotationCanvas.getContext('2d')
    this.configureAnnotationContext()
    if (snapshot && this.annotationContext) {
      this.annotationContext.drawImage(snapshot, 0, 0, width, height)
    }
    return true
  }

  private annotationPoint(event: PointerEvent): { x: number; y: number } | null {
    if (!this.annotationCanvas) return null
    const rect = this.annotationCanvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    return {
      x: (event.clientX - rect.left) * (this.annotationCanvas.width / rect.width),
      y: (event.clientY - rect.top) * (this.annotationCanvas.height / rect.height),
    }
  }

  private startAnnotationStroke(event: PointerEvent): void {
    if (!this.annotationCanvas || !this.annotationContext || this.activePointerId !== null) return
    this.resizeAnnotationCanvas(true)
    const point = this.annotationPoint(event)
    if (!point) return
    this.activePointerId = event.pointerId
    this.lastAnnotationPoint = point
    this.annotationCanvas.setPointerCapture(event.pointerId)
    this.annotationContext.beginPath()
    this.annotationContext.moveTo(point.x, point.y)
    this.annotationContext.lineTo(point.x, point.y)
    this.annotationContext.stroke()
    this.annotationDirty = true
    this.updateAnnotationControls()
  }

  private continueAnnotationStroke(event: PointerEvent): void {
    if (!this.annotationContext || this.activePointerId !== event.pointerId || !this.lastAnnotationPoint) return
    const point = this.annotationPoint(event)
    if (!point) return
    this.annotationContext.beginPath()
    this.annotationContext.moveTo(this.lastAnnotationPoint.x, this.lastAnnotationPoint.y)
    this.annotationContext.lineTo(point.x, point.y)
    this.annotationContext.stroke()
    this.lastAnnotationPoint = point
    this.annotationDirty = true
    this.updateAnnotationControls()
  }

  private finishAnnotationStroke(event: PointerEvent): void {
    if (!this.annotationCanvas || this.activePointerId !== event.pointerId) return
    if (this.annotationCanvas.hasPointerCapture(event.pointerId)) {
      this.annotationCanvas.releasePointerCapture(event.pointerId)
    }
    this.activePointerId = null
    this.lastAnnotationPoint = null
    void this.publishAnnotationSnapshot()
  }

  private cancelAnnotationStroke(event: PointerEvent): void {
    if (!this.annotationCanvas || this.activePointerId !== event.pointerId) return
    if (this.annotationCanvas.hasPointerCapture(event.pointerId)) {
      this.annotationCanvas.releasePointerCapture(event.pointerId)
    }
    this.activePointerId = null
    this.lastAnnotationPoint = null
  }

  private clearAnnotationCanvas(publish: boolean): void {
    if (!this.annotationCanvas || !this.annotationContext) return
    this.resizeAnnotationCanvas(false)
    this.annotationContext.clearRect(0, 0, this.annotationCanvas.width, this.annotationCanvas.height)
    this.annotationDirty = false
    this.updateAnnotationControls()
    if (publish) void this.publishAnnotationSnapshot()
  }

  private async publishAnnotationSnapshot(): Promise<void> {
    const revision = ++this.annotationRevision
    const sessionId = this.runtime.sessionId
    try {
      const blob = await this.canvasPngBlob()
      if (
        revision !== this.annotationRevision
        || !this.runtime.active
        || this.runtime.state !== 'running'
        || sessionId !== this.runtime.sessionId
      ) return
      await this.runtime.setAnnotationBlob(blob)
    } catch (error) {
      if (this.runtime.active) {
        this.setStatus(`Failed to capture annotation: ${errorMessage(error)}`, 'error')
      }
    }
  }

  private canvasPngBlob(): Promise<Blob> {
    if (!this.annotationCanvas) return Promise.reject(new Error('Annotation canvas is unavailable'))
    return new Promise((resolve, reject) => {
      this.annotationCanvas?.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('Canvas PNG encoding failed'))
      }, 'image/png')
    })
  }

  private updateAnnotationControls(): void {
    if (this.clearAnnotationsBtn) this.clearAnnotationsBtn.disabled = !this.annotationDirty
  }

  private async showStreamSourcePanel(settings: StreamlineSettings, plan: StreamSessionPlan): Promise<void> {
    if (this.annotationMode) {
      this.localVideo.style.display = 'block'
      if (this.annotationCanvas) this.annotationCanvas.style.display = 'block'
      let previewUrl = plan.source.kind === 'hls' ? plan.source.url : undefined
      if (plan.source.kind === 'rtmp') {
        try {
          previewUrl = (await fetchMediaEndpoints()).inputHlsUrl
        } catch (error) {
          console.error('Could not load the input presentation URL', error)
        }
      }
      if (previewUrl) {
        if (!(await this.loadHlsStream(previewUrl))) {
          this.setStatus('HLS source preview is not supported in this browser.', 'warning')
        }
      } else if (plan.source.kind === 'rtmp') {
        this.setStatus('No HLS preview URL is configured for annotation.', 'warning')
      }
      return
    }

    this.localVideo.style.display = 'none'
    const panel = this.localVideo.parentElement
    if (!panel) return
    let info = this.root.querySelector<HTMLElement>('#streamSourceInfo')
    if (!info) {
      info = document.createElement('div')
      info.id = 'streamSourceInfo'
      panel.insertBefore(info, this.localVideo.nextSibling)
    }
    info.className = 'stream-source-info'
    info.style.display = 'block'

    if (plan.source.kind === 'hls') {
      const videoId = settings.videoId || ''
      const thumbnail = `https://videodelivery.net/${encodeURIComponent(String(videoId))}/thumbnails/thumbnail.jpg?time=2s&height=320`
      info.innerHTML = `
        <div class="stream-source-card stream-source-thumbnail" style="background-image:url('${escapeHtmlAttribute(thumbnail)}')">
          <div class="stream-source-copy">
            <span class="stream-source-badge">Stream Video (HLS)</span>
            <span class="stream-source-mono">ID: ${escapeHtml(String(videoId))}</span>
            <span id="streamSourceStatus">Starting...</span>
          </div>
        </div>`
    } else if (plan.source.kind === 'rtmp') {
      info.innerHTML = `
        <div class="stream-source-card stream-source-live">
          <span class="stream-source-pill">RTMPS playback</span>
          <div class="stream-source-copy">
            <span class="stream-source-badge">Stream Live</span>
            <span>Server-managed RTMP input profile</span>
            <span class="stream-source-mono">Profile: ${escapeHtml(plan.source.profile)}</span>
            <span id="streamSourceStatus">Starting...</span>
          </div>
        </div>`
    } else {
      info.style.display = 'none'
    }
  }

  private async loadHlsStream(url: string): Promise<boolean> {
    this.hlsPlayer?.destroy()
    this.hlsPlayer = null
    if (this.localVideo.canPlayType('application/vnd.apple.mpegurl')) {
      this.localVideo.src = url
      this.localVideo.play().catch(() => {})
      return true
    }
    try {
      const { default: Hls } = await import('hls.js')
      if (!Hls.isSupported()) return false
      this.hlsPlayer = new Hls({ maxBufferLength: 4 })
      this.hlsPlayer.loadSource(url)
      this.hlsPlayer.attachMedia(this.localVideo)
      this.hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => this.localVideo.play().catch(() => {}))
      return true
    } catch {
      return false
    }
  }

  private hideStreamSourcePanel(): void {
    const info = this.root.querySelector<HTMLElement>('#streamSourceInfo')
    if (info) info.style.display = 'none'
    this.hlsPlayer?.destroy()
    this.hlsPlayer = null
    if (this.localVideo.src) {
      this.localVideo.pause()
      this.localVideo.removeAttribute('src')
      this.localVideo.load()
    }
    this.localVideo.style.display = 'block'
    if (this.annotationCanvas) this.annotationCanvas.style.display = 'block'
  }

  private updateStreamSourceStatus(message: string): void {
    const sourceStatus = this.root.querySelector<HTMLElement>('#streamSourceStatus')
    if (sourceStatus) sourceStatus.textContent = message
  }

  private applyOutputModeUI(preview: boolean): void {
    if (preview) {
      this.outputPresentationRevision++
      this.outputPresentationController?.abort()
      this.outputPresentationController = null
      const player = this.root.querySelector<HTMLIFrameElement>('#streamPlayer')
      if (player) player.src = 'about:blank'
      this.streamOutputWrapper.style.display = 'none'
      this.previewVideo.style.display = 'block'
      this.outputTitle.textContent = 'Live Preview'
      return
    }
    this.previewVideo.style.display = 'none'
    this.streamOutputWrapper.style.display = 'block'
    this.outputTitle.textContent = 'Stream Output'
    void this.updateStreamOutput()
  }

  private async updateStreamOutput(): Promise<void> {
    const revision = ++this.outputPresentationRevision
    this.outputPresentationController?.abort()
    const controller = new AbortController()
    this.outputPresentationController = controller
    const player = this.root.querySelector<HTMLIFrameElement>('#streamPlayer')
    const placeholder = this.root.querySelector<HTMLElement>('#playerContainer')
    if (!player || !placeholder) return
    player.src = 'about:blank'
    player.style.display = 'none'
    placeholder.style.display = 'flex'
    try {
      const playerUrl = (await fetchMediaEndpoints({ signal: controller.signal })).outputPlayerUrl
      if (revision !== this.outputPresentationRevision || !playerUrl) return
      player.src = playerUrl
      player.style.display = 'block'
      placeholder.style.display = 'none'
    } catch (error) {
      if (revision !== this.outputPresentationRevision) return
      console.error('Could not load the output presentation URL', error)
      player.style.display = 'none'
      placeholder.style.display = 'flex'
    } finally {
      if (this.outputPresentationController === controller) this.outputPresentationController = null
    }
  }

  private applySubtitleMetadata(subtitle?: StreamSessionStartSubtitleMetadata): void {
    const presentation = getSubtitlePresentation(subtitle)
    const info = this.root.querySelector<HTMLElement>('#subtitleInfo')
    const language = this.root.querySelector<HTMLElement>('#subtitleLang')
    const cues = this.root.querySelector<HTMLElement>('#subtitleCues')
    const subtitleStatus = this.root.querySelector<HTMLElement>('#subtitleStatus .status-text')
    if (info) info.style.display = presentation.visible ? 'flex' : 'none'
    if (language) language.textContent = presentation.language
    if (cues) cues.textContent = presentation.cues
    if (subtitleStatus && presentation.message) {
      subtitleStatus.textContent = presentation.message
      subtitleStatus.className = `status-text status-${presentation.type}`
    }
  }

  private setState(state: StreamingState): void {
    this.state = state
    const active = state === 'starting' || state === 'running'
    this.startBtn.disabled = active || state === 'stopping'
    this.stopBtn.disabled = !active
    this.emit<StreamingStateChangeDetail>(STREAMING_EVENTS.stateChange, {
      state,
      active: state === 'running',
    })
  }

  private setStatus(message: string, type: StreamingStatusType = 'info'): void {
    this.status.textContent = message
    this.status.className = `status status-${type}`
    this.emit<StreamingStatusDetail>(STREAMING_EVENTS.status, { message, type })
  }

  private emit<T>(name: string, detail: T): void {
    document.dispatchEvent(new CustomEvent<T>(name, { detail }))
  }

}

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector)
  if (!element) throw new Error(`Streaming interface is missing ${selector}`)
  return element
}

function setText(root: ParentNode, selector: string, value: string): void {
  const element = root.querySelector<HTMLElement>(selector)
  if (element) element.textContent = value
}

function isLocalDevelopment(): boolean {
  return import.meta.env.DEV
}

function isLiveSource(plan: StreamSessionPlan): boolean {
  return plan.source.kind === 'webcam' || plan.source.kind === 'rtmp'
}

function parseResolution(resolution: string): [number, number] {
  const [width, height] = resolution.split('x').map(Number)
  return [width || 1280, height || 720]
}

function bufferedRanges(video: HTMLVideoElement): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (let index = 0; index < video.buffered.length; index++) {
    ranges.push([video.buffered.start(index), video.buffered.end(index)])
  }
  return ranges
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replaceAll('`', '&#096;')
}
