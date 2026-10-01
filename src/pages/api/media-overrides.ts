import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { mediaOverrideStatus } from '../../lib/media-overrides'

export const GET: APIRoute = async () => {
  return Response.json(mediaOverrideStatus({}, env, false), {
    headers: { 'Cache-Control': 'no-store' },
  })
}

export const PUT: APIRoute = async () => new Response(
  'Owner Stream profiles require a deployed Durable Object',
  { status: 503, headers: { 'Cache-Control': 'no-store' } },
)
