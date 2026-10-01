export const STREAMLINE_SETTINGS_KEY = 'streamlineSettings'
export const BUFFER_PRIMING_MIN = 0.5
export const BUFFER_PRIMING_MAX = 10
export const OUTPUT_RESOLUTIONS = ['1920x1080', '1280x720', '960x540', '640x360'] as const
export const PROBE_PRESETS = ['passthrough', 'overlay'] as const
export const SOURCE_TYPES = ['webcam', 'stream-hls', 'stream-rtmp'] as const

export type OutputResolution = typeof OUTPUT_RESOLUTIONS[number]
export type ProbePreset = typeof PROBE_PRESETS[number]
export type SourceType = typeof SOURCE_TYPES[number]

export interface StreamlineSettings {
  previewMode?: boolean
  sourceType?: SourceType
  videoId?: string
  outputResolution?: OutputResolution
  bufferPriming?: number
  probePreset?: ProbePreset
}

export interface DisplaySettings {
  previewMode: boolean
  sourceType: SourceType
  videoId: string
  outputResolution: OutputResolution
  bufferPriming: number
}

interface ReadableSettingsStorage {
  getItem(key: string): string | null
  setItem?(key: string, value: string): void
}

interface WritableSettingsStorage extends ReadableSettingsStorage {
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const DEFAULT_DISPLAY_SETTINGS: Readonly<DisplaySettings> = {
  previewMode: true,
  sourceType: 'webcam',
  videoId: '',
  outputResolution: '1280x720',
  bufferPriming: 2,
}

export function readStreamlineSettings(
  storage: ReadableSettingsStorage = localStorage,
): StreamlineSettings {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STREAMLINE_SETTINGS_KEY) || '{}')
    if (!isRecord(parsed)) return {}
    const settings = normalizeStreamlineSettings(parsed)
    const serialized = JSON.stringify(settings)
    if (serialized !== JSON.stringify(parsed)) storage.setItem?.(STREAMLINE_SETTINGS_KEY, serialized)
    return settings
  } catch {
    return {}
  }
}

export function normalizeStreamlineSettings(value: unknown): StreamlineSettings {
  if (!isRecord(value)) return {}

  const settings: StreamlineSettings = {}
  if (typeof value.previewMode === 'boolean') settings.previewMode = value.previewMode

  const sourceType = normalizeSourceType(value.sourceType)
  if (sourceType) settings.sourceType = sourceType

  if (typeof value.videoId === 'string') settings.videoId = value.videoId.trim()

  if (isIncluded(OUTPUT_RESOLUTIONS, value.outputResolution)) {
    settings.outputResolution = value.outputResolution
  }

  if (typeof value.bufferPriming === 'number' && Number.isFinite(value.bufferPriming)) {
    settings.bufferPriming = Math.min(BUFFER_PRIMING_MAX, Math.max(BUFFER_PRIMING_MIN, value.bufferPriming))
  }

  if (isIncluded(PROBE_PRESETS, value.probePreset)) settings.probePreset = value.probePreset
  return settings
}

export function normalizeDisplaySettings(value: unknown): DisplaySettings {
  const settings = normalizeStreamlineSettings(value)
  return {
    previewMode: settings.previewMode ?? DEFAULT_DISPLAY_SETTINGS.previewMode,
    sourceType: settings.sourceType ?? DEFAULT_DISPLAY_SETTINGS.sourceType,
    videoId: settings.videoId ?? DEFAULT_DISPLAY_SETTINGS.videoId,
    outputResolution: settings.outputResolution ?? DEFAULT_DISPLAY_SETTINGS.outputResolution,
    bufferPriming: settings.bufferPriming ?? DEFAULT_DISPLAY_SETTINGS.bufferPriming,
  }
}

export function readDisplaySettings(
  storage: ReadableSettingsStorage = localStorage,
): DisplaySettings {
  return normalizeDisplaySettings(readStreamlineSettings(storage))
}

export function writeDisplaySettings(
  settings: DisplaySettings,
  storage: Pick<WritableSettingsStorage, 'getItem' | 'setItem'> = localStorage,
): void {
  const existing = readStreamlineSettings(storage)
  storage.setItem(STREAMLINE_SETTINGS_KEY, JSON.stringify(normalizeStreamlineSettings({
    ...existing,
    ...settings,
  })))
}

export function clearDisplaySettings(
  storage: Pick<WritableSettingsStorage, 'removeItem'> = localStorage,
): void {
  storage.removeItem(STREAMLINE_SETTINGS_KEY)
}

function normalizeSourceType(value: unknown): SourceType | undefined {
  if (value === 'stream') return 'stream-hls'
  return isIncluded(SOURCE_TYPES, value) ? value : undefined
}

function isIncluded<const Values extends readonly unknown[]>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return values.includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
