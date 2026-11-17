import type { LoopbackInterface } from '@orkestrel/test/server'
import type { Duplex } from 'node:stream'
import crypto, { createHmac } from 'node:crypto'
import { once } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRecorder, readProperty, requireValue, waitForCondition } from '@orkestrel/test'
import { createLoopback } from '@orkestrel/test/server'
import { decodeBase64URL } from '@orkestrel/codec'
import {
	connectServerClient,
	parseResponses,
	subtractServerListeners,
	buildMalformedSignatures,
	buildMalformedTokens,
	recordSignerCrypto,
	SignerOutage,
	trackLoopback,
	createRawPeer,
	createAnsweringPeer,
	createUpgradePeer,
	holdUpgrade,
	openPausedResponse,
	probeConnectionDrop,
	probeLoopback,
	probeSocketSends,
	rawRequest,
	BIG_BODY_BYTES,
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

/**
 * Build a raw TCP peer that records each complete request it reads and answers with one payload.
 *
 * @param requests - The recorder each complete request text is reported to.
 * @param answer - The bytes written back after a complete request arrives.
 * @returns The unbound server.
 */

/**
 * Build an HTTP peer that records the path of every request and answers it in full.
 *
 * @param paths - The recorder each request path is reported to.
 * @returns The unbound server.
 */

/**
 * Build an HTTP peer that claims every upgrade, records the handshake, and keeps the socket.
 *
 * @param handshakes - The recorder each upgrade's path and `Sec-WebSocket-Key` is reported to.
 * @param claimed - The live set of sockets the peer took over.
 * @returns The unbound server.
 */

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
		const loopback = trackLoopback(
			bound,
			await createLoopback(createRawPeer(opened, requests, RAW_ANSWER)),
		)
		const answer = await rawRequest(loopback.port, MALFORMED_REQUEST)
		expect(requests.calls).toEqual([[MALFORMED_REQUEST]])
		expect(answer).toBe(RAW_ANSWER)
	})
})

describe('setupServer — paused responses', () => {
	it('parks the answer bytes until the reader resumes', async () => {
		const paths = createRecorder<[string | undefined]>()
		const loopback = trackLoopback(bound, await createLoopback(createAnsweringPeer(paths)))
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
		const loopback = trackLoopback(bound, await createLoopback(createAnsweringPeer(paths)))
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
		const loopback = trackLoopback(bound, await createLoopback(peer))
		expect(await probeConnectionDrop(loopback.port, 500)).toBe(true)
	})

	it('reports no drop when the peer holds the connection through the window', async () => {
		const peer = net.createServer((socket) => {
			opened.push(socket)
		})
		const loopback = trackLoopback(bound, await createLoopback(peer))
		expect(await probeConnectionDrop(loopback.port, 150)).toBe(false)
	})
})

describe('setupServer — loopback families', () => {
	it('agrees with a real bind on the family this host accepts', async () => {
		const loopback = trackLoopback(bound, await createLoopback(net.createServer()))
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
		const loopback = trackLoopback(
			bound,
			await createLoopback(createUpgradePeer(opened, handshakes, claimed)),
		)
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
		const loopback = trackLoopback(
			bound,
			await createLoopback(createUpgradePeer(opened, handshakes, claimed)),
		)
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
		const loopback = trackLoopback(
			bound,
			await createLoopback(createUpgradePeer(opened, handshakes, [])),
		)
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
		const loopback = trackLoopback(bound, await createLoopback(server))
		expect(await upgradeRequest(loopback.url, '/ws')).toEqual({ claimed: false, status: 426 })
	})

	it('reports no claim without a status when the peer destroys the socket', async () => {
		const server = http.createServer()
		server.on('upgrade', (_request, socket) => socket.destroy())
		const loopback = trackLoopback(bound, await createLoopback(server))
		expect(await upgradeRequest(loopback.url, '/ws')).toEqual({ claimed: false, status: 0 })
	})
})

describe('parseResponses', () => {
	it('frames a HEAD response and a 204 at the blank line whatever their framing headers say', () => {
		const bytes = Buffer.from(
			'HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nHTTP/1.1 204 No Content\r\nContent-Length: 3\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok',
		)
		expect(parseResponses(bytes, false, ['HEAD', 'DELETE', 'GET'])).toEqual([
			{ status: 200, headers: { 'content-length': '5' }, body: '', complete: true },
			{ status: 204, headers: { 'content-length': '3' }, body: '', complete: true },
			{ status: 200, headers: { 'content-length': '2' }, body: 'ok', complete: true },
		])
	})

	it('frames an interim 100 as answering the same request as the response after it', () => {
		const bytes = Buffer.from(
			'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nokHTTP/1.1 200 OK\r\n\r\n',
		)
		expect(
			parseResponses(bytes, false, ['POST', 'HEAD']).map((response) => [
				response.status,
				response.body,
				response.complete,
			]),
		).toEqual([
			[100, '', true],
			[200, 'ok', true],
			[200, '', true],
		])
	})

	it('decodes a chunked body through its trailer section, and holds an unfinished one incomplete', () => {
		const whole = Buffer.from(
			'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\nX-Sum: 5\r\n\r\n',
		)
		const cut = Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n')
		expect(
			parseResponses(whole, false, []).map((response) => [response.body, response.complete]),
		).toEqual([['abcde', true]])
		expect(
			parseResponses(cut, false, []).map((response) => [response.body, response.complete]),
		).toEqual([['abc', false]])
	})

	it('completes a close-delimited body only after the connection closed', () => {
		const bytes = Buffer.from('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nrest')
		expect(parseResponses(bytes, false, []).map((response) => response.complete)).toEqual([false])
		expect(
			parseResponses(bytes, true, []).map((response) => [response.body, response.complete]),
		).toEqual([['rest', true]])
	})

	it('frames nothing from bytes that hold no complete header block', () => {
		expect(parseResponses(Buffer.from('HTTP/1.1 200 OK\r\nContent-Le'), false, [])).toEqual([])
	})
})

describe('ServerRawClient', () => {
	it('reads the framing class and the close of what a real peer answered', async () => {
		const loopback = trackLoopback(
			bound,
			await createLoopback(http.createServer((_request, response) => response.end('ok'))),
		)
		const client = await connectServerClient(loopback.port, ['GET'])
		try {
			client.write('GET / HTTP/1.1\r\nHost: x\r\nX-Folded: a\r\n b\r\n\r\n')
			expect(await client.classify(1, 'the folded request')).toEqual({
				statuses: [400],
				closed: true,
			})
		} finally {
			client.destroy()
		}
	})

	it('resets the connection so the peer socket reads ECONNRESET', async () => {
		const failures = createRecorder<readonly [unknown]>()
		const requests = createRecorder<readonly []>()
		const loopback = trackLoopback(
			bound,
			await createLoopback(
				http.createServer((request) => {
					request.socket.on('error', failures.handler)
					requests.handler()
				}),
			),
		)
		const client = await connectServerClient(loopback.port, ['GET'])
		client.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n')
		await waitForCondition('the peer reads the request', () => requests.count > 0)
		client.reset()
		await client.ended
		await waitForCondition('the peer reads the reset', () => failures.count > 0)
		expect(failures.calls[0]?.[0]).toMatchObject({ code: 'ECONNRESET' })
	})

	it('reports the error code a bare socket reads from the same peer reset as its fault', async () => {
		const peer = net.createServer((socket) => socket.resetAndDestroy())
		const loopback = trackLoopback(bound, await createLoopback(peer))
		const codes = createRecorder<readonly [unknown]>()
		const bare = net.createConnection({ port: loopback.port, host: '127.0.0.1' })
		opened.push(bare)
		bare.on('error', (error) => codes.handler(readProperty<unknown>(error, 'code')))
		const client = await connectServerClient(loopback.port)
		opened.push(client)
		await client.ended
		await waitForCondition('the bare socket closes', () => bare.closed)
		expect(codes.calls).toEqual([[expect.any(String)]])
		expect(client.fault).toBe(codes.calls[0]?.[0])
	})

	it('reports no fault when the peer closes with a FIN', async () => {
		const peer = net.createServer((socket) => socket.end())
		const loopback = trackLoopback(bound, await createLoopback(peer))
		const client = await connectServerClient(loopback.port)
		opened.push(client)
		await client.ended
		expect(client.closed).toBe(true)
		expect(client.fault).toBeUndefined()
	})
})

describe('probeSocketSends', () => {
	it('counts every send a paused peer absorbs up to the limit', async () => {
		expect(await probeSocketSends(1, 3)).toBe(3)
	})

	it('stops at the first send a paused peer leaves held, which the peer drains after it resumes', async () => {
		const limit = 8
		const sends = await probeSocketSends(BIG_BODY_BYTES, limit)
		expect(sends).toBeLessThan(limit)
		const accepted = Promise.withResolvers<net.Socket>()
		const loopback = trackLoopback(
			bound,
			await createLoopback(net.createServer((socket) => accepted.resolve(socket))),
		)
		const client = net.createConnection({ port: loopback.port, host: '127.0.0.1' })
		opened.push(client)
		client.on('error', () => undefined)
		client.pause()
		await once(client, 'connect')
		const socket = await accepted.promise
		opened.push(socket)
		for (const index of Array.from({ length: sends }, (_, position) => position)) {
			socket.write(Buffer.alloc(BIG_BODY_BYTES))
			await waitForCondition(`send ${index} flushes`, () => socket.writableLength === 0)
		}
		socket.write(Buffer.alloc(BIG_BODY_BYTES))
		await expect(
			waitForCondition('the held send flushes', () => socket.writableLength === 0, {
				budget: 600,
			}),
		).rejects.toThrow('the held send flushes')
		client.resume()
		await waitForCondition('the resumed peer drains the held send', () => {
			return socket.writableLength === 0
		})
	})
})

describe('subtractServerListeners', () => {
	it('keeps each event either side holds', () => {
		expect(subtractServerListeners({ close: 3, end: 1 }, { close: 1, finish: 1 })).toEqual({
			close: 2,
			end: 1,
			finish: -1,
		})
	})
})

describe('setupServer — signer fixtures', () => {
	const valid = createHmac('sha256', 'fixture-secret').update('fixture').digest('base64url')

	it('builds only signatures that do not decode to the 32 bytes of an HMAC-SHA256', () => {
		const cases = buildMalformedSignatures(valid)
		expect(decodeBase64URL(valid)?.byteLength).toBe(32)
		expect(cases.filter(({ signature }) => decodeBase64URL(signature)?.byteLength === 32)).toEqual(
			[],
		)
	})

	it('builds malformed tokens over the valid token it was given', () => {
		const cases = buildMalformedTokens(`payload.${valid}`)
		expect(cases.map(({ token }) => token)).toContain(`payloadx.${valid}`)
		expect(cases.map(({ token }) => token)).not.toContain(`payload.${valid}`)
	})

	it('records calls to the wrapped export while the run lasts, and restores the export after', async () => {
		const before = crypto.createHmac
		const { value, calls } = await recordSignerCrypto('createHmac', async () =>
			createHmac('sha256', 'fixture-secret').update('fixture').digest('base64url'),
		)
		createHmac('sha256', 'outside').digest()
		expect([value, calls.map(([algorithm, key]) => [algorithm, key])]).toEqual([
			valid,
			[['sha256', 'fixture-secret']],
		])
		expect(crypto.createHmac).toBe(before)
	})

	it('builds an outage signer whose sign resolves and whose verify rejects with the reason', async () => {
		const outage = new SignerOutage('key service unavailable')
		await expect(outage.sign()).resolves.toBe('signature')
		await expect(outage.verify()).rejects.toThrow('key service unavailable')
	})

	it('restores the export when the run rejects', async () => {
		const before = crypto.createSecretKey
		await expect(
			recordSignerCrypto('createSecretKey', async () => Promise.reject(new Error('run failed'))),
		).rejects.toThrow('run failed')
		expect(crypto.createSecretKey).toBe(before)
	})
})
