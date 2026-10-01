const LOCAL_CONTROL_CONTENT_TYPES: Record<string, string | null> = {
  '/start': 'application/json',
  '/ingest': 'application/octet-stream',
  '/api/annotation': 'image/png',
  '/stop': null,
}

export function createLocalContainerRequest(request: Request): Request {
  const target = new URL(request.url)
  target.protocol = 'http:'
  target.hostname = 'localhost'
  target.port = '8788'
  return new Request(target, request)
}

export function validateLocalContainerRequest(request: Request): Response | null {
  const url = new URL(request.url)
  if (!(url.pathname in LOCAL_CONTROL_CONTENT_TYPES)) return null
  if (request.headers.get('Origin') !== url.origin) {
    return new Response('Origin not allowed', { status: 403 })
  }
  const expectedContentType = LOCAL_CONTROL_CONTENT_TYPES[url.pathname]
  const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim() || null
  if (expectedContentType && contentType !== expectedContentType) {
    return new Response(`Content-Type must be ${expectedContentType}`, { status: 415 })
  }
  return null
}
