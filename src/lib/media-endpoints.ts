export interface BrowserMediaEndpoints {
  inputHlsUrl?: string
  outputPlayerUrl?: string
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export async function fetchMediaEndpoints(
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
  fetchImpl: FetchLike = fetch,
): Promise<BrowserMediaEndpoints> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timeout = setTimeout(abort, options.timeoutMs ?? 5_000)
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) controller.abort()
  try {
    const response = await fetchImpl('/api/media-overrides', {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Media profile request failed (${response.status})`)
    const value: unknown = await response.json()
    if (!isRecord(value) || !isRecord(value.input) || !isRecord(value.output)) {
      throw new Error('Media profile response is invalid')
    }
    return presentationUrls(value)
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}

function presentationUrls(value: Record<string, unknown>): BrowserMediaEndpoints {
  const input = value.input as Record<string, unknown>
  const output = value.output as Record<string, unknown>
  return {
    ...(typeof input.hlsUrl === 'string'
      ? { inputHlsUrl: requireStreamUrl(input.hlsUrl, 'hls') }
      : {}),
    ...(typeof output.playerUrl === 'string'
      ? { outputPlayerUrl: requireStreamUrl(output.playerUrl, 'player') }
      : {}),
  }
}

function requireStreamUrl(value: string, type: 'hls' | 'player'): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Media profile response contains an invalid Stream URL')
  }
  if (
    url.protocol !== 'https:'
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash
    || !(type === 'hls'
      ? url.hostname === 'videodelivery.net'
        && /^\/[a-f0-9]{32}\/manifest\/video\.m3u8$/.test(url.pathname)
      : url.hostname === 'iframe.videodelivery.net'
        && /^\/[a-f0-9]{32}$/.test(url.pathname))
  ) {
    throw new Error('Media profile response contains an invalid Stream URL')
  }
  return url.toString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
