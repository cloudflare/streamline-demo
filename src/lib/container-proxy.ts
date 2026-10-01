import { toInternalContainerRequest } from './access-auth.ts'
import { createLocalContainerRequest, validateLocalContainerRequest } from './local-container-proxy.ts'

// A fresh instance clears the SDK's persisted catch-all TLS interception from v2.
export const MEDIA_CONTAINER_INSTANCE = 'streamline-demo-config-v3'

interface ContainerFetcher {
  fetch(request: Request): Promise<Response>
}

interface ContainerNamespace<Stub extends ContainerFetcher> {
  getByName(name: string): Stub
}

interface ContainerEnv<Stub extends ContainerFetcher> {
  MEDIA_CONTAINER: ContainerNamespace<Stub>
}

export interface ContainerProxyEnv<Stub extends ContainerFetcher = ContainerFetcher> {
  MEDIA_CONTAINER?: ContainerNamespace<Stub>
}

export function selectMediaContainerRoute(profile: string | undefined, principal?: string): string | null {
  if (profile !== 'playground') return MEDIA_CONTAINER_INSTANCE
  if (!principal || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(principal)) {
    return null
  }
  return `streamline-demo-playground-${principal.toLowerCase()}`
}

export function getMediaContainer<Stub extends ContainerFetcher>(env: ContainerEnv<Stub>, route = MEDIA_CONTAINER_INSTANCE): Stub {
  return env.MEDIA_CONTAINER.getByName(route)
}

// Shared container proxy function
export async function proxyToContainer(request: Request, env: ContainerProxyEnv): Promise<Response> {
  try {
    if (!env.MEDIA_CONTAINER) {
      const rejection = validateLocalContainerRequest(request)
      if (rejection) return rejection
      return await fetch(createLocalContainerRequest(request))
    }
    return await getMediaContainer({ MEDIA_CONTAINER: env.MEDIA_CONTAINER })
      .fetch(toInternalContainerRequest(request))
  } catch (error: unknown) {
    console.error('Container proxy request failed', error instanceof Error
      ? { name: error.name, message: error.message }
      : { name: 'UnknownError' })
    return new Response('Container request failed', { status: 502 })
  }
}
