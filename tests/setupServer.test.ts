import type { Duplex } from 'node:stream'
import type { LoopbackInterface } from '@orkestrel/test/server'
import type { RecorderInterface } from '@orkestrel/test'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRecorder, readProperty, requireValue, waitForCondition } from '@orkestrel/test'
import { createLoopback } from '@orkestrel/test/server'
import {
	holdUpgrade,
	openPausedResponse,
	probeConnectionDrop,
	probeLoopback,
	rawRequest,
	upgradeRequest,
	WORKSPACE_ROOT,
} from './setupServer.js'

// `tests/setupServer.ts` is the Node-only test infrastructure the `src:server` suites drive their
// real sockets through. Each case here puts one exported contract against a real peer bound to
// `127.0.0.1` on an ephemeral port, and reads the outcome from the peer's own observation rather
// than from the helper that produced it, so a helper that reported an outcome it never achieved
// fails. The production server face is proven by `tests/src/server/Server.test.ts`; nothing here
// asserts it.

/** The raw request text `fetch` refuses to send: the malformed `Host` field a suite probes with. */
const MALFORMED_REQUEST = 'GET / HTTP/1.1\r\nHost: foo bar\r\n\r\n'
/** The raw answer the fixture peer writes back to a complete request. */
const RAW_ANSWER = 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
/** An address block reserved for documentation, so no host has it assigned to an interface. */
const UNBINDABLE_HOST = '192.0.2.1'

const bound: LoopbackInterface[] = []
const opened: Array<{ destroy(): void }> = []

function track(loopback: LoopbackInterface): LoopbackInterface {
	bound.push(loopback)
	return loopback
}

/**
 * Build a raw TCP peer that records each complete request it reads and answers with one payload.
 *
 * @param requests - The recorder each complete request text is reported to.
 * @param answer - The bytes written back after a complete request arrives.
 * @returns The unbound server.
 */
function createRawPeer(requests: RecorderInterface<[string]>, answer: string): net.Server {
	return net.createServer((socket) => {
		opened.push(socket)
		let text = ''
		socket.on('data', (chunk: Buffer) => {
			text += chunk.toString('utf8')
			if (!text.endsWith('\r\n\r\n')) return
			requests.handler(text)
			socket.write(answer)
		})
	})
}

/**
 * Build an HTTP peer that records the path of every request and answers it in full.
 *
 * @param paths - The recorder each request path is reported to.
 * @returns The unbound server.
 */
function createAnsweringPeer(paths: RecorderInterface<[string | undefined]>): http.Server {
	return http.createServer((request, response) => {
		paths.handler(request.url)
		response.writeHead(200, { 'Content-Type': 'text/plain' })
		response.end('parked')
	})
}

/**
 * Build an HTTP peer that claims every upgrade, records the handshake, and keeps the socket.
 *
 * @param handshakes - The recorder each upgrade's path and `Sec-WebSocket-Key` is reported to.
 * @param claimed - The live set of sockets the peer took over.
 * @returns The unbound server.
 */
function createUpgradePeer(
	handshakes: RecorderInterface<[string | undefined, unknown]>,
	claimed: Duplex[],
): http.Server {
	const server = http.createServer((_request, response) => {
		response.writeHead(426)
		response.end()
	})
	server.on('upgrade', (request, socket) => {
		claimed.push(socket)
		opened.push(socket)
		handshakes.handler(request.url, request.headers['sec-websocket-key'])
		socket.write(
			'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
		)
		// A real peer reads its side of the upgraded connection. A claimed socket that never reads
		// stays paused, so the client's departure sits unread in the receive buffer and the peer
		// reports nothing. An upgraded socket also keeps its writable side after the client leaves,
		// so `end` is the peer's departure signal and `close` never arrives.
		socket.on('error', () => undefined)
		socket.resume()
	})
	return server
}

afterEach(async () => {
	for (const socket of opened.splice(0)) socket.destroy()
	await Promise.all(bound.splice(0).map((loopback) => loopback.destroy()))
})

describe('setupServer — workspace root', () => {
	it('anchors the workspace root at this package manifest', () => {
		const manifest: unknown = JSON.parse(readFileSync(join(WORKSPACE_ROOT, 'package.json'), 'utf8'))
		expect(readProperty<string>(manifest, 'name')).toBe('@orkestrel/server')
	})
})

describe('setupServer — raw requests', () => {
	it('puts bytes fetch refuses on the wire and returns the peer answer', async () => {
		const requests = createRecorder<[string]>()
		const loopback = track(await createLoopback(createRawPeer(requests, RAW_ANSWER)))
		const answer = await rawRequest(loopback.port, MALFORMED_REQUEST)
		expect(requests.calls).toEqual([[MALFORMED_REQUEST]])
		expect(answer).toBe(RAW_ANSWER)
	})
})

describe('setupServer — paused responses', () => {
	it('parks the answer bytes until the reader resumes', async () => {
		const paths = createRecorder<[string | undefined]>()
		const loopback = track(await createLoopback(createAnsweringPeer(paths)))
		const paused = await openPausedResponse(loopback.port, '/events')
		await waitForCondition('the peer answered the paused request', () => paths.count === 1)
		expect(paths.calls).toEqual([['/events']])
		expect(paused.bytes).toBe(0)
		paused.resume()
		await paused.closed
		expect(paused.bytes).toBeGreaterThan(0)
	})

	it('tears down a paused response that was never resumed', async () => {
		const paths = createRecorder<[string | undefined]>()
		const loopback = track(await createLoopback(createAnsweringPeer(paths)))
		const paused = await openPausedResponse(loopback.port)
		await waitForCondition('the peer answered the paused request', () => paths.count === 1)
		paused.destroy()
		await paused.closed
		expect(paused.bytes).toBe(0)
	})
})

describe('setupServer — connection drops', () => {
	it('reports a drop when the peer cuts the connection inside the window', async () => {
		const peer = net.createServer((socket) => socket.destroy())
		const loopback = track(await createLoopback(peer))
		expect(await probeConnectionDrop(loopback.port, 500)).toBe(true)
	})

	it('reports no drop when the peer holds the connection through the window', async () => {
		const peer = net.createServer((socket) => {
			opened.push(socket)
		})
		const loopback = track(await createLoopback(peer))
		expect(await probeConnectionDrop(loopback.port, 150)).toBe(false)
	})
})

describe('setupServer — loopback families', () => {
	it('agrees with a real bind on the family this host accepts', async () => {
		const loopback = track(await createLoopback(net.createServer()))
		expect(loopback.url).toBe(`http://127.0.0.1:${loopback.port}`)
		expect(await probeLoopback('127.0.0.1')).toBe(true)
	})

	it('refuses an address this host cannot bind', async () => {
		expect(await probeLoopback(UNBINDABLE_HOST)).toBe(false)
	})
})

describe('setupServer — held upgrades', () => {
	it('completes the handshake and holds the socket until the peer cuts it', async () => {
		const handshakes = createRecorder<[string | undefined, unknown]>()
		const claimed: Duplex[] = []
		const loopback = track(await createLoopback(createUpgradePeer(handshakes, claimed)))
		const held = await holdUpgrade(loopback.port, '/ws')
		expect(handshakes.calls).toEqual([['/ws', 'aGVsZA==']])
		expect(held.done).toBe(false)
		requireValue(claimed.at(0), 'the peer claimed the upgrade').destroy()
		await held.closed
		await waitForCondition('the client socket is gone', () => held.done)
	})

	it('closes the client end on release, which the peer observes', async () => {
		const handshakes = createRecorder<[string | undefined, unknown]>()
		const claimed: Duplex[] = []
		const loopback = track(await createLoopback(createUpgradePeer(handshakes, claimed)))
		const held = await holdUpgrade(loopback.port)
		const departures = createRecorder<[]>()
		requireValue(claimed.at(0), 'the peer claimed the upgrade').once('end', departures.handler)
		held.release()
		await held.closed
		expect(held.done).toBe(true)
		await waitForCondition('the peer read the end of the client stream', () => {
			return departures.count === 1
		})
	})
})

describe('setupServer — upgrade outcomes', () => {
	it('reports a claim with the handshake status and merges the extra headers', async () => {
		const handshakes = createRecorder<[string | undefined, unknown]>()
		const loopback = track(await createLoopback(createUpgradePeer(handshakes, [])))
		const outcome = await upgradeRequest(loopback.url, '/ws', { 'Sec-WebSocket-Key': 'cHJvb2Y=' })
		expect(outcome).toEqual({ claimed: true, status: 101 })
		expect(handshakes.calls).toEqual([['/ws', 'cHJvb2Y=']])
	})

	it('reports no claim with the status when the peer answers as plain HTTP', async () => {
		const server = http.createServer()
		server.on('upgrade', (_request, socket) => {
			opened.push(socket)
			socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
		})
		const loopback = track(await createLoopback(server))
		expect(await upgradeRequest(loopback.url, '/ws')).toEqual({ claimed: false, status: 426 })
	})

	it('reports no claim without a status when the peer destroys the socket', async () => {
		const server = http.createServer()
		server.on('upgrade', (_request, socket) => socket.destroy())
		const loopback = track(await createLoopback(server))
		expect(await upgradeRequest(loopback.url, '/ws')).toEqual({ claimed: false, status: 0 })
	})
})
