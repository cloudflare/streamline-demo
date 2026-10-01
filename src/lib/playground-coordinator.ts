import {
  evaluateAdmission,
  evaluateAnnotation,
  evaluateLease,
  ADMISSION_WINDOW_MS,
  ANNOTATION_WINDOW_MS,
  type AdmissionDecision,
  type LeaseDecision,
} from './playground-coordinator-policy.ts'

interface CoordinatorState {
  admissions: Record<string, number[]>
  annotations?: Record<string, number[]>
  leases: Record<string, number>
}

interface CoordinatorStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
}

interface CoordinatorContext {
  storage: {
    transaction<T>(callback: (storage: CoordinatorStorage) => Promise<T>): Promise<T>
  }
}

export type { AdmissionDecision, LeaseDecision } from './playground-coordinator-policy.ts'

export class PlaygroundCoordinator {
  private readonly ctx: CoordinatorContext

  constructor(ctx: CoordinatorContext) {
    this.ctx = ctx
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
    let value: unknown
    try {
      value = await request.json()
    } catch {
      return new Response('Invalid coordinator request', { status: 400 })
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return new Response('Invalid coordinator request', { status: 400 })
    }
    const body = value as Record<string, unknown>
    if (typeof body.subject !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.subject)) {
      return new Response('Invalid coordinator subject', { status: 400 })
    }
    switch (new URL(request.url).pathname) {
      case '/admit':
        return Response.json(await this.admit(body.subject))
      case '/acquire':
        return Response.json(await this.acquire(body.subject))
      case '/annotate':
        return Response.json(await this.annotate(body.subject))
      case '/release':
        await this.release(body.subject)
        return new Response(null, { status: 204 })
      default:
        return new Response('Not found', { status: 404 })
    }
  }

  async admit(subject: string): Promise<AdmissionDecision> {
    return this.ctx.storage.transaction(async (storage) => {
      const state = await storage.get<CoordinatorState>('state') ?? { admissions: {}, leases: {} }
      pruneExpiredState(state)
      const result = evaluateAdmission(state.admissions[subject] ?? [])
      state.admissions[subject] = result.timestamps
      await storage.put('state', state)
      return result.decision
    })
  }

  async acquire(principal: string): Promise<LeaseDecision> {
    return this.ctx.storage.transaction(async (storage) => {
      const state = await storage.get<CoordinatorState>('state') ?? { admissions: {}, leases: {} }
      pruneExpiredState(state)
      const result = evaluateLease(state.leases, principal)
      state.leases = result.leases
      await storage.put('state', state)
      return result.decision
    })
  }

  async annotate(principal: string): Promise<AdmissionDecision> {
    return this.ctx.storage.transaction(async (storage) => {
      const state = await storage.get<CoordinatorState>('state') ?? { admissions: {}, leases: {} }
      pruneExpiredState(state)
      state.annotations ??= {}
      const result = evaluateAnnotation(state.annotations[principal] ?? [])
      state.annotations[principal] = result.timestamps
      await storage.put('state', state)
      return result.decision
    })
  }

  async release(principal: string): Promise<void> {
    await this.ctx.storage.transaction(async (storage) => {
      const state = await storage.get<CoordinatorState>('state')
      if (!state || !state.leases[principal]) return
      pruneExpiredState(state)
      delete state.leases[principal]
      await storage.put('state', state)
    })
  }
}

function pruneExpiredState(state: CoordinatorState, now = Date.now()): void {
  pruneRateLimits(state.admissions, now - ADMISSION_WINDOW_MS)
  if (state.annotations) pruneRateLimits(state.annotations, now - ANNOTATION_WINDOW_MS)
  for (const [principal, expiresAt] of Object.entries(state.leases)) {
    if (expiresAt <= now) delete state.leases[principal]
  }
}

function pruneRateLimits(limits: Record<string, number[]>, cutoff: number): void {
  for (const [subject, timestamps] of Object.entries(limits)) {
    const active = timestamps.filter((timestamp) => timestamp > cutoff)
    if (active.length === 0) delete limits[subject]
    else limits[subject] = active
  }
}
