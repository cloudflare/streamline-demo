import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OnlineStatistics,
  ProbeTraceHistory,
  findNewBufferGaps,
  formatDuration,
  formatOptionalMetric,
} from '../src/lib/probe-diagnostics.ts'

test('deduplicates stable buffer gaps while reporting new gaps', () => {
  const first = findNewBufferGaps([
    { start: 0, end: 1 },
    { start: 1.25, end: 2 },
  ], [])
  assert.deepEqual(first.newGaps, [{ start: 1, end: 1.25, duration: 0.25 }])

  const repeated = findNewBufferGaps([
    { start: 0.1, end: 1.02 },
    { start: 1.27, end: 2.5 },
  ], first.observedGaps)
  assert.deepEqual(repeated.newGaps, [])

  const next = findNewBufferGaps([
    { start: 0.1, end: 1.02 },
    { start: 1.27, end: 2.5 },
    { start: 2.8, end: 3.2 },
  ], repeated.observedGaps)
  assert.deepEqual(next.newGaps, [{ start: 2.5, end: 2.8, duration: 0.2999999999999998 }])
})

test('bounds retained trace events while preserving total counts', () => {
  const history = new ProbeTraceHistory(3)
  for (let index = 0; index < 8; index++) history.append({ t: index, type: `event-${index}` })

  assert.deepEqual(history.events.map((event) => event.type), ['event-5', 'event-6', 'event-7'])
  assert.equal(history.totalCount, 8)
  assert.equal(history.droppedCount, 5)

  history.clear()
  assert.deepEqual(history.events, [])
  assert.equal(history.totalCount, 0)
})

test('calculates full-session online interarrival statistics', () => {
  const statistics = new OnlineStatistics()
  for (let index = 0; index < 1_000; index++) statistics.append(10)
  for (let index = 0; index < 2_000; index++) statistics.append(20)

  assert.equal(statistics.count, 3_000)
  assert.ok(Math.abs(statistics.mean - (50 / 3)) < 1e-10)
  assert.ok(Math.abs(statistics.standardDeviation - Math.sqrt(200 / 9)) < 1e-10)

  statistics.clear()
  assert.equal(statistics.count, 0)
  assert.equal(statistics.mean, 0)
  assert.equal(statistics.standardDeviation, 0)
})

test('formats durations with second rollover and optional zero metrics', () => {
  assert.equal(formatDuration(999), '999ms')
  assert.equal(formatDuration(1_999), '2.00s')
  assert.equal(formatDuration(-50), '0ms')
  assert.equal(formatOptionalMetric(undefined, 1, ' fps'), '-')
  assert.equal(formatOptionalMetric(Number.NaN, 1), '-')
  assert.equal(formatOptionalMetric(0, 3, 'x'), '0.000x')
  assert.equal(formatOptionalMetric(29.96, 1), '30.0')
})
