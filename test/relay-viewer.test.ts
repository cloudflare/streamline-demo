import assert from 'node:assert/strict'
import test from 'node:test'

import { RelayViewer } from '../src/lib/relay-viewer.ts'

class FakeWebSocket extends EventTarget {
  binaryType = 'blob'
  readyState = 0
  closeCall: [number, string] | null = null

  open() {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }

  receive(data: ArrayBuffer | string) {
    const event = new Event('message')
    Object.defineProperty(event, 'data', { value: data })
    this.dispatchEvent(event)
  }

  close(code: number, reason: string) {
    this.readyState = 3
    this.closeCall = [code, reason]
  }

  disconnect(code: number, reason = '', wasClean = false) {
    this.readyState = 3
    const event = new Event('close')
    Object.defineProperties(event, {
      code: { value: code },
      reason: { value: reason },
      wasClean: { value: wasClean },
    })
    this.dispatchEvent(event)
  }
}

async function waitFor(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(message)
}

test('accepts binary output frames and tracks timing', async () => {
  const sockets: FakeWebSocket[] = []
  let currentTime = 100
  const payloads: number[][] = []
  const deltas: number[] = []
  const viewer = new RelayViewer({
    getUrl: () => 'wss://example.com/relay/view?session_id=test',
    isActive: () => true,
    getReconnectKey: () => 'test',
    now: () => currentTime,
    createWebSocket: () => {
      const socket = new FakeWebSocket()
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
    onPayload: (payload, details) => {
      payloads.push([...payload])
      deltas.push(details.deltaMs)
    },
  })

  const connected = viewer.connect()
  const socket = sockets[0]
  assert.equal(socket.binaryType, 'arraybuffer')
  socket.open()
  await connected

  currentTime = 150
  socket.receive(new Uint8Array([10, 11]).buffer)
  currentTime = 175
  socket.receive(new ArrayBuffer(0))
  currentTime = 210
  socket.receive(new Uint8Array([12]).buffer)

  assert.deepEqual(payloads, [[10, 11], [12]])
  assert.deepEqual(deltas, [0, 60])
  assert.equal(viewer.getStats().connectionCount, 1)
  assert.equal(viewer.getStats().lastPayloadAt, 210)

  viewer.stop()
  assert.deepEqual(socket.closeCall, [1000, 'probe stopped'])
})

test('reports an explicit relay end-of-stream frame', async () => {
  const sockets: FakeWebSocket[] = []
  let ended = 0
  const viewer = new RelayViewer({
    getUrl: () => 'wss://example.com/relay/view?session_id=test',
    isActive: () => true,
    getReconnectKey: () => 'test',
    createWebSocket: () => {
      const socket = new FakeWebSocket()
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
    onPayload: () => {},
    onEnd: () => ended++,
  })

  const connected = viewer.connect()
  const socket = sockets[0]
  socket.open()
  await connected
  socket.receive('{"type":"eos"}')
  socket.receive('{"type":"unknown"}')
  socket.disconnect(1000, 'output ended', true)

  assert.equal(ended, 1)
})

test('treats a normal local output close as end-of-stream', async () => {
  const sockets: FakeWebSocket[] = []
  let ended = 0
  const viewer = new RelayViewer({
    getUrl: () => 'ws://localhost:8788/output?session_id=test',
    isActive: () => true,
    getReconnectKey: () => 'test',
    createWebSocket: () => {
      const socket = new FakeWebSocket()
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
    onPayload: () => {},
    onEnd: () => ended++,
  })

  const connected = viewer.connect()
  const socket = sockets[0]
  socket.open()
  await connected
  socket.disconnect(1000, 'output ended', true)

  assert.equal(ended, 1)
})

test('stop rejects a connection still waiting to open', async () => {
  const sockets: FakeWebSocket[] = []
  const viewer = new RelayViewer({
    getUrl: () => 'wss://example.com/relay/view?session_id=test',
    isActive: () => true,
    getReconnectKey: () => 'test',
    createWebSocket: () => {
      const socket = new FakeWebSocket()
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
    onPayload: () => {},
  })

  const connected = viewer.connect()
  const socket = sockets[0]
  viewer.stop()

  await assert.rejects(connected, /probe stopped/)
  assert.deepEqual(socket.closeCall, [1000, 'probe stopped'])
})

test('times out and cleans up a connection that never opens', async () => {
  const sockets: FakeWebSocket[] = []
  const viewer = new RelayViewer({
    getUrl: () => 'wss://example.com/relay/view?session_id=test',
    isActive: () => true,
    getReconnectKey: () => 'test',
    openTimeoutMs: 1,
    createWebSocket: () => {
      const socket = new FakeWebSocket()
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
    onPayload: () => {},
  })

  await assert.rejects(viewer.connect(), /timed out after 1ms/)
  assert.deepEqual(sockets[0].closeCall, [1000, 'relay open timeout'])
  assert.equal(viewer.getStats().connecting, false)

  const reconnected = viewer.connect()
  sockets[1].open()
  await reconnected
  viewer.stop()
})

test('waits for output readiness before creating a startup socket', async () => {
  const sockets: FakeWebSocket[] = []
  let readinessChecks = 0
  const viewer = new RelayViewer({
    getUrl: () => 'ws://localhost:8788/output?session_id=test',
    isActive: () => true,
    getReconnectKey: () => 'test',
    createWebSocket: () => {
      const socket = new FakeWebSocket()
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
    onPayload: () => {},
  })

  const connected = viewer.connectWhenAvailable(3, 0, () => ++readinessChecks === 3)
  await waitFor(() => sockets.length === 1, 'ready output socket was not created')
  sockets[0].open()
  await connected

  assert.equal(readinessChecks, 3)
  assert.equal(sockets.length, 1)
  viewer.stop()
})

test('reconnects after an abnormal close while the session ID remains current', async () => {
  const sockets: FakeWebSocket[] = []
  const scheduled: Array<[number, number, number]> = []
  const reconnected: number[] = []
  const viewer = new RelayViewer({
    getUrl: () => 'wss://example.com/relay/view?session_id=test',
    isActive: () => true,
    getReconnectKey: () => 'test',
    reconnectDelayMs: () => 0,
    createWebSocket: () => {
      const socket = new FakeWebSocket()
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
    onPayload: () => {},
    onReconnectScheduled: (code, attempt, delay) => scheduled.push([code, attempt, delay]),
    onReconnected: (attempt) => reconnected.push(attempt),
  })

  const connected = viewer.connect()
  sockets[0].open()
  await connected
  sockets[0].disconnect(1006)

  await waitFor(() => sockets.length === 2, 'reconnect socket was not created')
  assert.deepEqual(scheduled, [[1006, 1, 0]])
  sockets[1].open()
  await waitFor(() => reconnected.length === 1, 'reconnect did not complete')

  assert.deepEqual(reconnected, [1])
  assert.equal(viewer.getStats().connectionCount, 2)
  viewer.stop()
})

test('does not reconnect after the relay replaces the connection', async () => {
  const sockets: FakeWebSocket[] = []
  const viewer = new RelayViewer({
    getUrl: () => 'wss://example.com/relay/view?session_id=test',
    isActive: () => true,
    getReconnectKey: () => 'test',
    reconnectDelayMs: () => 0,
    createWebSocket: () => {
      const socket = new FakeWebSocket()
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
    onPayload: () => {},
  })

  const connected = viewer.connect()
  sockets[0].open()
  await connected
  sockets[0].disconnect(1012, 'viewer replaced')
  await new Promise((resolve) => setTimeout(resolve, 5))

  assert.equal(sockets.length, 1)
  viewer.stop()
})

test('abandons a reconnect when the relay session ID changes', async () => {
  const sockets: FakeWebSocket[] = []
  let sessionId = 'session-1'
  const viewer = new RelayViewer({
    getUrl: () => `wss://example.com/relay/view?session_id=${sessionId}`,
    isActive: () => true,
    getReconnectKey: () => sessionId,
    reconnectDelayMs: () => 0,
    createWebSocket: () => {
      const socket = new FakeWebSocket()
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
    onPayload: () => {},
  })

  const connected = viewer.connect()
  sockets[0].open()
  await connected
  sockets[0].disconnect(1006)
  sessionId = 'session-2'
  await new Promise((resolve) => setTimeout(resolve, 5))

  assert.equal(sockets.length, 1)
  viewer.stop()
})

test('reports one stall and marks the first recovered payload', async () => {
  const sockets: FakeWebSocket[] = []
  let currentTime = 100
  const stalls: number[] = []
  const recoveries: boolean[] = []
  const viewer = new RelayViewer({
    getUrl: () => 'wss://example.com/relay/view?session_id=test',
    isActive: () => true,
    getReconnectKey: () => 'test',
    stallTimeoutMs: 10,
    watchdogIntervalMs: 1,
    now: () => currentTime,
    createWebSocket: () => {
      const socket = new FakeWebSocket()
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
    onPayload: (_payload, details) => recoveries.push(details.recoveredFromStall),
    onStalled: (age) => stalls.push(age),
  })

  const connected = viewer.connect()
  const socket = sockets[0]
  socket.open()
  await connected
  viewer.startWatchdog()
  currentTime = 111
  await waitFor(() => stalls.length === 1, 'stall was not reported')
  await new Promise((resolve) => setTimeout(resolve, 3))
  assert.deepEqual(stalls, [11])
  assert.equal(viewer.getStats().stalled, true)

  currentTime = 120
  socket.receive(new Uint8Array([42]).buffer)
  assert.deepEqual(recoveries, [true])
  assert.equal(viewer.getStats().stalled, false)
  viewer.stop()
})
