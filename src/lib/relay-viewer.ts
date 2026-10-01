export interface RelayPayloadDetails {
  receivedAt: number
  deltaMs: number
  connection: number
  recoveredFromStall: boolean
}

export interface RelayViewerStats {
  connectionCount: number
  lastPayloadAt: number
  openedAt: number
  connecting: boolean
  stalled: boolean
}

export interface RelayViewerOptions {
  getUrl: () => string
  isActive: () => boolean
  getReconnectKey: () => string | null
  openTimeoutMs?: number
  stallTimeoutMs?: number
  watchdogIntervalMs?: number
  reconnectDelayMs?: (attempt: number) => number
  now?: () => number
  createWebSocket?: (url: string) => WebSocket
  onOpen?: (reason: string, connection: number) => void
  onPayload: (payload: Uint8Array, details: RelayPayloadDetails) => void
  onEnd?: () => void
  onClose?: (event: CloseEvent, opened: boolean) => void
  onError?: (connection: number) => void
  onStalled?: (ageMs: number) => void
  onReconnectScheduled?: (closeCode: number, attempt: number, delayMs: number) => void
  onReconnected?: (attempt: number) => void
  onReconnectFailed?: (attempt: number, error: unknown) => void
}

export class RelayViewer {
  private readonly options: RelayViewerOptions
  private socket: WebSocket | null = null
  private connecting = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private reconnectAttempts = 0
  private openedAt = 0
  private connectionCount = 0
  private stalled = false
  private lastPayloadAt = 0
  private pendingConnectReject: ((error: Error) => void) | null = null
  private openTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: RelayViewerOptions) {
    this.options = options
  }

  connect(reason = 'initial'): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.options.isActive() || this.connecting || this.socket) {
        reject(new Error('output connection is not available'))
        return
      }

      let settled = false
      const clearOpenTimer = () => {
        if (this.openTimer) clearTimeout(this.openTimer)
        this.openTimer = null
      }
      const resolveConnect = () => {
        if (settled) return
        settled = true
        clearOpenTimer()
        if (this.pendingConnectReject === rejectConnect) this.pendingConnectReject = null
        resolve()
      }
      const rejectConnect = (error: Error) => {
        if (settled) return
        settled = true
        clearOpenTimer()
        if (this.pendingConnectReject === rejectConnect) this.pendingConnectReject = null
        reject(error)
      }
      this.pendingConnectReject = rejectConnect

      this.connecting = true
      let socket: WebSocket
      try {
        socket = this.options.createWebSocket?.(this.options.getUrl()) ?? new WebSocket(this.options.getUrl())
      } catch (error) {
        this.connecting = false
        rejectConnect(error instanceof Error ? error : new Error(String(error)))
        return
      }

      socket.binaryType = 'arraybuffer'
      this.socket = socket
      let opened = false
      let ended = false
      const openTimeoutMs = this.options.openTimeoutMs ?? 10_000
      this.openTimer = setTimeout(() => {
        if (socket !== this.socket || opened) return
        this.socket = null
        this.connecting = false
        socket.close(1000, 'relay open timeout')
        rejectConnect(new Error(`relay connection timed out after ${openTimeoutMs}ms`))
      }, openTimeoutMs)

      socket.addEventListener('open', () => {
        if (socket !== this.socket) return
        opened = true
        this.connecting = false
        this.openedAt = this.now()
        this.stalled = false
        this.connectionCount++
        this.options.onOpen?.(reason, this.connectionCount)
        resolveConnect()
      })

      socket.addEventListener('message', (event) => {
        if (socket !== this.socket) return
        if (typeof event.data === 'string') {
          try {
            const message = JSON.parse(event.data) as { type?: unknown }
            if (message.type === 'eos' && !ended) {
              ended = true
              this.options.onEnd?.()
            }
          } catch {
            // Ignore non-protocol text frames.
          }
          return
        }
        if (!(event.data instanceof ArrayBuffer)) return
        const frame = new Uint8Array(event.data)
        if (frame.length === 0) return

        const receivedAt = this.now()
        const deltaMs = this.lastPayloadAt > 0 ? receivedAt - this.lastPayloadAt : 0
        const recoveredFromStall = this.stalled
        this.lastPayloadAt = receivedAt
        this.stalled = false
        this.options.onPayload(frame, {
          receivedAt,
          deltaMs,
          connection: this.connectionCount,
          recoveredFromStall,
        })
      })

      socket.addEventListener('close', (event) => {
        if (socket !== this.socket) return
        this.socket = null
        this.connecting = false
        if (opened && event.code === 1000 && !ended) {
          ended = true
          this.options.onEnd?.()
        }
        this.options.onClose?.(event, opened)
        if (!opened) rejectConnect(new Error(`relay connection closed (${event.code})`))
        if (opened && this.options.isActive() && event.code !== 1000 && event.code !== 1012) {
          this.scheduleReconnect(event.code)
        }
      })

      socket.addEventListener('error', () => {
        if (socket !== this.socket) return
        this.options.onError?.(this.connectionCount + 1)
      })
    })
  }

  async connectWhenAvailable(
    attempts = 20,
    retryDelayMs = 100,
    isAvailable: () => boolean | Promise<boolean> = () => true,
  ): Promise<void> {
    let lastError: unknown = new Error('output connection is not available')
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (!this.options.isActive()) throw new Error('output connection is not available')
      try {
        if (await isAvailable()) {
          await this.connect(attempt === 0 ? 'initial' : 'startup-retry')
          return
        }
      } catch (error) {
        lastError = error
      }
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
      }
    }
    throw lastError
  }

  startWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer)
    this.watchdogTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== 1) return
      const referenceTime = this.lastPayloadAt || this.openedAt
      const ageMs = this.now() - referenceTime
      if (!this.stalled && referenceTime > 0 && ageMs > (this.options.stallTimeoutMs ?? 15_000)) {
        this.stalled = true
        this.options.onStalled?.(ageMs)
      }
    }, this.options.watchdogIntervalMs ?? 1000)
  }

  getStats(): RelayViewerStats {
    return {
      connectionCount: this.connectionCount,
      lastPayloadAt: this.lastPayloadAt,
      openedAt: this.openedAt,
      connecting: this.connecting,
      stalled: this.stalled,
    }
  }

  stop(reason = 'probe stopped'): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer)
    this.watchdogTimer = null
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.openTimer) clearTimeout(this.openTimer)
    this.openTimer = null
    this.connecting = false
    this.openedAt = 0
    this.pendingConnectReject?.(new Error(reason))

    if (this.socket) {
      const socket = this.socket
      this.socket = null
      socket.close(1000, reason)
    }
  }

  reset(): void {
    this.stop()
    this.reconnectAttempts = 0
    this.openedAt = 0
    this.connectionCount = 0
    this.stalled = false
    this.lastPayloadAt = 0
  }

  private scheduleReconnect(closeCode: number): void {
    const reconnectKey = this.options.getReconnectKey()
    if (!this.options.isActive() || this.reconnectTimer || !reconnectKey) return

    const attempt = ++this.reconnectAttempts
    const delayMs = this.options.reconnectDelayMs?.(attempt)
      ?? Math.min(250 * (2 ** (attempt - 1)), 5000)
    this.options.onReconnectScheduled?.(closeCode, attempt, delayMs)

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (!this.options.isActive() || this.options.getReconnectKey() !== reconnectKey) return
      try {
        await this.connect('reconnect')
        this.reconnectAttempts = 0
        this.options.onReconnected?.(attempt)
      } catch (error) {
        this.options.onReconnectFailed?.(attempt, error)
        this.scheduleReconnect(closeCode)
      }
    }, delayMs)
  }

  private now(): number {
    return this.options.now?.() ?? performance.now()
  }
}
