import { readBodyWithLimit } from './request-body.ts'

const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const MAX_ADMISSION_BYTES = 4 * 1024

export interface PlaygroundAdmissionConfig {
  PLAYGROUND_TURNSTILE_SECRET?: string
  PLAYGROUND_TURNSTILE_HOSTNAMES?: string
  PLAYGROUND_TURNSTILE_ACTION?: string
}

interface TurnstileResponse {
  success?: unknown
  action?: unknown
  hostname?: unknown
}

export function playgroundTurnstileConfig(env: PlaygroundAdmissionConfig): {
  secret: string
  action: string
  hostnames: Set<string>
} | null {
  const secret = env.PLAYGROUND_TURNSTILE_SECRET?.trim() ?? ''
  const action = env.PLAYGROUND_TURNSTILE_ACTION?.trim() ?? ''
  const hostnames = new Set((env.PLAYGROUND_TURNSTILE_HOSTNAMES ?? '').split(',')
    .map((hostname) => hostname.trim().toLowerCase()).filter(Boolean))
  if (!secret || !/^[A-Za-z0-9_-]{1,32}$/.test(action) || hostnames.size === 0) return null
  for (const hostname of hostnames) {
    try {
      if (new URL(`https://${hostname}`).hostname !== hostname || hostname.includes('/')) return null
    } catch {
      return null
    }
  }
  return { secret, action, hostnames }
}

export async function readAdmissionToken(request: Request): Promise<string | null> {
  if (request.headers.get('Content-Type')?.split(';', 1)[0].trim() !== 'application/json') return null
  const bytes = await readBodyWithLimit(request, MAX_ADMISSION_BYTES)
  if (!bytes) return null
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    return Object.keys(record).length === 1 && typeof record.token === 'string'
      && record.token.length > 0 && record.token.length <= 2048 ? record.token : null
  } catch {
    return null
  }
}

export async function verifyPlaygroundAdmission(
  request: Request,
  env: PlaygroundAdmissionConfig,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const config = playgroundTurnstileConfig(env)
  if (!config || token.length > 2048) return false
  const remoteIp = request.headers.get('CF-Connecting-IP')
  try {
    const response = await fetcher(TURNSTILE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        secret: config.secret,
        response: token,
        ...(remoteIp ? { remoteip: remoteIp } : {}),
      }),
    })
    if (!response.ok) return false
    const result = await response.json() as TurnstileResponse
    return result.success === true && result.action === config.action
      && typeof result.hostname === 'string' && config.hostnames.has(result.hostname.toLowerCase())
  } catch {
    return false
  }
}
