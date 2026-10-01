const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self' https://videodelivery.net https://*.cloudflarestream.com",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "frame-src https://challenges.cloudflare.com https://iframe.videodelivery.net https://iframe.cloudflarestream.com https://*.cloudflarestream.com",
  "img-src 'self' data: blob: https://videodelivery.net https://*.videodelivery.net https://*.cloudflarestream.com",
  "media-src 'self' blob: https://videodelivery.net https://*.cloudflarestream.com",
  "object-src 'none'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
].join('; ')

export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()')
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'DENY')
  if (headers.get('Content-Type')?.includes('text/html')) headers.set('Cache-Control', 'no-store')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
