const COOKIE_NAME = '__Host-streamline-playground'
const PRINCIPAL_TTL_SECONDS = 24 * 60 * 60
const encoder = new TextEncoder()

export interface AnonymousPrincipalConfig {
  PLAYGROUND_PRINCIPAL_SECRET?: string
}

export interface AnonymousPrincipal {
  id: string
  expiresAt: number
}

function configuredSecret(env: AnonymousPrincipalConfig): string | null {
  const secret = env.PLAYGROUND_PRINCIPAL_SECRET?.trim() ?? ''
  return secret.length >= 32 ? secret : null
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

function toBase64Url(bytes: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

async function signature(value: string, secret: string): Promise<string> {
  return toBase64Url(await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(value)))
}

export async function createAnonymousPrincipalCookie(
  env: AnonymousPrincipalConfig,
  now = Date.now(),
): Promise<{ principal: AnonymousPrincipal; cookie: string } | null> {
  const secret = configuredSecret(env)
  if (!secret) return null
  const principal = { id: crypto.randomUUID(), expiresAt: now + PRINCIPAL_TTL_SECONDS * 1000 }
  const value = `${principal.id}.${principal.expiresAt}`
  const signedValue = `${value}.${await signature(value, secret)}`
  return {
    principal,
    cookie: `${COOKIE_NAME}=${signedValue}; Path=/; Max-Age=${PRINCIPAL_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
  }
}

export async function readAnonymousPrincipal(
  request: Request,
  env: AnonymousPrincipalConfig,
  now = Date.now(),
): Promise<AnonymousPrincipal | null> {
  const secret = configuredSecret(env)
  if (!secret) return null
  const value = request.headers.get('Cookie')?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1)
  if (!value) return null
  const [id, expiresAtValue, suppliedSignature, ...extra] = value.split('.')
  if (
    extra.length
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    || !/^\d{1,13}$/.test(expiresAtValue)
    || !suppliedSignature
  ) return null
  const expiresAt = Number(expiresAtValue)
  const signatureBytes = fromBase64Url(suppliedSignature)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || !signatureBytes) return null
  const signatureBuffer = new Uint8Array(signatureBytes.byteLength)
  signatureBuffer.set(signatureBytes)
  const valid = await crypto.subtle.verify(
    'HMAC',
    await signingKey(secret),
    signatureBuffer,
    encoder.encode(`${id}.${expiresAt}`),
  )
  return valid ? { id: id.toLowerCase(), expiresAt } : null
}

export async function hashAnonymousSubject(value: string, env: AnonymousPrincipalConfig): Promise<string | null> {
  const secret = configuredSecret(env)
  if (!secret || !value) return null
  return signature(`subject:${value}`, secret)
}
