import type { StreamlineSettings } from './settings-storage.ts'
import type { StreamOperation } from './stream-protocol.ts'

export {
  readStreamlineSettings,
  type StreamlineSettings,
} from './settings-storage.ts'
export type { StreamOperation } from './stream-protocol.ts'

const encodePreset = 'fast' as const
const outputBitrate = '1500k'

export interface FilterValues {
  blur: number
  brightness: number
  contrast: number
  saturation: number
  gamma: number
  sharpen: number
  flip: boolean
  rotate: number
}

export type StreamSessionSource =
  | { kind: 'webcam'; url: null; validationError: null }
  | { kind: 'hls'; url: string | null; validationError: string | null }
  | { kind: 'rtmp'; profile: 'default'; validationError: null }

export type ProbeSource = StreamSessionSource

export type StreamSessionOutput =
  | { mode: 'websocket'; format: 'fmp4'; validationError: null }
  | { mode: 'rtmp'; profile: 'default'; validationError: null }

export interface CoreSessionOptions {
  preset: string
  annotationEnabled: boolean
  filters?: Partial<FilterValues>
  burnSubtitles?: boolean
}

export interface StreamSessionPlan {
  source: StreamSessionSource
  output: StreamSessionOutput
  pipeline: StreamOperation[]
  preset: string
  outputResolution: string
  outputMime: string
  inputs: StreamSessionCompositeInputs | null
  webcamIngest: boolean
}

export type StreamSessionInput =
  | { type: 'webcam' }
  | { type: 'hls'; url: string }
  | { type: 'rtmp'; profile: 'default' }

export type StreamSessionDirectInput = Exclude<StreamSessionInput, { type: 'webcam' }>

export interface StreamSessionInputTransform {
  scale: number
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
}

export type StreamSessionCompositeInputs = [
  StreamSessionDirectInput,
  { type: 'webcam'; transform: StreamSessionInputTransform },
]

interface StreamSessionRequestBase {
  pipeline: StreamOperation[]
  output:
    | { mode: 'websocket'; format: 'fmp4' }
    | { mode: 'rtmp'; profile: 'default' }
  session_id: string | null
}

export type StreamSessionRequest = StreamSessionRequestBase & (
  | { input: StreamSessionInput; inputs?: never }
  | { input?: never; inputs: StreamSessionCompositeInputs }
)

export interface StreamSessionStartSubtitleMetadata {
  state: 'ready' | 'unavailable' | string
  language?: string
  cueCount?: number
  warning?: string
}

export type StreamSessionStartOutputMetadata =
  | { mode: 'websocket'; format: 'fmp4' }
  | { mode: 'rtmp'; format?: never }

export interface StreamSessionStartResponse {
  status: 'started'
  mode: 'webcam' | 'direct' | 'test'
  output: StreamSessionStartOutputMetadata
  subtitle?: StreamSessionStartSubtitleMetadata
}

export function parseStreamSessionStartResponse(
  value: unknown,
  expectedOutputMode: StreamSessionStartOutputMetadata['mode'],
): StreamSessionStartResponse {
  if (!isStreamSessionStartResponse(value)) {
    throw new Error('Container start returned an invalid response')
  }
  if (value.output.mode !== expectedOutputMode) {
    throw new Error(`Container started unexpected ${value.output.mode} output`)
  }
  return value
}

function isStreamSessionStartResponse(value: unknown): value is StreamSessionStartResponse {
  if (!isRecord(value)
    || value.status !== 'started'
    || (value.mode !== 'webcam' && value.mode !== 'direct' && value.mode !== 'test')
    || !isRecord(value.output)) {
    return false
  }
  if (value.output.mode === 'websocket') {
    if (value.output.format !== 'fmp4') return false
  } else if (value.output.mode !== 'rtmp' || Object.hasOwn(value.output, 'format')) {
    return false
  }
  if (!Object.hasOwn(value, 'subtitle')) return true
  if (!isRecord(value.subtitle) || typeof value.subtitle.state !== 'string') return false
  if (Object.hasOwn(value.subtitle, 'language') && typeof value.subtitle.language !== 'string') return false
  if (Object.hasOwn(value.subtitle, 'warning') && typeof value.subtitle.warning !== 'string') return false
  return !Object.hasOwn(value.subtitle, 'cueCount')
    || (typeof value.subtitle.cueCount === 'number'
      && Number.isInteger(value.subtitle.cueCount)
      && value.subtitle.cueCount >= 0)
}

export interface ProbeTraceConfig {
  sourceType: string
  probePreset: string
  outputResolution: string
  outputBitrate: string
  encodePreset: typeof encodePreset
  annotationEnabled: boolean
  bufferPrimingSeconds: number
  diagnostics: true
}

export interface ProbeSessionPlan {
  source: ProbeSource
  pipeline: StreamOperation[]
  preset: string
  outputResolution: string
  outputMime: string
  traceConfig: ProbeTraceConfig
}

export interface ProbeStartRequest {
  input: StreamSessionInput
  pipeline: StreamOperation[]
  output: { mode: 'websocket'; format: 'fmp4' }
  session_id: string | null
  diagnostics: true
}

export function buildCoreSessionPlan(
  settings: StreamlineSettings,
  options: CoreSessionOptions,
): StreamSessionPlan {
  const pipMode = options.preset === 'pip'
  const source = resolveStreamSessionSource(settings)
  const output = resolveStreamSessionOutput(settings)
  const outputResolution = settings.outputResolution || '1280x720'
  const pipeline: StreamOperation[] = []

  if (options.annotationEnabled) {
    pipeline.push({
      op: 'overlay',
      params: { image: 'annotation', position: 'full' },
    })
  } else if (options.preset === 'overlay') {
    pipeline.push({
      op: 'overlay',
      params: {
        image: '/app/assets/streamline-logo.png',
        position: 'top-right',
      },
    })
  }

  if (options.filters) appendFilters(pipeline, options.filters)
  if (options.burnSubtitles) {
    pipeline.push({ op: 'subtitle', params: { source: 'auto' } })
  }

  pipeline.push(buildEncodeOperation(outputResolution, source.kind === 'webcam' || pipMode))

  const videoCodec = outputResolution === '1920x1080' ? 'avc1.42C028' : 'avc1.42C01F'
  const outputMime = source.kind === 'hls' && !options.annotationEnabled
    ? `video/mp4; codecs="${videoCodec},mp4a.40.2"`
    : `video/mp4; codecs="${videoCodec}"`

  return {
    source,
    output,
    pipeline,
    preset: options.preset,
    outputResolution,
    outputMime,
    inputs: pipMode
      ? [
          buildStreamSessionDirectInput(source),
          { type: 'webcam', transform: { scale: 0.25, position: 'top-right' } },
        ]
      : null,
    webcamIngest: source.kind === 'webcam' || pipMode,
  }
}

export function buildCoreStartRequest(
  plan: StreamSessionPlan,
  sessionId: string | null = null,
): StreamSessionRequest {
  if (plan.source.validationError) throw new Error(plan.source.validationError)
  if (plan.output.validationError) throw new Error(plan.output.validationError)

  let output: StreamSessionRequest['output']
  if (plan.output.mode === 'websocket') {
    output = { mode: 'websocket', format: 'fmp4' }
  } else {
    output = { mode: 'rtmp', profile: plan.output.profile }
  }
  const request = {
    pipeline: plan.pipeline,
    output,
    session_id: sessionId,
  }
  if (plan.inputs) return { ...request, inputs: plan.inputs }
  return { ...request, input: buildStreamSessionInput(plan.source) }
}

export function buildProbeSessionPlan(
  settings: StreamlineSettings,
  annotationEnabled: boolean,
): ProbeSessionPlan {
  const source = resolveStreamSessionSource(settings)
  const preset = settings.probePreset || 'passthrough'
  const outputResolution = settings.outputResolution || '1280x720'
  const pipeline: StreamOperation[] = []

  if (preset === 'overlay') {
    pipeline.push({
      op: 'overlay',
      params: {
        image: '/app/assets/streamline-logo.png',
        position: 'top-right',
      },
    })
  }

  if (annotationEnabled) {
    pipeline.push({
      op: 'overlay',
      params: { image: 'annotation', position: 'full' },
    })
  }

  pipeline.push(buildEncodeOperation(outputResolution, source.kind === 'webcam'))

  const videoCodec = outputResolution === '1920x1080' ? 'avc1.42C028' : 'avc1.42C01F'
  const outputMime = source.kind === 'hls' && !annotationEnabled
    ? `video/mp4; codecs="${videoCodec},mp4a.40.2"`
    : `video/mp4; codecs="${videoCodec}"`

  return {
    source,
    pipeline,
    preset,
    outputResolution,
    outputMime,
    traceConfig: {
      sourceType: settings.sourceType || 'webcam',
      probePreset: preset,
      outputResolution,
      outputBitrate,
      encodePreset,
      annotationEnabled,
      bufferPrimingSeconds: settings.bufferPriming ?? 2,
      diagnostics: true,
    },
  }
}

export function buildProbeStartRequest(
  plan: ProbeSessionPlan,
  sessionId: string | null,
): ProbeStartRequest {
  return {
    input: buildStreamSessionInput(plan.source),
    pipeline: plan.pipeline,
    output: { mode: 'websocket', format: 'fmp4' },
    session_id: sessionId,
    diagnostics: true,
  }
}

function buildEncodeOperation(outputResolution: string, fixedFrameRate: boolean): StreamOperation {
  return {
    op: 'encode',
    params: {
      codec: 'h264',
      preset: encodePreset,
      bitrate: outputBitrate,
      resolution: outputResolution,
      ...(fixedFrameRate ? { fps: 30 } : {}),
    },
  }
}

function buildStreamSessionInput(source: StreamSessionSource): StreamSessionInput {
  if (source.validationError) throw new Error(source.validationError)
  if (source.kind === 'webcam') return { type: 'webcam' }
  if (source.kind === 'rtmp') return { type: 'rtmp', profile: source.profile }
  if (!source.url) throw new Error('Stream input URL is required')
  return { type: 'hls', url: source.url }
}

function buildStreamSessionDirectInput(source: StreamSessionSource): StreamSessionDirectInput {
  const input = buildStreamSessionInput(source)
  if (input.type === 'webcam') throw new Error('Picture-in-picture requires an HLS or RTMP input')
  return input
}

export function resolveStreamSessionSource(settings: StreamlineSettings): StreamSessionSource {
  if (settings.sourceType === 'stream-hls') {
    const videoId = settings.videoId || ''
    return {
      kind: 'hls',
      url: videoId ? `https://videodelivery.net/${videoId}/manifest/video.m3u8` : null,
      validationError: videoId ? null : 'No Stream Video ID configured. Go to Settings.',
    }
  }

  if (settings.sourceType === 'stream-rtmp') {
    return { kind: 'rtmp', profile: 'default', validationError: null }
  }

  return { kind: 'webcam', url: null, validationError: null }
}

export function resolveStreamSessionOutput(settings: StreamlineSettings): StreamSessionOutput {
  if (settings.previewMode ?? true) {
    return { mode: 'websocket', format: 'fmp4', validationError: null }
  }

  return { mode: 'rtmp', profile: 'default', validationError: null }
}

function appendFilters(pipeline: StreamOperation[], filters: Partial<FilterValues>): void {
  const blur = filters.blur ?? 0
  if (blur > 0) {
    pipeline.push({ op: 'filter', params: { preset: 'blur', amount: blur } })
  }
  const brightness = filters.brightness ?? 0
  if (brightness !== 0) {
    pipeline.push({ op: 'filter', params: { preset: 'brightness', amount: brightness } })
  }
  const contrast = filters.contrast ?? 1
  if (contrast !== 1) {
    pipeline.push({ op: 'filter', params: { preset: 'contrast', amount: contrast } })
  }
  const saturation = filters.saturation ?? 1
  if (saturation !== 1) {
    pipeline.push({ op: 'filter', params: { preset: 'saturation', amount: saturation } })
  }
  const gamma = filters.gamma ?? 1
  if (gamma !== 1) {
    pipeline.push({ op: 'filter', params: { preset: 'gamma', amount: gamma } })
  }
  const sharpen = filters.sharpen ?? 0
  if (sharpen > 0) {
    pipeline.push({ op: 'filter', params: { preset: 'sharpen', amount: sharpen } })
  }
  if (filters.flip) pipeline.push({ op: 'filter', params: { preset: 'flip' } })
  const rotate = filters.rotate ?? 0
  if (rotate === 90 || rotate === 180 || rotate === 270) {
    pipeline.push({ op: 'filter', params: { preset: 'rotate', degrees: rotate } })
  } else if (rotate !== 0) {
    throw new Error('Rotate filter must be 0, 90, 180, or 270 degrees')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
