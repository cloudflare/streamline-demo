import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { proxyToContainer } from '../lib/container-proxy'
import { getDeploymentProfile } from '../lib/deployment-profile'
import { applyLocalStartPolicy, MediaPolicyError } from '../lib/media-policy'
import { readBodyWithLimit } from '../lib/request-body'

export const POST: APIRoute = async ({ request }) => {
  if (!env.MEDIA_CONTAINER) {
    const bytes = await readBodyWithLimit(request, 64 * 1024)
    if (!bytes) return new Response('Start request exceeds the 64KiB limit', { status: 413 })
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object')
      const profile = getDeploymentProfile('owner')
      if (!profile) throw new Error('owner deployment profile is unavailable')
      const requestBody = parsed as Record<string, unknown>
      const body = applyLocalStartPolicy(requestBody, env, profile)
      const headers = new Headers(request.headers)
      headers.delete('Content-Length')
      headers.set('Content-Type', 'application/json')
      request = new Request(request, {
        body: JSON.stringify(body),
        headers,
      })
    } catch (error) {
      if (error instanceof MediaPolicyError) return new Response(error.message, { status: error.status })
      return new Response('Start request must contain valid JSON', { status: 400 })
    }
  }
  return proxyToContainer(request, env)
}
