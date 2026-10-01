export const ADMISSION_WINDOW_MS = 10 * 60 * 1000
const ADMISSION_LIMIT = 6
export const ANNOTATION_WINDOW_MS = 60 * 1000
const ANNOTATION_LIMIT = 12
const LEASE_TTL_MS = 35 * 60 * 1000
const MAX_ACTIVE_LEASES = 3

export interface AdmissionDecision {
  allowed: boolean
  retryAfterSeconds?: number
}

export interface LeaseDecision extends AdmissionDecision {
  acquired?: boolean
}

export function evaluateAdmission(
  timestamps: number[],
  now = Date.now(),
): { timestamps: number[]; decision: AdmissionDecision } {
  const active = timestamps.filter((timestamp) => timestamp > now - ADMISSION_WINDOW_MS)
  if (active.length >= ADMISSION_LIMIT) {
    return {
      timestamps: active,
      decision: { allowed: false, retryAfterSeconds: Math.ceil((active[0] + ADMISSION_WINDOW_MS - now) / 1000) },
    }
  }
  return { timestamps: [...active, now], decision: { allowed: true } }
}

export function evaluateAnnotation(
  timestamps: number[],
  now = Date.now(),
): { timestamps: number[]; decision: AdmissionDecision } {
  const active = timestamps.filter((timestamp) => timestamp > now - ANNOTATION_WINDOW_MS)
  if (active.length >= ANNOTATION_LIMIT) {
    return {
      timestamps: active,
      decision: { allowed: false, retryAfterSeconds: Math.ceil((active[0] + ANNOTATION_WINDOW_MS - now) / 1000) },
    }
  }
  return { timestamps: [...active, now], decision: { allowed: true } }
}

export function evaluateLease(
  leases: Record<string, number>,
  principal: string,
  now = Date.now(),
): { leases: Record<string, number>; decision: LeaseDecision } {
  const active = Object.fromEntries(Object.entries(leases).filter(([, expiresAt]) => expiresAt > now))
  if (active[principal]) return { leases: active, decision: { allowed: true, acquired: false } }
  if (Object.keys(active).length >= MAX_ACTIVE_LEASES) {
    const earliest = Math.min(...Object.values(active))
    return {
      leases: active,
      decision: { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((earliest - now) / 1000)) },
    }
  }
  return {
    leases: { ...active, [principal]: now + LEASE_TTL_MS },
    decision: { allowed: true, acquired: true },
  }
}
