import {
  deriveStreamPlaybackUrls,
  MediaPolicyError,
  validateStreamRtmpProfile,
} from './media-policy.ts'
import { readBodyWithLimit } from './request-body.ts'

const LEGACY_MEDIA_OVERRIDES_KEY = 'media-overrides'
export const MEDIA_OVERRIDES_KEY = 'media-overrides-v2'
export const MAX_MEDIA_OVERRIDE_BYTES = 4 * 1024

export interface MediaProfileEnvironment {
  MEDIA_RTMP_INPUT_PROFILE?: string
  MEDIA_RTMP_OUTPUT_PROFILE?: string
}

export interface MediaProfileOverride {
  key: string
  liveInputId: string
  updatedAt: number
}

export interface MediaOverrides {
  input?: MediaProfileOverride
  output?: MediaProfileOverride
}

export interface MediaOverrideFieldStatus {
  source: 'override' | 'default' | 'missing'
  valid: boolean
  updatedAt?: number
  hlsUrl?: string
  playerUrl?: string
}

export interface MediaOverrideStatus {
  writable: boolean
  input: MediaOverrideFieldStatus
  output: MediaOverrideFieldStatus
}

interface MediaOverrideStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function updateMediaOverrides(
  current: MediaOverrides,
  value: unknown,
  now = Date.now(),
): MediaOverrides {
  if (!isRecord(value)) throw new MediaPolicyError('Media overrides must be an object')
  const keys = Object.keys(value)
  if (keys.length === 0 || keys.some((key) => key !== 'input' && key !== 'output')) {
    throw new MediaPolicyError('Specify input or output')
  }

  const next = { ...current }
  applyProfileUpdate(next, value, 'input', 'RTMP input', now)
  applyProfileUpdate(next, value, 'output', 'RTMP output', now)
  return next
}

export function resolveMediaProfileEnvironment<T extends MediaProfileEnvironment>(
  env: T,
  overrides: MediaOverrides,
): T {
  return {
    ...env,
    ...(Object.hasOwn(overrides, 'input') ? {
      MEDIA_RTMP_INPUT_PROFILE: serializeOverride(overrides.input),
    } : {}),
    ...(Object.hasOwn(overrides, 'output') ? {
      MEDIA_RTMP_OUTPUT_PROFILE: serializeOverride(overrides.output),
    } : {}),
  }
}

export function mediaOverrideStatus(
  overrides: MediaOverrides,
  env: MediaProfileEnvironment,
  writable = true,
): MediaOverrideStatus {
  return {
    writable,
    input: fieldStatus(
      overrides,
      'input',
      env.MEDIA_RTMP_INPUT_PROFILE,
      'RTMP input',
    ),
    output: fieldStatus(
      overrides,
      'output',
      env.MEDIA_RTMP_OUTPUT_PROFILE,
      'RTMP output',
    ),
  }
}

export function hasMediaOverrides(overrides: MediaOverrides): boolean {
  return Boolean(overrides.input || overrides.output)
}

export async function readMediaOverrides(storage: MediaOverrideStorage): Promise<MediaOverrides> {
  const [overrides] = await Promise.all([
    storage.get<MediaOverrides>(MEDIA_OVERRIDES_KEY),
    storage.delete(LEGACY_MEDIA_OVERRIDES_KEY),
  ])
  return overrides ?? {}
}

export async function prepareMediaOverrideRequest(request: Request): Promise<Request | Response> {
  const url = new URL(request.url)
  if (request.method !== 'GET' && request.method !== 'PUT') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, PUT' } })
  }
  if (request.method === 'GET') {
    return request.body
      ? new Response('Media override status does not accept a body', { status: 400 })
      : request
  }
  if (request.headers.get('Origin') !== url.origin) {
    return new Response('Origin not allowed', { status: 403 })
  }
  if (request.headers.get('Content-Type')?.split(';', 1)[0].trim() !== 'application/json') {
    return new Response('Content-Type must be application/json', { status: 415 })
  }
  const body = await readBodyWithLimit(request, MAX_MEDIA_OVERRIDE_BYTES)
  if (!body) return new Response('Media overrides exceed the 4KiB limit', { status: 413 })
  return new Request(request, { body })
}

export async function handleMediaOverrideRequest(
  request: Request,
  env: MediaProfileEnvironment,
  storage: MediaOverrideStorage,
): Promise<Response> {
  if (!request.headers.get('X-Streamline-Principal')) return new Response('Unauthorized', { status: 401 })
  const current = await readMediaOverrides(storage)
  if (request.method === 'GET') {
    if (request.body) return new Response('Media override status does not accept a body', { status: 400 })
    return Response.json(mediaOverrideStatus(current, env), {
      headers: { 'Cache-Control': 'no-store' },
    })
  }
  if (request.method !== 'PUT') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, PUT' } })
  }
  if (request.headers.get('Content-Type')?.split(';', 1)[0].trim() !== 'application/json') {
    return new Response('Content-Type must be application/json', { status: 415 })
  }
  const bytes = await readBodyWithLimit(request, MAX_MEDIA_OVERRIDE_BYTES)
  if (!bytes) return new Response('Media overrides exceed the 4KiB limit', { status: 413 })
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return new Response('Media overrides must contain valid JSON', { status: 400 })
  }
  let next: MediaOverrides
  try {
    next = updateMediaOverrides(current, value)
  } catch (error) {
    if (error instanceof MediaPolicyError) return new Response(error.message, { status: error.status })
    throw error
  }
  if (hasMediaOverrides(next)) await storage.put(MEDIA_OVERRIDES_KEY, next)
  else await storage.delete(MEDIA_OVERRIDES_KEY)
  return Response.json(mediaOverrideStatus(next, env), {
    headers: { 'Cache-Control': 'no-store' },
  })
}

function applyProfileUpdate(
  target: MediaOverrides,
  value: Record<string, unknown>,
  key: 'input' | 'output',
  label: string,
  now: number,
): void {
  if (!Object.hasOwn(value, key)) return
  const requested = value[key]
  if (requested === null) {
    delete target[key]
    return
  }
  const { key: streamKey, liveInputId } = validateStreamRtmpProfile(requested, `${label} override`, 400)
  target[key] = { key: streamKey, liveInputId, updatedAt: now }
}

function fieldStatus(
  overrides: MediaOverrides,
  key: 'input' | 'output',
  fallback: string | undefined,
  label: string,
): MediaOverrideFieldStatus {
  const hasOverride = Object.hasOwn(overrides, key)
  const override = overrides[key]
  const source = hasOverride ? 'override' : fallback ? 'default' : 'missing'
  const value = hasOverride
    ? { key: override?.key, liveInputId: override?.liveInputId }
    : fallback
  if (!value) return { source, valid: false }
  try {
    const profile = validateStreamRtmpProfile(value, label)
    const urls = deriveStreamPlaybackUrls(profile.liveInputId, label)
    return {
      source,
      valid: true,
      ...(hasOverride && override?.updatedAt ? { updatedAt: override.updatedAt } : {}),
      ...(key === 'input' ? { hlsUrl: urls.hlsUrl } : { playerUrl: urls.playerUrl }),
    }
  } catch {
    return {
      source,
      valid: false,
      ...(hasOverride && override?.updatedAt ? { updatedAt: override.updatedAt } : {}),
    }
  }
}

function serializeOverride(override: MediaProfileOverride | undefined): string | undefined {
  return override ? JSON.stringify({ key: override.key, liveInputId: override.liveInputId }) : undefined
}
