import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

interface AccessConfig {
  teamDomain: string
  audience: string
}

export interface AccessIdentity {
  principal: string
  email: string
}

type VerifyAccessToken = (
  token: string,
  config: AccessConfig,
) => Promise<JWTPayload>

const jwksByDomain = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function normalizeTeamDomain(value: string): URL {
  const url = new URL(value.includes('://') ? value : `https://${value}`)
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Access team domain must be an HTTPS origin')
  }
  return url
}

async function verifyAccessToken(token: string, config: AccessConfig): Promise<JWTPayload> {
  const teamDomain = normalizeTeamDomain(config.teamDomain)
  let jwks = jwksByDomain.get(teamDomain.origin)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', teamDomain))
    jwksByDomain.set(teamDomain.origin, jwks)
  }
  const result = await jwtVerify(token, jwks, {
    algorithms: ['RS256'],
    audience: config.audience,
    issuer: teamDomain.origin,
  })
  return result.payload
}

export async function authenticateAccessRequest(
  request: Request,
  config: AccessConfig,
  verify: VerifyAccessToken = verifyAccessToken,
): Promise<AccessIdentity | null> {
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!token || !config.teamDomain || !config.audience) return null

  try {
    const payload = await verify(token, config)
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : ''
    const principal = typeof payload.sub === 'string' ? payload.sub : ''
    if (payload.type !== 'app' || !email || !principal) return null
    return { principal, email }
  } catch {
    return null
  }
}

export function withTrustedPrincipal(request: Request, principal: string): Request {
  const headers = new Headers(request.headers)
  headers.delete('X-Streamline-Principal')
  headers.set('X-Streamline-Principal', principal)
  return new Request(request, { headers })
}

export function withoutAccessServiceCredentials(request: Request): Request {
  const headers = new Headers(request.headers)
  headers.delete('CF-Access-Client-Id')
  headers.delete('CF-Access-Client-Secret')
  return new Request(request, { headers })
}

export function toInternalContainerRequest(request: Request, allowAuthorization = false): Request {
  const headers = new Headers()
  for (const [name, value] of request.headers) {
    const lowerName = name.toLowerCase()
    if (
      lowerName === 'content-type'
      || lowerName === 'origin'
      || lowerName === 'upgrade'
      || lowerName === 'connection'
      || lowerName === 'x-ingest-request-id'
       || lowerName === 'x-streamline-session-id'
      || lowerName === 'x-stop-request-id'
      || lowerName === 'x-streamline-principal'
      || lowerName.startsWith('sec-websocket-')
      || (allowAuthorization && lowerName === 'authorization')
    ) {
      headers.set(name, value)
    }
  }
  return new Request(request, { headers })
}
