import type { DeploymentProfile } from './deployment-profile'
import type { StreamOperation } from './stream-protocol'

interface MediaPolicyEnv {
  MEDIA_PROFILE_ID?: string
  MEDIA_RTMP_INPUT_PROFILE?: string
  MEDIA_RTMP_OUTPUT_PROFILE?: string
  PUBLISHER_ACCESS_CLIENT_ID?: string
  PUBLISHER_ACCESS_CLIENT_SECRET?: string
  PUBLISHER_ACCESS_REQUIRED?: string
}

export interface StreamPlaybackUrls {
  hlsUrl: string
  playerUrl: string
}

export interface StreamRtmpProfile {
  key: string
  liveInputId: string
}

export class MediaPolicyError extends Error {
  readonly status: number

  constructor(
    message: string,
    status = 400,
  ) {
    super(message)
    this.status = status
  }
}

export interface PublisherAccessCredentials {
  client_id: string
  client_secret: string
}

export function publisherAccessCredentials(env: MediaPolicyEnv): PublisherAccessCredentials | undefined {
  const clientId = env.PUBLISHER_ACCESS_CLIENT_ID?.trim() || ''
  const clientSecret = env.PUBLISHER_ACCESS_CLIENT_SECRET?.trim() || ''
  if (clientId && clientSecret) return { client_id: clientId, client_secret: clientSecret }
  if (clientId || clientSecret || env.PUBLISHER_ACCESS_REQUIRED === 'true') {
    throw new MediaPolicyError('Publisher Access service credentials are not configured', 503)
  }
  return undefined
}

export function applyStartPolicy(
  body: Record<string, unknown>,
  env: MediaPolicyEnv,
  profile: DeploymentProfile,
): Record<string, unknown> {
  const profileId = env.MEDIA_PROFILE_ID || 'default'
  const resolvedInputs = resolveStartInputs(body, env, profileId)
  const output = asRecord(body.output, 'output')
  const pipeline = validatePipeline(body.pipeline, profile)

  let resolvedOutput: Record<string, unknown>
  if (output.mode === 'websocket') {
    resolvedOutput = { mode: 'websocket', format: 'fmp4' }
  } else if (output.mode === 'rtmp') {
    requireProfile(output.profile, profileId, 'output')
    const rtmpProfile = validateStreamRtmpProfile(env.MEDIA_RTMP_OUTPUT_PROFILE, 'RTMP output')
    resolvedOutput = {
      mode: 'rtmp',
      key: rtmpProfile.key,
    }
  } else {
    throw new MediaPolicyError('output.mode must be websocket or rtmp')
  }

  return {
    ...resolvedInputs,
    pipeline,
    output: resolvedOutput,
    session_id: body.session_id,
    diagnostics: false,
  }
}

export function applyLocalStartPolicy(
  body: Record<string, unknown>,
  env: MediaPolicyEnv,
  profile: DeploymentProfile,
): Record<string, unknown> {
  return {
    ...applyStartPolicy(body, env, profile),
    diagnostics: body.diagnostics === true,
  }
}

// Public sessions retain only validated processing operations and fixed preview encoding.
export function applyPlaygroundStartPolicy(body: Record<string, unknown>, profile: DeploymentProfile): Record<string, unknown> {
  const inputs = resolvePlaygroundInputs(body)
  const output = asRecord(body.output, 'output')
  if (output.mode !== 'websocket' || output.format !== 'fmp4') {
    throw new MediaPolicyError('playground output must be WebSocket fMP4')
  }
  return {
    ...inputs,
    pipeline: [...resolvePlaygroundPipeline(body.pipeline), {
      op: 'encode',
      params: {
        codec: 'h264',
        preset: 'fast',
        bitrate: '1500k',
        resolution: `${profile.limits.maxWidth}x${profile.limits.maxHeight}`,
        fps: 30,
      },
    }],
    output: { mode: 'websocket', format: 'fmp4' },
    session_id: body.session_id,
    diagnostics: false,
  }
}

function resolvePlaygroundInputs(body: Record<string, unknown>): { input: Record<string, unknown> } | { inputs: Record<string, unknown>[] } {
  const hasInput = Object.hasOwn(body, 'input')
  const hasInputs = Object.hasOwn(body, 'inputs')
  if (hasInput === hasInputs) throw new MediaPolicyError('exactly one of input or inputs is required')
  if (hasInput) return { input: resolvePlaygroundPrimaryInput(asRecord(body.input, 'input'), 'input') }

  if (!Array.isArray(body.inputs) || body.inputs.length !== 2) {
    throw new MediaPolicyError('playground PiP requires an HLS background and one webcam input')
  }
  const background = asRecord(body.inputs[0], 'inputs[0]')
  const webcam = asRecord(body.inputs[1], 'inputs[1]')
  if (background.type !== 'hls' || webcam.type !== 'webcam') {
    throw new MediaPolicyError('playground PiP requires an HLS background followed by one webcam input')
  }
  if (Object.hasOwn(background, 'transform')) {
    throw new MediaPolicyError('inputs[0].transform is not supported for the background input')
  }
  return {
    inputs: [
      resolvePlaygroundPrimaryInput(background, 'inputs[0]'),
      { type: 'webcam', transform: validateInputTransform(webcam.transform) },
    ],
  }
}

function resolvePlaygroundPrimaryInput(input: Record<string, unknown>, field: string): Record<string, unknown> {
  if (input.type === 'webcam') return { type: 'webcam' }
  if (input.type === 'hls') return { type: 'hls', url: validateStreamHlsURL(input.url) }
  throw new MediaPolicyError(`${field}.type must be webcam or hls in the playground`)
}

function resolvePlaygroundPipeline(value: unknown): StreamOperation[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new MediaPolicyError('playground pipeline must contain between 1 and 16 operations')
  }
  const pipeline: StreamOperation[] = []
  let encodeOperations = 0
  for (const operationValue of value) {
    const operation = asRecord(operationValue, 'playground pipeline operation')
    requireAllowedKeys(operation, ['op', 'params'], 'playground pipeline operation')
    switch (operation.op) {
      case 'overlay':
        pipeline.push(validateOverlayOperation(operation.params))
        break
      case 'filter':
        pipeline.push(validateFilterOperation(operation.params))
        break
      case 'subtitle':
        pipeline.push(validateSubtitleOperation(operation.params ?? {}))
        break
      case 'encode':
        encodeOperations++
        break
      default:
        throw new MediaPolicyError('playground pipeline operation is not supported')
    }
  }
  if (encodeOperations !== 1) throw new MediaPolicyError('playground pipeline must contain exactly one encode operation')
  return pipeline
}

function resolveStartInputs(
  body: Record<string, unknown>,
  env: MediaPolicyEnv,
  profileId: string,
): { input: Record<string, unknown> } | { inputs: Record<string, unknown>[] } {
  const hasInput = Object.hasOwn(body, 'input')
  const hasInputs = Object.hasOwn(body, 'inputs')
  if (hasInput === hasInputs) throw new MediaPolicyError('exactly one of input or inputs is required')

  if (hasInput) {
    return { input: resolvePrimaryInput(asRecord(body.input, 'input'), env, profileId, 'input') }
  }

  if (!Array.isArray(body.inputs) || body.inputs.length !== 2) {
    throw new MediaPolicyError('inputs must contain an HLS or RTMP primary input and one webcam input')
  }
  const primary = asRecord(body.inputs[0], 'inputs[0]')
  const secondary = asRecord(body.inputs[1], 'inputs[1]')
  if ((primary.type !== 'hls' && primary.type !== 'rtmp') || secondary.type !== 'webcam') {
    throw new MediaPolicyError('inputs must contain an HLS or RTMP primary input followed by one webcam input')
  }
  if (Object.hasOwn(primary, 'transform')) {
    throw new MediaPolicyError('inputs[0].transform is not supported for the primary input')
  }
  const transform = validateInputTransform(secondary.transform)
  return {
    inputs: [
      resolvePrimaryInput(primary, env, profileId, 'inputs[0]'),
      { type: 'webcam', transform },
    ],
  }
}

function resolvePrimaryInput(
  input: Record<string, unknown>,
  env: MediaPolicyEnv,
  profileId: string,
  field: string,
): Record<string, unknown> {
  if (input.type === 'webcam') return { type: 'webcam' }
  if (input.type === 'hls') return { type: 'hls', url: validateStreamHlsURL(input.url) }
  if (input.type === 'rtmp') {
    requireProfile(input.profile, profileId, field)
    const rtmpProfile = validateStreamRtmpProfile(env.MEDIA_RTMP_INPUT_PROFILE, 'RTMP input')
    return { type: 'rtmp', key: rtmpProfile.key }
  }
  throw new MediaPolicyError(`${field}.type must be webcam, hls, or rtmp`)
}

function validateInputTransform(value: unknown): { scale: number; position: string } {
  const transform = asRecord(value, 'inputs[1].transform')
  if (typeof transform.scale !== 'number' || !Number.isFinite(transform.scale)
    || transform.scale <= 0 || transform.scale > 1) {
    throw new MediaPolicyError('inputs[1].transform.scale must be between 0 and 1')
  }
  if (!['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(String(transform.position))) {
    throw new MediaPolicyError('inputs[1].transform.position is invalid')
  }
  return { scale: transform.scale, position: String(transform.position) }
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MediaPolicyError(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireProfile(value: unknown, expected: string, field: string): void {
  if (value !== expected) throw new MediaPolicyError(`${field}.profile is not available`)
}

function validateStreamHlsURL(value: unknown): string {
  if (typeof value !== 'string') throw new MediaPolicyError('hls input requires url')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new MediaPolicyError('hls input url is invalid')
  }
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'videodelivery.net'
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash
    || !/^\/[A-Za-z0-9_-]{1,128}\/manifest\/video\.m3u8$/.test(url.pathname)
  ) {
    throw new MediaPolicyError('hls input must be a Cloudflare Stream manifest')
  }
  return url.toString()
}

export function validateStreamRtmpKey(
  value: string | undefined,
  label: string,
  status = 503,
): string {
  const key = value?.trim() || ''
  if (!key || key.length > 2011 || !/^[A-Za-z0-9._~-]+$/.test(key)) {
    throw new MediaPolicyError(`${label} key is not configured or invalid`, status)
  }
  return key
}

export function validateStreamRtmpProfile(
  value: unknown,
  label: string,
  status = 503,
): StreamRtmpProfile {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      throw new MediaPolicyError(`${label} profile is invalid`, status)
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MediaPolicyError(`${label} profile is not configured`, status)
  }
  const profile = value as Record<string, unknown>
  const keys = Object.keys(profile)
  if (
    keys.length !== 2
    || keys.some((key) => key !== 'key' && key !== 'liveInputId')
    || typeof profile.key !== 'string'
    || typeof profile.liveInputId !== 'string'
  ) {
    throw new MediaPolicyError(`${label} profile must contain key and liveInputId`, status)
  }
  const key = validateStreamRtmpKey(profile.key, label, status)
  const liveInputId = requireLiveInputId(profile.liveInputId, label, status)
  return { key, liveInputId }
}

export function deriveStreamPlaybackUrls(
  liveInputId: string | undefined,
  label: string,
  status = 503,
): StreamPlaybackUrls {
  const id = requireLiveInputId(liveInputId, label, status)
  return {
    hlsUrl: `https://videodelivery.net/${id}/manifest/video.m3u8`,
    playerUrl: `https://iframe.videodelivery.net/${id}`,
  }
}

function requireLiveInputId(
  liveInputId: string | undefined,
  label: string,
  status = 503,
): string {
  const id = liveInputId?.trim().toLowerCase() || ''
  if (!/^[a-f0-9]{32}$/.test(id)) {
    throw new MediaPolicyError(`${label} Live Input ID is not configured or invalid`, status)
  }
  return id
}

function validatePipeline(value: unknown, profile: DeploymentProfile): StreamOperation[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new MediaPolicyError('pipeline must contain between 1 and 16 operations')
  }

  let encodeOperations = 0
  const pipeline: StreamOperation[] = []
  for (const operationValue of value) {
    const operation = asRecord(operationValue, 'pipeline operation')
    requireAllowedKeys(operation, ['op', 'params'], 'pipeline operation')
    if (!Object.hasOwn(operation, 'op')) throw new MediaPolicyError('pipeline operation.op is required')
    switch (operation.op) {
      case 'overlay':
        pipeline.push(validateOverlayOperation(operation.params))
        break
      case 'subtitle':
        pipeline.push(validateSubtitleOperation(operation.params ?? {}))
        break
      case 'filter':
        pipeline.push(validateFilterOperation(operation.params))
        break
      case 'encode':
        encodeOperations++
        pipeline.push(validateEncodeOperation(operation.params, profile))
        break
      default:
        throw new MediaPolicyError('pipeline operation is not supported')
    }
  }
  if (encodeOperations !== 1) throw new MediaPolicyError('pipeline must contain exactly one encode operation')
  return pipeline
}

function validateOverlayOperation(value: unknown): Extract<StreamOperation, { op: 'overlay' }> {
  const params = asRecord(value, 'overlay params')
  requireExactKeys(params, ['image', 'position'], 'overlay params')
  if (params.image === '/app/assets/streamline-logo.png' && params.position === 'top-right') {
    return { op: 'overlay', params: { image: params.image, position: params.position } }
  }
  if (params.image === 'annotation' && params.position === 'full') {
    return { op: 'overlay', params: { image: params.image, position: params.position } }
  }
  throw new MediaPolicyError('overlay must use the fixed logo or annotation placement')
}

function validateSubtitleOperation(value: unknown): Extract<StreamOperation, { op: 'subtitle' }> {
  const params = asRecord(value, 'subtitle params')
  requireAllowedKeys(params, ['source'], 'subtitle params')
  if (params.source !== undefined && params.source !== 'auto') {
    throw new MediaPolicyError('subtitle source must be auto')
  }
  return { op: 'subtitle', params: { source: 'auto' } }
}

function validateFilterOperation(value: unknown): Extract<StreamOperation, { op: 'filter' }> {
  const params = asRecord(value, 'filter params')
  if (params.preset === 'flip') {
    requireExactKeys(params, ['preset'], 'flip filter params')
    return { op: 'filter', params: { preset: 'flip' } }
  }
  if (params.preset === 'rotate') {
    requireExactKeys(params, ['preset', 'degrees'], 'rotate filter params')
    if (params.degrees !== 0 && params.degrees !== 90 && params.degrees !== 180 && params.degrees !== 270) {
      throw new MediaPolicyError('rotate filter degrees must be 0, 90, 180, or 270')
    }
    return { op: 'filter', params: { preset: 'rotate', degrees: params.degrees } }
  }

  const ranges: Record<string, readonly [number, number]> = {
    blur: [0, 10],
    brightness: [-1, 1],
    contrast: [0, 2],
    gamma: [0.1, 3],
    saturation: [0, 2],
    sharpen: [0, 5],
  }
  if (typeof params.preset !== 'string' || !Object.hasOwn(ranges, params.preset)) {
    throw new MediaPolicyError('filter preset is not supported')
  }
  requireExactKeys(params, ['preset', 'amount'], `${params.preset} filter params`)
  const [minimum, maximum] = ranges[params.preset]
  if (typeof params.amount !== 'number' || !Number.isFinite(params.amount)
    || params.amount < minimum || params.amount > maximum) {
    throw new MediaPolicyError(`${params.preset} filter amount must be between ${minimum} and ${maximum}`)
  }
  const preset = params.preset as 'blur' | 'brightness' | 'contrast' | 'gamma' | 'saturation' | 'sharpen'
  return { op: 'filter', params: { preset, amount: params.amount } }
}

function validateEncodeOperation(
  value: unknown,
  profile: DeploymentProfile,
): Extract<StreamOperation, { op: 'encode' }> {
  const params = asRecord(value, 'encode params')
  requireAllowedKeys(params, ['codec', 'preset', 'bitrate', 'resolution', 'fps', 'gop'], 'encode params')
  if (params.codec !== 'h264') throw new MediaPolicyError('owner profile supports only H.264 encoding')

  const resolved: Extract<StreamOperation, { op: 'encode' }>['params'] = { codec: 'h264' }
  if (Object.hasOwn(params, 'preset')) {
    if (typeof params.preset !== 'string'
      || !['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'].includes(params.preset)) {
      throw new MediaPolicyError('encode preset exceeds the owner resource profile')
    }
    resolved.preset = params.preset as NonNullable<typeof resolved.preset>
  }
  if (Object.hasOwn(params, 'resolution')) {
    if (typeof params.resolution !== 'string') throw new MediaPolicyError('encode resolution is invalid')
    validateResolution(params.resolution, profile)
    resolved.resolution = params.resolution
  }
  if (Object.hasOwn(params, 'fps')) {
    if (typeof params.fps !== 'number' || !Number.isInteger(params.fps)
      || params.fps < 1 || params.fps > profile.limits.maxFps) {
      throw new MediaPolicyError(`encode fps exceeds ${profile.limits.maxFps}`)
    }
    resolved.fps = params.fps
  }
  if (Object.hasOwn(params, 'bitrate')) {
    if (typeof params.bitrate !== 'string') throw new MediaPolicyError('encode bitrate is invalid')
    if (parseBitrate(params.bitrate) > profile.limits.maxBitrateBps) {
      throw new MediaPolicyError(`encode bitrate exceeds ${profile.limits.maxBitrateBps} bps`)
    }
    resolved.bitrate = params.bitrate
  }
  if (Object.hasOwn(params, 'gop')) {
    if (typeof params.gop !== 'number' || !Number.isInteger(params.gop) || params.gop < 1 || params.gop > 10_000) {
      throw new MediaPolicyError('encode gop must be an integer between 1 and 10000')
    }
    resolved.gop = params.gop
  }
  return { op: 'encode', params: resolved }
}

function requireExactKeys(value: Record<string, unknown>, expected: string[], field: string): void {
  requireAllowedKeys(value, expected, field)
  const missing = expected.find((key) => !Object.hasOwn(value, key))
  if (missing) throw new MediaPolicyError(`${field}.${missing} is required`)
}

function requireAllowedKeys(value: Record<string, unknown>, allowed: string[], field: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown) throw new MediaPolicyError(`${field}.${unknown} is not supported`)
}

function validateResolution(value: string, profile: DeploymentProfile): void {
  const match = /^(\d+)x(\d+)$/.exec(value)
  const width = Number(match?.[1])
  const height = Number(match?.[2])
  if (!match || width < 2 || height < 2 || width % 2 || height % 2
    || width > profile.limits.maxWidth || height > profile.limits.maxHeight) {
    throw new MediaPolicyError(`encode resolution exceeds ${profile.limits.maxWidth}x${profile.limits.maxHeight}`)
  }
}

function parseBitrate(value: string): number {
  const match = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(value)
  if (!match) throw new MediaPolicyError('encode bitrate is invalid')
  const multiplier = match[2].toLowerCase() === 'm' ? 1_000_000 : match[2] ? 1_000 : 1
  const bitrate = Number(match[1]) * multiplier
  if (!Number.isFinite(bitrate) || bitrate <= 0) throw new MediaPolicyError('encode bitrate is invalid')
  return bitrate
}
