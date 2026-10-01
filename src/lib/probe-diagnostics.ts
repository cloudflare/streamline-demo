export const PROBE_TRACE_EVENT_LIMIT = 20_000
const OBSERVED_GAP_LIMIT = 1_000

export interface ProbeEvent {
  t: number
  type: string
  [key: string]: unknown
}

export interface ProbeBufferRange {
  start: number
  end: number
}

export interface ProbeBufferGap extends ProbeBufferRange {
  duration: number
}

export interface ProbeGapUpdate {
  newGaps: ProbeBufferGap[]
  observedGaps: ProbeBufferGap[]
}

export interface ProbeThroughputSample {
  t: number
  bytes: number
}

export class ProbeTraceHistory {
  private retained: ProbeEvent[] = []
  private recorded = 0
  private oldestIndex = 0
  private readonly limit: number

  constructor(limit = PROBE_TRACE_EVENT_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Probe trace limit must be a positive integer')
    this.limit = limit
  }

  get events(): readonly ProbeEvent[] {
    if (this.oldestIndex === 0) return this.retained.slice()
    return [
      ...this.retained.slice(this.oldestIndex),
      ...this.retained.slice(0, this.oldestIndex),
    ]
  }

  get totalCount(): number {
    return this.recorded
  }

  get droppedCount(): number {
    return this.recorded - this.retained.length
  }

  append(event: ProbeEvent): void {
    this.recorded++
    if (this.retained.length < this.limit) {
      this.retained.push(event)
      return
    }
    this.retained[this.oldestIndex] = event
    this.oldestIndex = (this.oldestIndex + 1) % this.limit
  }

  clear(): void {
    this.retained.length = 0
    this.recorded = 0
    this.oldestIndex = 0
  }
}

export class OnlineStatistics {
  private sampleCount = 0
  private average = 0
  private squaredDifferenceTotal = 0

  get count(): number {
    return this.sampleCount
  }

  get mean(): number {
    return this.average
  }

  get standardDeviation(): number {
    return this.sampleCount < 2
      ? 0
      : Math.sqrt(this.squaredDifferenceTotal / this.sampleCount)
  }

  append(value: number): void {
    if (!Number.isFinite(value)) return
    this.sampleCount++
    const difference = value - this.average
    this.average += difference / this.sampleCount
    this.squaredDifferenceTotal += difference * (value - this.average)
  }

  clear(): void {
    this.sampleCount = 0
    this.average = 0
    this.squaredDifferenceTotal = 0
  }
}

export function findNewBufferGaps(
  ranges: readonly ProbeBufferRange[],
  observedGaps: readonly ProbeBufferGap[],
  minimumGapSeconds = 0.1,
  dedupeToleranceSeconds = 0.05,
): ProbeGapUpdate {
  const candidates: ProbeBufferGap[] = []
  for (let index = 1; index < ranges.length; index++) {
    const start = ranges[index - 1].end
    const end = ranges[index].start
    const duration = end - start
    if (duration > minimumGapSeconds) candidates.push({ start, end, duration })
  }

  const newGaps = candidates.filter((candidate) => !observedGaps.some((observed) => (
    Math.abs(candidate.start - observed.start) <= dedupeToleranceSeconds
    && Math.abs(candidate.end - observed.end) <= dedupeToleranceSeconds
  )))
  return {
    newGaps,
    observedGaps: [...observedGaps, ...newGaps].slice(-OBSERVED_GAP_LIMIT),
  }
}

export function formatDuration(milliseconds: number): string {
  const duration = Math.max(0, milliseconds)
  if (duration < 1_000) return `${duration.toFixed(0)}ms`
  return `${(duration / 1_000).toFixed(2)}s`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`
  return `${(bytes / (1_024 * 1_024)).toFixed(2)} MB`
}

export function formatOptionalMetric(
  value: number | null | undefined,
  fractionDigits: number,
  suffix = '',
): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '-'
    : `${value.toFixed(fractionDigits)}${suffix}`
}

export function formatThroughput(
  samples: readonly ProbeThroughputSample[],
  now: number,
): string {
  const first = samples[0]
  const last = samples.at(-1)
  if (!first || !last) return '-'
  if (now - last.t > 2_000) return '0.00 Mbps'
  const duration = last.t - first.t
  if (duration < 1_000) return '-'
  const mbps = ((last.bytes - first.bytes) * 8) / (duration / 1_000) / 1_000_000
  return `${mbps.toFixed(2)} Mbps`
}
