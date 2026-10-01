declare module 'cloudflare:workers' {
  interface ContainerStub {
    fetch(request: Request): Promise<Response>
  }

  interface AstroRuntimeEnv {
    MEDIA_CONTAINER?: {
      getByName(name: string): ContainerStub
    }
    MEDIA_PROFILE_ID?: string
    MEDIA_RTMP_INPUT_PROFILE?: string
    MEDIA_RTMP_OUTPUT_PROFILE?: string
    PUBLISHER_ACCESS_CLIENT_ID?: string
    PUBLISHER_ACCESS_CLIENT_SECRET?: string
    PUBLISHER_ACCESS_REQUIRED?: string
  }

  export const env: AstroRuntimeEnv
}
