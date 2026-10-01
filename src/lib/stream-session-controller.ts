import {
  createStreamline,
  StreamlineRequestError,
  type StreamlineSession,
} from '@cloudflare/streamline/client'

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const DEFAULT_START_TIMEOUT_MS = 45_000

export interface StreamSessionControllerOptions {
  getBaseUrl: () => string
  fetcher?: Fetcher
  now?: () => number
  createRequestId?: () => string
  prepareTimeoutMs?: number
  startTimeoutMs?: number
  stopTimeoutMs?: number
}

export type StreamSessionStopResult =
  | {
      requestId: string
      sessionId: string | null
      durationMs: number
      status: number
    }
  | {
      requestId: string
      sessionId: string | null
      durationMs: number
      status?: number
      error: unknown
    }

export class StreamSessionController {
  private readonly options: StreamSessionControllerOptions
  private readonly media: ReturnType<typeof createStreamline>
  private session: StreamlineSession | null = null
  private createController: AbortController | null = null
  private createPromise: Promise<string> | null = null
  private startController: AbortController | null = null
  private startPromise: Promise<unknown> | null = null
  private stopPromise: Promise<StreamSessionStopResult> | null = null

  constructor(options: StreamSessionControllerOptions) {
    this.options = options
    this.media = createStreamline({
      baseUrl: options.getBaseUrl(),
      fetcher: options.fetcher,
    })
  }

  get sessionId(): string | null {
    return this.session?.id ?? null
  }

  get isCreatingSession(): boolean {
    return this.createPromise !== null
  }

  setSessionId(sessionId: string | null): void {
    this.session = sessionId ? this.media.sessions.resume(sessionId) : null
  }

  async createSession(): Promise<string> {
    const controller = new AbortController()
    this.createController = controller
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.prepareTimeoutMs ?? 10_000,
    )
    const operation = (async () => {
      const session = await this.media.sessions.create({ signal: controller.signal })
      this.session = session
      return session.id!
    })()
    this.createPromise = operation
    try {
      return await operation
    } finally {
      clearTimeout(timeout)
      if (this.createPromise === operation) this.createPromise = null
      if (this.createController === controller) this.createController = null
    }
  }

  async start<
    TRequest extends object,
    TResponse extends object = Record<string, unknown>,
  >(requestBody: TRequest): Promise<TResponse> {
    const controller = new AbortController()
    this.startController = controller
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    )
    const operation = (async () => {
      if (!this.session) throw new Error('Create or resume a Streamline session before starting it')
      return await this.session.startUnchecked<TResponse, TRequest>(requestBody, { signal: controller.signal })
    })()
    this.startPromise = operation
    try {
      return await operation
    } finally {
      clearTimeout(timeout)
      if (this.startPromise === operation) this.startPromise = null
      if (this.startController === controller) this.startController = null
    }
  }

  abortPendingRequests(): void {
    this.createController?.abort()
    this.startController?.abort()
  }

  async stopCancelledRelay(sessionId: string | null): Promise<void> {
    if (!sessionId) return
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.stopTimeoutMs ?? 10_000)
    try {
      const session = this.media.sessions.resume(sessionId)
      await session.stop({
        requestId: this.createRequestId(),
        signal: controller.signal,
        keepalive: true,
      })
      if (this.session?.id === sessionId) this.session = null
    } catch {
      // The active stop path reports its own failures.
    } finally {
      clearTimeout(timeout)
    }
  }

  stop(requestId = this.createRequestId()): Promise<StreamSessionStopResult> {
    if (this.stopPromise) return this.stopPromise
    const stopPromise = this.performStop(requestId)
    this.stopPromise = stopPromise
    const clearStopPromise = () => {
      if (this.stopPromise === stopPromise) this.stopPromise = null
    }
    void stopPromise.then(clearStopPromise, clearStopPromise)
    return stopPromise
  }

  private async performStop(requestId: string): Promise<StreamSessionStopResult> {
    if (this.createPromise) {
      try {
        await this.createPromise
      } catch {
        // The relay preparation path reports its own failures.
      }
      this.createPromise = null
    }
    this.startController?.abort()
    if (this.startPromise) {
      try {
        await this.startPromise
      } catch {
        // The start path reports its own failures.
      }
      this.startPromise = null
    }

    const session = this.session
    if (!session) throw new Error('No active Streamline session to stop')
    const sessionId = session.id
    const startedAt = this.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.stopTimeoutMs ?? 10_000)

    try {
      const result = await session.stop({
        requestId,
        signal: controller.signal,
        keepalive: true,
      })
      if (result.replaced) {
        return {
          requestId,
          sessionId,
          status: result.status,
          durationMs: this.now() - startedAt,
        }
      }
      if (this.session?.id === null && sessionId !== null) this.session = null
      return {
        requestId,
        sessionId,
        status: result.status,
        durationMs: this.now() - startedAt,
      }
    } catch (error) {
      const status = error instanceof StreamlineRequestError ? error.status : undefined
      return {
        requestId,
        sessionId,
        durationMs: this.now() - startedAt,
        ...(status ? { status } : {}),
        error,
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  private now(): number {
    return this.options.now?.() ?? performance.now()
  }

  private createRequestId(): string {
    return this.options.createRequestId?.() ?? crypto.randomUUID()
  }
}
