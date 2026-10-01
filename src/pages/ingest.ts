import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { proxyToContainer } from '../lib/container-proxy'

export const POST: APIRoute = async ({ request }) => {
  return proxyToContainer(request, env)
}
