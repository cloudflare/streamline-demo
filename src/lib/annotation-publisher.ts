type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface AnnotationPublisherError {
  status?: number
  error: unknown
}

export interface AnnotationPublisherOptions {
  getBaseUrl: () => string
  isActive: () => boolean
  isPlaybackStarted?: () => boolean
  isReady?: () => boolean
  intervalMs?: number
  fetcher?: Fetcher
  onSent?: (size: number) => void
  onError?: (details: AnnotationPublisherError) => void
}

export class AnnotationPublisher {
  private readonly options: AnnotationPublisherOptions
  private timer: ReturnType<typeof setInterval> | null = null
  private blob: Blob | null = null
  private sessionId: string | null = null
  private publishPending = false
  private publishLoop: Promise<void> | null = null
  private requestController: AbortController | null = null
  private runId = 0
  private halted = false

  constructor(options: AnnotationPublisherOptions) {
    this.options = options
  }

  start(blob: Blob, sessionId: string | null): void {
    this.stop()
    this.blob = blob
    this.sessionId = sessionId
    this.halted = false
    this.timer = setInterval(() => {
      void this.publishNow()
    }, this.options.intervalMs ?? 250)
    void this.publishNow()
  }

  stop(): void {
    this.runId++
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.blob = null
    this.sessionId = null
    this.publishPending = false
    this.publishLoop = null
    this.halted = false
    this.requestController?.abort()
    this.requestController = null
  }

  setBlob(blob: Blob, publishImmediately = true): Promise<void> {
    this.blob = blob
    return publishImmediately ? this.publishNow() : Promise.resolve()
  }

  publishNow(blob?: Blob): Promise<void> {
    if (blob) this.blob = blob
    if (this.halted) return Promise.resolve()
    this.publishPending = true
    if (this.publishLoop) return this.publishLoop

    const runId = this.runId
    const publishLoop = this.drainPublishes(runId)
    this.publishLoop = publishLoop
    const clearPublishLoop = () => {
      if (this.publishLoop === publishLoop) this.publishLoop = null
    }
    void publishLoop.then(clearPublishLoop, clearPublishLoop)
    return publishLoop
  }

  private async drainPublishes(runId: number): Promise<void> {
    while (runId === this.runId && this.publishPending && !this.halted) {
      this.publishPending = false
      if (!this.options.isActive() || !this.isReady() || !this.blob) return
      await this.publishBlob(this.blob, runId)
    }
  }

  private async publishBlob(blob: Blob, runId: number): Promise<void> {
    const controller = new AbortController()
    this.requestController = controller

    try {
      const headers = new Headers({ 'Content-Type': 'image/png' })
      if (this.sessionId) headers.set('X-Streamline-Session-ID', this.sessionId)
      const fetcher = this.options.fetcher ?? fetch
      const response = await fetcher(`${this.options.getBaseUrl()}/api/annotation`, {
        method: 'PUT',
        headers,
        body: blob,
        signal: controller.signal,
      })
      if (runId !== this.runId) return

      if (!response.ok) {
        const error = await response.text()
        if (runId !== this.runId) return
        if (response.status === 409) {
          this.halted = true
          this.publishPending = false
          if (this.timer) clearInterval(this.timer)
          this.timer = null
        }
        this.options.onError?.({ status: response.status, error })
        return
      }

      this.options.onSent?.(blob.size)
    } catch (error) {
      if (runId === this.runId) this.options.onError?.({ error })
    } finally {
      if (this.requestController === controller) this.requestController = null
    }
  }

  private isReady(): boolean {
    return this.options.isReady?.() ?? this.options.isPlaybackStarted?.() ?? true
  }
}

export async function loadScaledAnnotationPng(path: string, resolution: string): Promise<Blob> {
  const response = await fetch(path)
  if (!response.ok) throw new Error(`annotation image request failed (${response.status})`)
  const image = await createImageBitmap(await response.blob())
  const [targetWidth, targetHeight] = resolution.split('x').map(Number)
  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  try {
    const context = canvas.getContext('2d')
    if (!context) throw new Error('2D canvas is unavailable')
    context.drawImage(image, 0, 0, targetWidth, targetHeight)
  } finally {
    image.close()
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('failed to encode annotation PNG'))
    }, 'image/png')
  })
}
