import { loadScaledAnnotationPng } from './annotation-publisher.ts'
import {
  OnlineStatistics,
  ProbeTraceHistory,
  findNewBufferGaps,
  formatBytes,
  formatDuration,
  formatOptionalMetric,
  formatThroughput,
  type ProbeBufferGap,
  type ProbeBufferRange,
  type ProbeEvent,
  type ProbeThroughputSample,
} from './probe-diagnostics.ts'
import {
  buildProbeSessionPlan,
  buildProbeStartRequest,
  parseStreamSessionStartResponse,
  readStreamlineSettings,
  type ProbeTraceConfig,
} from './stream-session-config.ts'
import {
  StreamSessionRuntime,
  type StreamSessionMetrics,
  type StreamSessionRuntimePhase,
} from './stream-session-runtime.ts'

const ANNOTATION_INTERVAL_MS = 250
const RENDERED_EVENT_LIMIT = 1_000
const THROUGHPUT_SAMPLE_LIMIT = 2_048
const TEST_STREAM_TIMEOUT_MS = 15_000
const TEST_STREAM_MAX_BYTES = 1024 * 1024
const TEST_STREAM_MAX_LINE_CHARACTERS = 64 * 1024

export function initializeProbeInterface(): void {
  const candidateRoot = document.querySelector<HTMLElement>('[data-probe-interface]')
  if (!candidateRoot || candidateRoot.dataset.initialized === 'true') return
  const root: HTMLElement = candidateRoot
  root.dataset.initialized = 'true'

  let startTime = 0
  const trace = new ProbeTraceHistory()
  let dashboardTimer: ReturnType<typeof setInterval> | null = null
  let driftTimer: ReturnType<typeof setInterval> | null = null
  let testStreamController: AbortController | null = null
  let outputConnectionCount = 0
  let lastOutputSampleTime = 0
  let lastChunkTime = 0
  const interarrivalStats = new OnlineStatistics()
  let throughputSamples: ProbeThroughputSample[] = []
  let stallCount = 0
  let totalStallDuration = 0
  let recoveryCount = 0
  let playingCount = 0
  let seekingCount = 0
  let chunkCount = 0
  let byteCount = 0
  let playbackState = 'idle'
  let gapCount = 0
  let observedGaps: ProbeBufferGap[] = []
  let statusText = 'Ready'
  let hasStartedPlaying = false
  let startupTime = 0
  let lastCurrentTime = 0
  let lastCurrentTimeAt = 0
  let maxBufferScale = 5
  let lastStallStart = 0
  let activeProbeConfig: ProbeTraceConfig | null = null
  let latestContainerMetrics: StreamSessionMetrics | null = null
  let producerRestartCount = 0
  let stopPromise: Promise<void> | null = null

  const startBtn = requiredElement<HTMLButtonElement>(root, 'startBtn')
  const stopBtn = requiredElement<HTMLButtonElement>(root, 'stopBtn')
  const testStreamBtn = requiredElement<HTMLButtonElement>(root, 'testStreamBtn')
  const clearBtn = requiredElement<HTMLButtonElement>(root, 'clearBtn')
  const downloadBtn = requiredElement<HTMLButtonElement>(root, 'downloadBtn')
  const annotationToggle = requiredElement<HTMLInputElement>(root, 'annotationToggle')
  const statusEl = requiredElement<HTMLElement>(root, 'status')
  const dashboard = requiredElement<HTMLElement>(root, 'dashboard')
  const probeVideo = requiredElement<HTMLVideoElement>(root, 'probeVideo')
  const eventLog = requiredElement<HTMLElement>(root, 'eventLog')
  const eventCount = requiredElement<HTMLElement>(root, 'eventCount')

  const runtime = new StreamSessionRuntime({
    getBaseUrl: () => window.location.origin,
    video: probeVideo,
    isLocalDevelopment: () => import.meta.env.DEV,
    getMinimumBufferSeconds: () => readStreamlineSettings().bufferPriming ?? 2,
    getMseRetentionSeconds: () => 30,
    getMsePruneIntervalSeconds: () => 10,
    isAnnotationReady: () => hasStartedPlaying,
    annotationIntervalMs: ANNOTATION_INTERVAL_MS,
    onStateChange: (state) => {
      const active = state === 'starting' || state === 'running'
      startBtn.disabled = active || state === 'stopping'
      stopBtn.disabled = !active
    },
    onPhase: (phase) => {
      const messages: Record<StreamSessionRuntimePhase, string> = {
        'loading-annotation': 'Loading annotation PNG...',
        'requesting-webcam': 'Requesting camera access...',
        'preparing-relay': 'Preparing Durable Object relay...',
        'initializing-playback': 'Initializing MSE...',
        'connecting-relay': 'Connecting Durable Object relay...',
        'starting-container': 'Starting autonomous container session...',
        'waiting-for-local-output': 'Waiting for local container output...',
      }
      setStatus(messages[phase])
    },
    onWebcamAcquired: (stream) => {
      const settings = stream.getVideoTracks()[0]?.getSettings()
      logEvent('webcam-acquired', {
        width: settings?.width,
        height: settings?.height,
        frameRate: settings?.frameRate,
      })
    },
    onWebcamStarted: () => logEvent('http-recorder-started'),
    onWebcamUploadError: ({ status, responseBody, error, requestId, requestBytes, durationMs, timedOut }) => {
      const request = { requestId, requestBytes, durationMs, timedOut }
      if (status !== undefined) logEvent('http-ingest-error', { status, responseBody, ...request })
      else logEvent('http-ingest-error', { error: String(error), ...request })
    },
    onWebcamQueueOverflow: (pendingBytes, incomingBytes) => {
      logEvent('http-ingest-queue-overflow', { pendingBytes, incomingBytes })
    },
    onMediaRecorderError: (error) => logEvent('http-recorder-error', { error: String(error) }),
    onMediaRecorderStopError: (error) => logEvent('http-recorder-stop-error', { error: String(error) }),
    onAnnotationSent: (size) => logEvent('annotation-sent', { size }),
    onAnnotationLoaded: (blob) => logEvent('annotation-loaded', { size: blob.size }),
    onAnnotationError: ({ status, error }) => {
      logEvent('annotation-error', status === undefined ? { error: String(error) } : { status, error })
    },
    onMseSourceOpen: () => logEvent('mse-sourceopen'),
    onMseMediaSourceError: (event) => logEvent('mse-error', { error: String(event) }),
    onMseSourceBufferError: (event) => logEvent('mse-error', { error: String(event) }),
    onMseAppendError: (error, errorName) => {
      logEvent('append-error', { error: errorName || String(error) })
    },
    onMseQuotaExceeded: () => logEvent('quota-exceeded'),
    onMseQueueOverflow: (queuedBytes, incomingBytes) => {
      logEvent('mse-queue-overflow', { queuedBytes, incomingBytes })
    },
    onPlaybackReady: (bufferDuration) => {
      logEvent('playback-attempt', {
        bufferDuration,
        readyState: probeVideo.readyState,
        paused: probeVideo.paused,
      })
      probeVideo.play().then(() => {
        logEvent('playback-success')
      }).catch((error: Error) => {
        logEvent('playback-error', { error: error.name, message: error.message })
        probeVideo.muted = true
        probeVideo.play().catch((retryError: Error) => {
          logEvent('playback-retry-error', { error: retryError.name })
        })
      })
    },
    onRelayOpen: (reason, connection) => {
      outputConnectionCount = connection
      logEvent('output-open', { reason, connection })
      setStatus(`Relay connected (connection ${connection})`, 'success')
    },
    onRelayPayload: (payload, details) => {
      const { receivedAt: receivedAt, deltaMs, connection, recoveredFromStall } = details
      lastChunkTime = receivedAt
      if (deltaMs > 0) interarrivalStats.append(deltaMs)
      chunkCount++
      byteCount += payload.byteLength
      throughputSamples.push({ t: receivedAt, bytes: byteCount })
      trimThroughputSamples(receivedAt)

      if (receivedAt - lastOutputSampleTime >= 1_000) {
        lastOutputSampleTime = receivedAt
        logEvent('output-data', {
          size: payload.byteLength,
          deltaMs: Number(deltaMs.toFixed(2)),
          connection,
        })
      }
      if (recoveredFromStall) {
        logEvent('output-recovered', { gapMs: Number(deltaMs.toFixed(2)), connection })
        setStatus('Media output recovered', 'success')
      }
    },
    onRelayEnd: () => logEvent('output-ended'),
    onRelayClose: (event, opened) => {
      logEvent('output-close', {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      })
      if (opened && runtime.active && event.code !== 1000 && event.code !== 1012) {
        setStatus(`Relay connection closed (code ${event.code})`, 'error')
      }
    },
    onRelayError: (connection) => logEvent('output-error', { connection }),
    onRelayStalled: (ageMs) => {
      logEvent('output-stalled', { ageMs })
      setStatus('Relay is open but media output is stale', 'warning')
    },
    onRelayReconnectScheduled: (closeCode, attempt, delayMs) => {
      logEvent('output-reconnect-scheduled', { closeCode, attempt, delayMs })
    },
    onRelayReconnected: (attempt) => {
      logEvent('output-reconnected', { attempt })
      setStatus('Durable Object relay reconnected', 'success')
    },
    onRelayReconnectFailed: (attempt, error) => {
      logEvent('output-reconnect-failed', { attempt, error: String(error) })
    },
    onMetrics: handleContainerMetrics,
    getLastKnownFailure: () => latestContainerMetrics?.lastFfmpegExitError || null,
    onRemoteStopStarted: ({ reason, requestId, sessionId }) => {
      logEvent('probe-stop', { reason, stopRequestId: requestId, sessionId })
    },
    onRemoteStopFinished: ({ result }) => {
      if ('error' in result) {
        logEvent('probe-stop-error', { stopRequestId: result.requestId, error: String(result.error) })
      } else {
        logEvent('probe-stop-response', {
          stopRequestId: result.requestId,
          status: result.status,
          durationMs: result.durationMs,
        })
      }
    },
    onBeforeCompleted: finishProbeUi,
    onCompleted: (failure) => {
      setStatus(failure ? `Processing failed: ${failure}` : 'Source processing complete', failure ? 'error' : 'success')
    },
    onReplaced: () => {
      finishProbeUi()
      setStatus('Probe stopped because another relay session replaced it', 'warning')
    },
    onFatalError: (failure, message) => {
      logEvent('runtime-fatal', { failure, message })
      finishProbeUi()
      setStatus(message.replace('Streaming stopped', 'Probe stopped'), 'error')
    },
  })

  function now(): number {
    return performance.now()
  }

  function logEvent(type: string, data: object = {}): void {
    const entry: ProbeEvent = { t: now() - startTime, type, ...data }
    trace.append(entry)
    if (type !== 'drift-sample' && type !== 'container-metrics') renderEvent(entry)
    else updateEventCount()
  }

  function renderEvent(entry: ProbeEvent): void {
    eventLog.querySelector('.event-placeholder')?.remove()
    const div = root.ownerDocument.createElement('div')
    div.className = `event event-${entry.type}`
    const dataText = Object.entries(entry)
      .filter(([key]) => key !== 't' && key !== 'type')
      .map(([key, value]) => `${key}=${typeof value === 'number' ? value.toFixed(2) : value}`)
      .join(' ')
    div.textContent = `[${entry.t.toFixed(0).padStart(6, '0')}ms] ${entry.type}${dataText ? ` ${dataText}` : ''}`
    eventLog.appendChild(div)
    while (eventLog.childElementCount > RENDERED_EVENT_LIMIT) eventLog.firstElementChild?.remove()
    eventLog.scrollTop = eventLog.scrollHeight
    updateEventCount()
  }

  function updateEventCount(): void {
    eventCount.textContent = `(${trace.totalCount})`
  }

  function clearLog(): void {
    trace.clear()
    eventLog.innerHTML = '<div class="event-placeholder">Events will appear here when probe is running.</div>'
    updateEventCount()
  }

  function setStatus(text: string, type = 'info'): void {
    statusText = text
    statusEl.textContent = text
    statusEl.className = `status status-${type}`
  }

  function onVideoWaiting(): void {
    playbackState = 'waiting'
    if (!hasStartedPlaying) {
      logEvent('video-waiting', { currentTime: probeVideo.currentTime, startup: true })
      return
    }
    if (lastStallStart > 0) return
    stallCount++
    lastStallStart = now()
    const buffered = probeVideo.buffered
    logEvent('video-waiting', {
      currentTime: probeVideo.currentTime,
      bufferedEnd: buffered.length > 0 ? buffered.end(buffered.length - 1) : 0,
      playableAhead: getPlayableAhead(buffered, probeVideo.currentTime),
    })
  }

  function getPlayableAhead(buffered: TimeRanges, currentTime: number): number {
    for (let index = 0; index < buffered.length; index++) {
      if (currentTime >= buffered.start(index) && currentTime <= buffered.end(index)) {
        return buffered.end(index) - currentTime
      }
    }
    return 0
  }

  function onVideoPlaying(): void {
    playbackState = 'playing'
    if (!hasStartedPlaying) {
      hasStartedPlaying = true
      startupTime = now() - startTime
      logEvent('video-playing', { startup: true, startupTimeMs: startupTime })
      return
    }
    playingCount++
    if (lastStallStart > 0) {
      const recoveryDuration = now() - lastStallStart
      totalStallDuration += recoveryDuration
      recoveryCount++
      lastStallStart = 0
      logEvent('video-recovery', { durationMs: recoveryDuration })
    } else {
      logEvent('video-playing')
    }
  }

  function onVideoStalled(): void {
    playbackState = 'stalled'
    logEvent('video-stalled', { currentTime: probeVideo.currentTime })
  }

  function onVideoSeeking(): void {
    playbackState = 'seeking'
    seekingCount++
    logEvent('video-seeking', { currentTime: probeVideo.currentTime })
  }

  function updateDashboard(): void {
    const dashboardNow = now()
    const elapsed = startTime > 0 ? dashboardNow - startTime : 0
    setText(root, 'dashDuration', formatDuration(elapsed))
    setText(root, 'dashChunks', String(chunkCount))
    setText(root, 'dashBytes', formatBytes(byteCount))
    trimThroughputSamples(dashboardNow)
    setText(root, 'dashThroughput', formatThroughput(throughputSamples, dashboardNow))
    setText(root, 'dashJitter', interarrivalStats.count > 1
      ? `±${interarrivalStats.standardDeviation.toFixed(0)}ms`
      : '-')
    setText(root, 'dashLastChunk', lastChunkTime > 0 ? `${(dashboardNow - lastChunkTime).toFixed(0)}ms ago` : '-')
    setText(root, 'dashStatus', statusText)

    const buffered = probeVideo.buffered
    let latest = 0
    let current = 0
    if (buffered.length > 0) {
      latest = buffered.end(buffered.length - 1)
      current = probeVideo.currentTime
      setText(root, 'dashLatest', `${latest.toFixed(2)}s`)
      setText(root, 'dashCurrent', `${current.toFixed(2)}s`)
      setText(root, 'dashDrift', `${(latest - current).toFixed(2)}s`)
    }

    setText(root, 'dashRanges', readBufferedRanges(buffered)
      .map((range) => `[${range.start.toFixed(2)}-${range.end.toFixed(2)}]`)
      .join(', ') || '-')
    setText(root, 'dashGaps', String(gapCount))

    const playbackSpeed = lastCurrentTime > 0 && lastCurrentTimeAt > 0
      ? ((probeVideo.currentTime - lastCurrentTime) / ((dashboardNow - lastCurrentTimeAt) / 1_000)).toFixed(2)
      : null
    lastCurrentTime = probeVideo.currentTime
    lastCurrentTimeAt = dashboardNow

    setText(root, 'dashStartup', startupTime > 0 ? formatDuration(startupTime) : '-')
    setText(root, 'dashSpeed', playbackSpeed === null ? '-' : `${playbackSpeed}x`)
    setText(root, 'dashStalls', String(stallCount))
    setText(root, 'dashRecovery', recoveryCount > 0 ? formatDuration(totalStallDuration / recoveryCount) : '-')
    setText(root, 'dashPlaying', String(playingCount))
    setText(root, 'dashSeeking', String(seekingCount))
    setText(root, 'dashProducerState', latestContainerMetrics
      ? `${latestContainerMetrics.sessionActive ? 'active' : 'inactive'} / ${latestContainerMetrics.ffmpeg?.state || (latestContainerMetrics.running ? 'running' : 'stopped')}`
      : '-')
    setText(root, 'dashFfmpegSpeed', formatOptionalMetric(latestContainerMetrics?.ffmpeg?.speed, 3, 'x'))
    setText(root, 'dashFfmpegFps', formatOptionalMetric(latestContainerMetrics?.ffmpeg?.fps, 1))
    setText(root, 'dashFfmpegBitrate', latestContainerMetrics?.ffmpeg?.bitrate || '-')
    setText(root, 'dashProgressAge', formatOptionalMetric(scaleMilliseconds(latestContainerMetrics?.progressAgeMs), 1, 's'))
    setText(root, 'dashOutputAge', formatOptionalMetric(scaleMilliseconds(latestContainerMetrics?.outputAgeMs), 1, 's'))
    setText(root, 'dashRestarts', String(latestContainerMetrics?.restartCount ?? '-'))
    setText(root, 'dashRelayQueue', latestContainerMetrics?.outputQueueDepth === undefined
      ? '-'
      : `${latestContainerMetrics.outputQueueDepth} messages`)
    const mseStats = runtime.getMseStats()
    setText(root, 'dashMseQueue', mseStats ? `${mseStats.queueChunks} messages / ${formatBytes(mseStats.queueBytes)}` : '-')

    const stateEl = root.querySelector<HTMLElement>('#playbackState')
    if (stateEl) {
      stateEl.className = `playback-state ${playbackState}`
      stateEl.title = playbackState
    }
    updateBufferViz(buffered, current, latest)
  }

  function trimThroughputSamples(sampleTime: number): void {
    while (throughputSamples.length > 1 && sampleTime - throughputSamples[0].t > 10_000) {
      throughputSamples.shift()
    }
    if (throughputSamples.length > THROUGHPUT_SAMPLE_LIMIT) {
      throughputSamples.splice(0, throughputSamples.length - THROUGHPUT_SAMPLE_LIMIT)
    }
  }

  function updateBufferViz(buffered: TimeRanges, current: number, latest: number): void {
    const bar = root.querySelector<HTMLElement>('#bufferBar')
    const fillLine = root.querySelector<HTMLElement>('#bufferFillLine')
    const gradient = root.querySelector<HTMLElement>('#bufferGradient')
    if (!bar || !fillLine || !gradient) return

    if (buffered.length === 0 || latest <= 0) {
      bar.classList.add('no-data')
      fillLine.style.display = 'none'
      gradient.style.display = 'none'
      return
    }

    bar.classList.remove('no-data')
    gradient.style.display = 'block'
    const bufferAhead = latest - current
    if (bufferAhead > maxBufferScale) maxBufferScale = Math.ceil(bufferAhead)
    const displayScale = Math.max(5, maxBufferScale)
    const fillPercent = Math.min(100, (bufferAhead / displayScale) * 100)
    fillLine.style.display = 'block'
    fillLine.style.left = `${fillPercent}%`

    const redEnd = Math.min(100, (1 / displayScale) * 100)
    const orangeEnd = Math.min(100, (2 / displayScale) * 100)
    const yellowEnd = Math.min(100, (3 / displayScale) * 100)
    gradient.style.background = `linear-gradient(to right, #f44336 0%, #ff9800 ${redEnd}%, #ffeb3b ${orangeEnd}%, #4caf50 ${yellowEnd}%, #4caf50 100%)`

    const labels = bar.nextElementSibling?.querySelectorAll('span')
    if (labels && labels.length >= 3) {
      labels[0].textContent = '0s'
      labels[1].textContent = `${(displayScale / 2).toFixed(1)}s`
      labels[2].textContent = `${displayScale}s`
    }
  }

  function checkGaps(): void {
    const update = findNewBufferGaps(readBufferedRanges(probeVideo.buffered), observedGaps)
    observedGaps = update.observedGaps
    for (const gap of update.newGaps) {
      gapCount++
      logEvent('buffer-gap', gap)
    }
  }

  async function startProbe(): Promise<void> {
    startBtn.disabled = true
    stopBtn.disabled = false
    downloadBtn.disabled = true
    clearLog()
    startTime = now()
    lastChunkTime = 0
    lastOutputSampleTime = 0
    outputConnectionCount = 0
    interarrivalStats.clear()
    throughputSamples = []
    stallCount = 0
    totalStallDuration = 0
    recoveryCount = 0
    playingCount = 0
    seekingCount = 0
    chunkCount = 0
    byteCount = 0
    playbackState = 'idle'
    gapCount = 0
    observedGaps = []
    hasStartedPlaying = false
    startupTime = 0
    lastCurrentTime = 0
    lastCurrentTimeAt = 0
    maxBufferScale = 5
    lastStallStart = 0
    activeProbeConfig = null
    latestContainerMetrics = null
    producerRestartCount = 0

    const settings = readStreamlineSettings()
    const annotationEnabled = annotationToggle.checked
    const plan = buildProbeSessionPlan(settings, annotationEnabled)
    activeProbeConfig = plan.traceConfig
    probeVideo.addEventListener('waiting', onVideoWaiting)
    probeVideo.addEventListener('playing', onVideoPlaying)
    probeVideo.addEventListener('stalled', onVideoStalled)
    probeVideo.addEventListener('seeking', onVideoSeeking)
    dashboard.style.display = 'block'

    try {
      const data = await runtime.start({
        source: plan.source,
        outputMode: 'websocket',
        outputMime: plan.outputMime,
        buildRequest: (sessionId) => buildProbeStartRequest(plan, sessionId),
        validateResponse: (value) => parseStreamSessionStartResponse(value, 'websocket'),
        getPreflightAnnotationBlob: annotationEnabled
          ? () => loadScaledAnnotationPng('/probe-annotation.png', plan.outputResolution)
          : undefined,
        pollMetrics: true,
        metricsIntervalMs: 5_000,
      })
      if (!data) return
      logEvent('http-start', { mode: data.mode, preset: plan.preset })
    } catch (error) {
      finishProbeUi()
      setStatus(`Probe start failed: ${errorMessage(error)}`, 'error')
      return
    }

    dashboardTimer = setInterval(updateDashboard, 500)
    driftTimer = setInterval(() => {
      const buffered = probeVideo.buffered
      if (buffered.length > 0) {
        const latest = buffered.end(buffered.length - 1)
        const current = probeVideo.currentTime
        logEvent('drift-sample', { latest, current, driftMs: (latest - current) * 1_000 })
      }
      checkGaps()
    }, 500)
    setStatus('Probe running through Durable Object relay', 'success')
  }

  function handleContainerMetrics(metrics: StreamSessionMetrics): void {
    latestContainerMetrics = metrics
    if ((metrics.restartCount ?? 0) > producerRestartCount) {
      logEvent('producer-restart', {
        restartCount: metrics.restartCount,
        state: metrics.ffmpeg?.state,
        lastExitError: metrics.lastFfmpegExitError,
      })
    }
    producerRestartCount = metrics.restartCount ?? producerRestartCount
    const mseStats = runtime.getMseStats()
    const webcamStats = runtime.getWebcamStats()
    logEvent('container-metrics', {
      running: metrics.running,
      sessionActive: metrics.sessionActive,
      frame: metrics.ffmpeg?.frame,
      fps: metrics.ffmpeg?.fps,
      bitrate: metrics.ffmpeg?.bitrate,
      outTimeUs: metrics.ffmpeg?.outTimeUs,
      speed: metrics.ffmpeg?.speed,
      dupFrames: metrics.ffmpeg?.dupFrames,
      dropFrames: metrics.ffmpeg?.dropFrames,
      ffmpegState: metrics.ffmpeg?.state,
      ffmpegUpdatedAt: metrics.ffmpeg?.updatedAt,
      progressAgeMs: metrics.progressAgeMs,
      lastOutputAt: metrics.lastOutputAt,
      outputAgeMs: metrics.outputAgeMs,
      restartCount: metrics.restartCount,
      lastRestartAt: metrics.lastRestartAt,
      lastFfmpegExitError: metrics.lastFfmpegExitError,
      outputSubscriber: metrics.outputSubscriber,
      outputQueueDepth: metrics.outputQueueDepth,
      reconnectBufferBytes: metrics.reconnectBufferBytes,
      reconnectOverflowed: metrics.reconnectOverflowed,
      mseQueueChunks: mseStats?.queueChunks ?? 0,
      mseQueueBytes: mseStats?.queueBytes ?? 0,
      ingestPendingBytes: webcamStats.pendingBytes,
      ingestChunksSent: webcamStats.chunksSent,
      ingestPendingChunks: webcamStats.pendingChunks,
      ingestRequestsCompleted: webcamStats.requestsCompleted,
      ingestActiveRequestId: webcamStats.activeRequestId,
      ingestActiveRequestBytes: webcamStats.activeRequestBytes,
      ingestActiveRequestAgeMs: webcamStats.activeRequestAgeMs,
      ingestLastRequestDurationMs: webcamStats.lastRequestDurationMs,
      ingestLastRequestStatus: webcamStats.lastRequestStatus,
      ingestLastChunkAt: webcamStats.lastChunkAt,
      containerIngestWriting: metrics.ingestWriting,
      containerIngestWriteAgeMs: metrics.ingestWriteAgeMs,
      containerIngestWriteBytes: metrics.ingestWriteBytes,
      containerLastIngestWriteMs: metrics.lastIngestWriteMs,
      visibility: document.visibilityState,
    })
  }

  function stopProbe(reason = 'manual', preservePlayback = false): Promise<void> {
    if (stopPromise) return stopPromise
    const stopping = performStopProbe(reason, preservePlayback)
    stopPromise = stopping
    const clearStopPromise = () => {
      if (stopPromise === stopping) stopPromise = null
    }
    void stopping.then(clearStopPromise, clearStopPromise)
    return stopping
  }

  async function performStopProbe(reason: string, preservePlayback: boolean): Promise<void> {
    const { result } = await runtime.stop(reason, preservePlayback)
    finishProbeUi()
    if (result && 'error' in result) {
      setStatus(`Probe stopped locally; server stop failed: ${String(result.error)}`, 'warning')
      return
    }
    setStatus('Probe stopped. Download trace to analyze.')
  }

  function finishProbeUi(): void {
    if (dashboardTimer) clearInterval(dashboardTimer)
    if (driftTimer) clearInterval(driftTimer)
    dashboardTimer = null
    driftTimer = null
    probeVideo.removeEventListener('waiting', onVideoWaiting)
    probeVideo.removeEventListener('playing', onVideoPlaying)
    probeVideo.removeEventListener('stalled', onVideoStalled)
    probeVideo.removeEventListener('seeking', onVideoSeeking)
    playbackState = 'idle'
    hasStartedPlaying = false
    lastCurrentTime = 0
    lastCurrentTimeAt = 0
    lastStallStart = 0
    maxBufferScale = 5
    startBtn.disabled = false
    stopBtn.disabled = true
    downloadBtn.disabled = false
    updateDashboard()
  }

  function downloadTrace(): void {
    const exportedEvents = [...trace.events]
    const probeTrace = {
      version: 'streamline-probe-durable-relay-v2',
      exportedAt: new Date().toISOString(),
      durationMs: startTime > 0 ? now() - startTime : 0,
      config: activeProbeConfig,
      summary: {
        totalEvents: trace.totalCount,
        retainedEvents: exportedEvents.length,
        droppedEvents: trace.droppedCount,
        chunkCount,
        byteCount,
        avgChunkSize: chunkCount > 0 ? Math.round(byteCount / chunkCount) : 0,
        avgInterarrivalMs: interarrivalStats.count > 0 ? Math.round(interarrivalStats.mean) : 0,
        jitterMs: interarrivalStats.count > 1 ? Math.round(interarrivalStats.standardDeviation) : 0,
        startupTimeMs: startupTime,
        stallCount,
        recoveryCount,
        gapCount,
        playingCount,
        seekingCount,
        outputConnectionCount,
      },
      events: exportedEvents,
    }
    const blob = new Blob([JSON.stringify(probeTrace, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = root.ownerDocument.createElement('a')
    anchor.href = url
    anchor.download = `streamline-probe-relay-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    root.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  async function testStream(): Promise<void> {
    testStreamController?.abort()
    const controller = new AbortController()
    testStreamController = controller
    testStreamBtn.disabled = true
    const testStartTime = performance.now()
    if (!runtime.active) startTime = testStartTime
    clearLog()
    setStatus('Testing chunked stream...')
    logEvent('test-stream-start')
    let testChunkCount = 0
    let testByteCount = 0
    let previousChunkTime = 0
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, TEST_STREAM_TIMEOUT_MS)

    function processTestStreamLine(line: string): boolean {
      if (!line) return false
      testChunkCount++
      const receivedAt = performance.now()
      const elapsed = receivedAt - testStartTime
      const delta = previousChunkTime > 0 ? receivedAt - previousChunkTime : 0
      previousChunkTime = receivedAt
      const onTime = delta === 0 || (delta >= 300 && delta <= 700)
      const chunkId = line.startsWith('CHUNK-') ? line.split(' ')[0] : line.slice(0, 20)
      logEvent('test-stream-chunk', {
        chunk: chunkId,
        chunkNum: testChunkCount,
        size: line.length,
        elapsedMs: Number(elapsed.toFixed(1)),
        deltaMs: Number(delta.toFixed(1)),
        onTime,
      })
      if (line !== 'done' && !line.startsWith('done')) return false
      logEvent('test-stream-done', {
        totalChunks: testChunkCount,
        totalDuration: Number(elapsed.toFixed(1)),
      })
      setStatus(`Test complete: ${testChunkCount} chunks in ${elapsed.toFixed(0)}ms`, 'success')
      return true
    }

    try {
      const response = await fetch(`${window.location.origin}/test-stream`, { signal: controller.signal })
      if (!response.ok) {
        logEvent('test-stream-error', { status: response.status })
        setStatus(`Test stream failed: HTTP ${response.status}`, 'error')
        return
      }
      if (!response.body) {
        logEvent('test-stream-error', { error: 'no response body' })
        setStatus('Test stream failed: no response body', 'error')
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        testByteCount += value.byteLength
        if (testByteCount > TEST_STREAM_MAX_BYTES) {
          await reader.cancel()
          throw new Error('response exceeds the 1 MiB limit')
        }
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        if (buffer.length > TEST_STREAM_MAX_LINE_CHARACTERS
          || lines.some((line) => line.length > TEST_STREAM_MAX_LINE_CHARACTERS)) {
          await reader.cancel()
          throw new Error('response line exceeds the 64 KiB limit')
        }
        for (const line of lines) {
          if (processTestStreamLine(line)) return
        }
      }
      buffer += decoder.decode()
      if (buffer.length > TEST_STREAM_MAX_LINE_CHARACTERS) throw new Error('response line exceeds the 64 KiB limit')
      if (processTestStreamLine(buffer)) return
      throw new Error('response ended before the done marker')
    } catch (error) {
      if (testStreamController !== controller) return
      logEvent('test-stream-error', { error: String(error) })
      setStatus(timedOut
        ? `Test stream timed out after ${TEST_STREAM_TIMEOUT_MS / 1_000} seconds.`
        : `Test stream error: ${errorMessage(error)}`, 'error')
    } finally {
      clearTimeout(timeout)
      if (testStreamController === controller) {
        testStreamController = null
        testStreamBtn.disabled = false
      }
    }
  }

  startBtn.addEventListener('click', () => void startProbe())
  stopBtn.addEventListener('click', () => {
    void stopProbe('manual').catch((error) => console.error('Stop failed:', error))
  })
  testStreamBtn.addEventListener('click', () => void testStream())
  clearBtn.addEventListener('click', clearLog)
  downloadBtn.addEventListener('click', downloadTrace)
  window.addEventListener('pagehide', () => {
    testStreamController?.abort()
    if (runtime.active || runtime.sessionId) {
      void stopProbe('pagehide').catch((error) => console.error('Pagehide stop failed:', error))
    }
  })
}

function requiredElement<T extends HTMLElement>(root: ParentNode, id: string): T {
  const element = root.querySelector(`#${id}`)
  if (!element) throw new Error(`Probe interface is missing #${id}`)
  return element as T
}

function setText(root: ParentNode, id: string, value: string): void {
  const element = root.querySelector(`#${id}`)
  if (element) element.textContent = value
}

function readBufferedRanges(ranges: TimeRanges): ProbeBufferRange[] {
  const result: ProbeBufferRange[] = []
  for (let index = 0; index < ranges.length; index++) {
    result.push({ start: ranges.start(index), end: ranges.end(index) })
  }
  return result
}

function scaleMilliseconds(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value / 1_000
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
