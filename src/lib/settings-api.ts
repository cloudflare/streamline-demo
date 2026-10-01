import type { MediaOverrideStatus } from './media-overrides.ts'

const MEDIA_OVERRIDES_ENDPOINT = '/api/media-overrides'
export const SETTINGS_REQUEST_TIMEOUT_MS = 10_000

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export type MediaOverrideField = 'input' | 'output'
export type MediaProfileUpdate = { key: string; liveInputId: string } | null

export class SettingsRequestTimeoutError extends Error {}

interface SettingsApiOptions {
  fetcher?: Fetcher
  timeoutMs?: number
}

export function loadMediaOverrideStatus(options: SettingsApiOptions = {}): Promise<MediaOverrideStatus> {
  return requestMediaOverrides({
    method: 'GET',
    headers: { Accept: 'application/json' },
  }, options)
}

export function updateMediaOverride(
  field: MediaOverrideField,
  value: MediaProfileUpdate,
  options: SettingsApiOptions = {},
): Promise<MediaOverrideStatus> {
  return requestMediaOverrides({
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [field]: value }),
  }, options)
}

async function requestMediaOverrides(
  init: RequestInit,
  { fetcher = fetch, timeoutMs = SETTINGS_REQUEST_TIMEOUT_MS }: SettingsApiOptions,
): Promise<MediaOverrideStatus> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetcher(MEDIA_OVERRIDES_ENDPOINT, { ...init, signal: controller.signal })
    if (!response.ok) throw new Error(await response.text() || `Request failed (${response.status})`)
    return await response.json() as MediaOverrideStatus
  } catch (error) {
    if (controller.signal.aborted) throw new SettingsRequestTimeoutError('Settings request timed out.')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
