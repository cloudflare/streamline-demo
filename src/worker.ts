import {
  ContainerProxy,
  MAX_ANNOTATION_BYTES,
  MAX_INGEST_BYTES,
  MAX_START_BYTES,
  StreamlineSessionDO,
  type ResolvedSessionStart,
  type StreamlineRelaySession,
} from '@cloudflare/streamline'
import astro from '@astrojs/cloudflare/entrypoints/server'
import {
  authenticateAccessRequest,
  toInternalContainerRequest,
  withoutAccessServiceCredentials,
  withTrustedPrincipal,
} from './lib/access-auth'
import { getMediaContainer, selectMediaContainerRoute } from './lib/container-proxy'
import { getDeploymentProfile, rejectDisabledDeployment } from './lib/deployment-profile'
import {
  handleMediaOverrideRequest,
  prepareMediaOverrideRequest,
  readMediaOverrides,
  resolveMediaProfileEnvironment,
} from './lib/media-overrides'
import { applyPlaygroundStartPolicy, applyStartPolicy, MediaPolicyError, publisherAccessCredentials } from './lib/media-policy'
import { createAnonymousPrincipalCookie, hashAnonymousSubject, readAnonymousPrincipal } from './lib/anonymous-principal'
import { PlaygroundCoordinator, type AdmissionDecision } from './lib/playground-coordinator'
import { playgroundTurnstileConfig, readAdmissionToken, verifyPlaygroundAdmission } from './lib/playground-admission'
import { isUnsupportedPlaygroundPage } from './lib/playground-pages'
import { normalizeEmptyRequestBody, readBodyWithLimit } from './lib/request-body'
import { withSecurityHeaders } from './lib/security-headers'
import { deploymentRelayHosts } from './generated/deployment-hosts'

interface WorkerEnv extends Env {
  MEDIA_RTMP_INPUT_PROFILE?: string
  MEDIA_RTMP_OUTPUT_PROFILE?: string
  PUBLISHER_ACCESS_CLIENT_ID?: string
  PUBLISHER_ACCESS_CLIENT_SECRET?: string
  PLAYGROUND_PRINCIPAL_SECRET?: string
  PLAYGROUND_TURNSTILE_SECRET?: string
  PLAYGROUND_TURNSTILE_SITEKEY?: string
}

const SLOW_INGEST_MS = 2_000
const MAX_PLAYGROUND_ANNOTATION_BYTES = 1024 * 1024

export { ContainerProxy, PlaygroundCoordinator }

async function fetchIngestWithDiagnostics(
  request: Request,
  bytes: number,
  fetcher: () => Promise<Response>,
): Promise<Response> {
  const rawRequestId = request.headers.get('X-Ingest-Request-ID')
  const requestId = rawRequestId && /^[A-Za-z0-9_-]{1,64}$/.test(rawRequestId) ? rawRequestId : null
  const startedAt = Date.now()
  try {
    const response = await fetcher()
    const durationMs = Date.now() - startedAt
    if (!response.ok || durationMs >= SLOW_INGEST_MS) {
      console.warn('Ingest proxy request', { layer: 'worker', requestId, bytes, durationMs, status: response.status })
    }
    return response
  } catch (error) {
    console.error('Ingest proxy request failed', {
      layer: 'worker',
      requestId,
      bytes,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

async function handleContainerOutbound(request: Request, env: Env): Promise<Response> {
  const destination = new URL(request.url)
  const ownerOrigin = new URL(env.ALLOWED_ORIGINS)
  if (
    env.DEPLOYMENT_PROFILE === 'owner'
    &&
    ownerOrigin.protocol === 'https:'
    && destination.protocol === ownerOrigin.protocol
    && destination.host === ownerOrigin.host
    && destination.pathname === '/relay/publish'
    && request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
  ) {
    try {
      const access = publisherAccessCredentials(env)
      if (!access) return new Response('Publisher Access credentials are required', { status: 503 })
      const headers = new Headers(request.headers)
      headers.set('CF-Access-Client-Id', access.client_id)
      headers.set('CF-Access-Client-Secret', access.client_secret)
      request = new Request(request, { headers })
    } catch (error) {
      if (error instanceof MediaPolicyError) return new Response(error.message, { status: error.status })
      throw error
    }
  }
  return fetch(request)
}

// The demo supplies identity-specific policy and shared profile storage; Streamline owns session coordination.
export class MediaContainer extends StreamlineSessionDO<WorkerEnv> {
  protected async resolveStartConfig(
    _request: Request,
    body: Record<string, unknown>,
  ): Promise<ResolvedSessionStart> {
    const profile = getDeploymentProfile(this.env.DEPLOYMENT_PROFILE)
    if (!profile) throw new MediaPolicyError('Deployment profile is disabled', 503)
    if (profile.name === 'playground') {
      return {
        body: applyPlaygroundStartPolicy(body, profile),
        maxSessionSeconds: profile.limits.maxSessionSeconds,
      }
    }
    const overrides = await readMediaOverrides(this.ctx.storage)
    return {
      body: applyStartPolicy(body, resolveMediaProfileEnvironment(this.env, overrides), profile),
      maxSessionSeconds: profile.limits.maxSessionSeconds,
    }
  }

  protected handleStartConfigError(error: unknown): Response | undefined {
    return error instanceof MediaPolicyError ? new Response(error.message, { status: error.status }) : undefined
  }

  protected ensurePublisherAccess(): void {
    if (getDeploymentProfile(this.env.DEPLOYMENT_PROFILE)?.name === 'owner') publisherAccessCredentials(this.env)
  }

  protected getRelayPublisherUrl(request: Request): URL {
    const relayUrl = super.getRelayPublisherUrl(request)
    if (getDeploymentProfile(this.env.DEPLOYMENT_PROFILE)?.name !== 'playground') return relayUrl
    const principal = request.headers.get('X-Streamline-Principal')
    if (!selectMediaContainerRoute('playground', principal ?? undefined)) {
      throw new MediaPolicyError('Anonymous principal is invalid', 401)
    }
    relayUrl.searchParams.set('principal', principal!)
    return relayUrl
  }

  protected async onRelaySessionCleared(session: StreamlineRelaySession): Promise<void> {
    if (getDeploymentProfile(this.env.DEPLOYMENT_PROFILE)?.name !== 'playground') return
    await coordinate(this.env, 'release', session.principal)
    // Playground sessions are isolated by container; release that capacity as soon as media stops.
    await this.stop()
  }

  protected async handleApplicationRequest(request: Request): Promise<Response | undefined> {
    const disabled = rejectDisabledDeployment(this.env.DEPLOYMENT_PROFILE)
    if (disabled) return disabled
    if (new URL(request.url).pathname !== '/api/media-overrides') return undefined
    if (getDeploymentProfile(this.env.DEPLOYMENT_PROFILE)?.name === 'playground') {
      return new Response('Not found', { status: 404 })
    }
    return this.withControlLock(() => handleMediaOverrideRequest(request, this.env, this.ctx.storage))
  }
}

// Limit TLS interception to the WSS publisher; RTMPS also uses port 443 but is not HTTP.
MediaContainer.outboundByHost = Object.fromEntries(
  deploymentRelayHosts.map((host) => [host, handleContainerOutbound]),
)

const CONTAINER_PATHS = [
  '/health',
  '/start',
  '/ingest',
  '/api/annotation',
  '/api/media-overrides',
  '/stop',
  '/metrics',
]

const RELAY_PATHS = ['/relay/prepare', '/relay/publish', '/relay/view']

function isContainerPath(path: string): boolean {
  return CONTAINER_PATHS.includes(path)
}

function isPlaygroundControlPath(path: string): boolean {
  return RELAY_PATHS.includes(path) || isContainerPath(path)
}

function rateLimitedResponse(decision: AdmissionDecision): Response {
  return new Response('Try again later', {
    status: 429,
    headers: { 'Cache-Control': 'no-store', 'Retry-After': String(decision.retryAfterSeconds ?? 60) },
  })
}

async function coordinate(
  env: WorkerEnv,
  action: 'admit' | 'acquire' | 'annotate' | 'release',
  subject: string,
): Promise<{ allowed: boolean; acquired?: boolean; retryAfterSeconds?: number }> {
  const response = await env.PLAYGROUND_COORDINATOR.getByName('global').fetch(new Request(
    `https://playground-coordinator.internal/${action}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject }),
    },
  ))
  if (action === 'release') {
    if (!response.ok) throw new Error('Playground coordinator release failed')
    return { allowed: true }
  }
  if (!response.ok) throw new Error('Playground coordinator request failed')
  const value: unknown = await response.json()
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid playground coordinator response')
  const result = value as Record<string, unknown>
  if (typeof result.allowed !== 'boolean') throw new Error('Invalid playground coordinator response')
  return {
    allowed: result.allowed,
    ...(typeof result.acquired === 'boolean' ? { acquired: result.acquired } : {}),
    ...(typeof result.retryAfterSeconds === 'number' ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
  }
}

async function admitAnonymousPrincipal(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url)
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } })
  if (request.headers.get('Origin') !== url.origin || !playgroundTurnstileConfig(env)) {
    return new Response('Forbidden', { status: 403, headers: { 'Cache-Control': 'no-store' } })
  }
  const token = await readAdmissionToken(request)
  const remoteIp = request.headers.get('CF-Connecting-IP')
  if (!token || !remoteIp || !/^[0-9a-f:.]{3,64}$/i.test(remoteIp)) {
    return new Response('Forbidden', { status: 403, headers: { 'Cache-Control': 'no-store' } })
  }
  const subject = await hashAnonymousSubject(remoteIp, env)
  if (!subject) return new Response('Forbidden', { status: 403, headers: { 'Cache-Control': 'no-store' } })
  if (!await verifyPlaygroundAdmission(request, env, token)) {
    return new Response('Forbidden', { status: 403, headers: { 'Cache-Control': 'no-store' } })
  }
  const admission = await coordinate(env, 'admit', subject)
  if (!admission.allowed) return rateLimitedResponse(admission)
  const principalCookie = await createAnonymousPrincipalCookie(env)
  if (!principalCookie) return new Response('Forbidden', { status: 403, headers: { 'Cache-Control': 'no-store' } })
  return new Response(null, {
    status: 204,
    headers: { 'Cache-Control': 'no-store', 'Set-Cookie': principalCookie.cookie },
  })
}

function playgroundConfig(env: WorkerEnv): Response {
  const sitekey = env.PLAYGROUND_TURNSTILE_SITEKEY?.trim() ?? ''
  const config = playgroundTurnstileConfig(env)
  if (!config || !/^[A-Za-z0-9_-]{1,128}$/.test(sitekey)) {
    return new Response('Playground is not configured', { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
  return Response.json({ sitekey, action: config.action }, { headers: { 'Cache-Control': 'no-store' } })
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const disabled = rejectDisabledDeployment(env.DEPLOYMENT_PROFILE)
    if (disabled) return disabled
    if (url.pathname === '/test-stream') return new Response('Not found', { status: 404 })
    const playground = env.DEPLOYMENT_PROFILE === 'playground'
    if (playground && url.pathname === '/playground/config') return playgroundConfig(env)
    if (playground && url.pathname === '/playground/admit') return admitAnonymousPrincipal(request, env)
    if (playground && isUnsupportedPlaygroundPage(url.pathname)) return new Response('Not found', { status: 404 })
    if (playground && ['/api/media-overrides', '/metrics', '/health'].includes(url.pathname)) {
      return new Response('Not found', { status: 404 })
    }

    let principal: string | undefined
    if (url.pathname === '/relay/publish') {
      request = withoutAccessServiceCredentials(request)
      principal = playground ? url.searchParams.get('principal') ?? undefined : undefined
    } else if (!playground || isPlaygroundControlPath(url.pathname)) {
      let identity: { principal: string } | null
      if (playground) {
        const anonymous = await readAnonymousPrincipal(request, env)
        identity = anonymous ? { principal: anonymous.id } : null
      } else {
        identity = await authenticateAccessRequest(request, {
          teamDomain: env.ACCESS_TEAM_DOMAIN,
          audience: env.ACCESS_OWNER_AUD,
        })
      }
      if (!identity) {
        return new Response('Unauthorized', {
          status: 401,
          headers: { 'Cache-Control': 'no-store' },
        })
      }
      principal = identity.principal
      request = withTrustedPrincipal(request, identity.principal)
    }

    const route = selectMediaContainerRoute(env.DEPLOYMENT_PROFILE, principal)
    if ((isPlaygroundControlPath(url.pathname) || url.pathname === '/relay/publish') && !route) {
      return new Response('Unauthorized', { status: 401, headers: { 'Cache-Control': 'no-store' } })
    }

    if (RELAY_PATHS.includes(url.pathname)) {
      if (url.pathname === '/relay/prepare') {
        if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const bodylessRequest = await normalizeEmptyRequestBody(request)
        if (!bodylessRequest) return new Response('Relay preparation does not accept a body', { status: 400 })
        request = bodylessRequest
        if (request.headers.get('Origin') !== url.origin) return new Response('Origin not allowed', { status: 403 })
      } else {
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
          return new Response('Expected Upgrade: websocket', { status: 400 })
        }
        if (url.pathname === '/relay/view' && request.headers.get('Origin') !== url.origin) {
          return new Response('WebSocket origin not allowed', { status: 403 })
        }
      }
      let acquired = false
      if (playground && url.pathname === '/relay/prepare') {
        const lease = await coordinate(env, 'acquire', principal!)
        if (!lease.allowed) return rateLimitedResponse(lease)
        acquired = lease.acquired === true
      }
      const response = await getMediaContainer(env, route!).fetch(
        toInternalContainerRequest(request, url.pathname === '/relay/publish'),
      )
      if (playground && url.pathname === '/relay/prepare' && acquired && !response.ok) {
        await coordinate(env, 'release', principal!)
      }
      return response
    }

    if (isContainerPath(url.pathname)) {
      if (url.pathname === '/api/media-overrides') {
        const prepared = await prepareMediaOverrideRequest(request)
        if (prepared instanceof Response) return prepared
        request = prepared
      }
      if (['/start', '/ingest', '/api/annotation', '/stop'].includes(url.pathname)) {
        if (request.headers.get('Origin') !== url.origin) return new Response('Origin not allowed', { status: 403 })
      }
      if (url.pathname === '/api/annotation') {
        if (request.method !== 'PUT') return new Response('Method not allowed', { status: 405 })
        if (request.headers.get('Content-Type')?.split(';', 1)[0].trim() !== 'image/png') {
          return new Response('Content-Type must be image/png', { status: 415 })
        }
        if (playground) {
          const annotation = await coordinate(env, 'annotate', principal!)
          if (!annotation.allowed) return rateLimitedResponse(annotation)
        }
        const maxAnnotationBytes = playground ? MAX_PLAYGROUND_ANNOTATION_BYTES : MAX_ANNOTATION_BYTES
        const body = await readBodyWithLimit(request, maxAnnotationBytes)
        if (!body) return new Response(`Annotation image exceeds the ${maxAnnotationBytes / (1024 * 1024)}MB limit`, { status: 413 })
        request = new Request(request, { body })
      }
      if (url.pathname === '/start' && request.method === 'POST') {
        const body = await readBodyWithLimit(request, MAX_START_BYTES)
        if (!body) return new Response('Start request exceeds the 64KiB limit', { status: 413 })
        request = new Request(request, { body })
      }
      if (url.pathname === '/ingest' && request.method === 'POST') {
        if (request.headers.get('Content-Type')?.split(';', 1)[0].trim() !== 'application/octet-stream') {
          return new Response('Content-Type must be application/octet-stream', { status: 415 })
        }
        const body = await readBodyWithLimit(request, MAX_INGEST_BYTES)
        if (!body) return new Response('Ingest request exceeds the 1MiB limit', { status: 413 })
        request = new Request(request, { body })
        request = toInternalContainerRequest(request)
        return fetchIngestWithDiagnostics(request, body.byteLength, () => getMediaContainer(env, route!).fetch(request))
      }
      if (url.pathname === '/stop') {
        if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const bodylessRequest = await normalizeEmptyRequestBody(request)
        if (!bodylessRequest) return new Response('Stop does not accept a body', { status: 400 })
        request = bodylessRequest
        console.info('Relay stop request', {
          layer: 'worker',
          requestId: request.headers.get('X-Stop-Request-ID'),
          hasRequestedSessionId: request.headers.has('X-Streamline-Session-ID'),
        })
      }
      return getMediaContainer(env, route!).fetch(toInternalContainerRequest(request))
    }

    return withSecurityHeaders(await astro.fetch(request, env, ctx))
  },
}
