import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { DispatcherInterface } from '@orkestrel/router'
import type { ConnectionStateFunction, ServerInterface, ServerOptions } from '@src/server'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { createDispatcher } from '@orkestrel/router'
import { createServer, HTTPError, openStream } from '@src/server'
import { createRecorder, waitForDelay } from '../../setup.js'
import { rawRequest, upgradeRequest } from '../../setupServer.js'

// src/server/Server.ts — the lifecycle facade over REAL node:http (no mocks,
// the node src:server project). Routing outcomes themselves are the router's
// own tests (PROPOSAL §9) — this suite covers what the server face OWNS:
// lifecycle, drain, upgrade fan-out, the built-in boundary, connection facts,
// and observability.

interface EchoState {
	readonly ip: string | undefined
	readonly encrypted: boolean
}

function echoDispatcher(): DispatcherInterface<EchoState> {
	const dispatcher = createDispatcher<EchoState>()
	dispatcher.add({ method: 'GET', path: '/ping', handler: () => new Response('pong') })
	return dispatcher
}

// A state-agnostic sibling of `echoDispatcher` for tests that exercise
// lifecycle/bind/drain/error mechanics and never read `context.state` — kept
// distinct so those sites' `state: () => undefined` stays honest instead of
// mismatching `EchoState`.
function pingDispatcher(): DispatcherInterface<undefined> {
	const dispatcher = createDispatcher<undefined>()
	dispatcher.add({ method: 'GET', path: '/ping', handler: () => new Response('pong') })
	return dispatcher
}

const running: { stop(): Promise<void> }[] = []

function track<T extends { stop(): Promise<void> }>(server: T): T {
	running.push(server)
	return server
}

afterEach(async () => {
	await Promise.all(running.splice(0).map((server) => server.stop().catch(() => undefined)))
})

describe('Server — lifecycle', () => {
	it('starts on an ephemeral port, serves a route, and reports listening', async () => {
		const server = track(
			createServer({
				dispatcher: echoDispatcher(),
				state: (c) => ({ ip: c.ip, encrypted: c.encrypted }),
			}),
		)
		expect(server.status).toBe('idle')
		const port = await server.start()
		expect(server.status).toBe('listening')
		expect(server.port).toBe(port)
		expect(server.id).toMatch(/[0-9a-f-]{36}/)
		const response = await fetch(`http://127.0.0.1:${port}/ping`)
		expect(await response.text()).toBe('pong')
	})

	it('transitions idle → listening → stopped and refuses start while listening', async () => {
		const server = track(createServer({ dispatcher: pingDispatcher(), state: () => undefined }))
		await server.start()
		await expect(server.start()).rejects.toThrow(/cannot start/)
		expect(server.status).toBe('listening')
	})

	it('destroy is idempotent and leaves the server stopped', async () => {
		const server = createServer({ dispatcher: pingDispatcher(), state: () => undefined })
		await server.start()
		await server.destroy()
		await server.destroy()
		expect(server.status).toBe('stopped')
		expect(server.port).toBeUndefined()
	})
})

describe('Server — construction guards', () => {
	it('throws when timeouts.headers exceeds timeouts.keepalive (the Slowloris guard)', () => {
		expect(() =>
			createServer({
				dispatcher: pingDispatcher(),
				state: () => undefined,
				timeouts: { headers: 5_000, keepalive: 1_000 },
			}),
		).toThrow(TypeError)
	})

	it('throws when drain / limit are not non-negative finite numbers', () => {
		expect(() =>
			createServer({ dispatcher: pingDispatcher(), state: () => undefined, drain: Number.NaN }),
		).toThrow(TypeError)
		expect(() =>
			createServer({ dispatcher: pingDispatcher(), state: () => undefined, limit: -1 }),
		).toThrow(TypeError)
	})
})

describe('Server — host/port bind', () => {
	it('binds the exact configured port and rejects a duplicate EADDRINUSE bind', async () => {
		const first = track(createServer({ dispatcher: pingDispatcher(), state: () => undefined }))
		const port = await first.start()
		const second = createServer({ dispatcher: pingDispatcher(), state: () => undefined, port })
		await expect(second.start()).rejects.toThrow(/EADDRINUSE/)
		expect(second.status).toBe('idle')
	})

	it('binds the configured host and is reachable on it', async () => {
		const server = track(
			createServer({ dispatcher: pingDispatcher(), state: () => undefined, host: '127.0.0.1' }),
		)
		const port = await server.start()
		const response = await fetch(`http://127.0.0.1:${port}/ping`)
		expect(await response.text()).toBe('pong')
	})

	it('defaults to an ephemeral port when none is configured', async () => {
		const server = track(createServer({ dispatcher: pingDispatcher(), state: () => undefined }))
		const port = await server.start()
		expect(port).toBeGreaterThan(0)
		expect(server.port).toBe(port)
	})
})

describe('Server — restart + idempotent lifecycle', () => {
	it('restarts after a stop and a fresh run is NOT born aborted', async () => {
		const dispatcher = createDispatcher<undefined>()
		dispatcher.add({
			method: 'GET',
			path: '/check',
			handler: (request) => new Response(request.signal.aborted ? 'aborted' : 'ok'),
		})
		const server = track(createServer({ dispatcher, state: () => undefined }))
		const first = await server.start()
		expect((await fetch(`http://127.0.0.1:${first}/check`)).status).toBe(200)
		await server.stop()
		expect(server.status).toBe('stopped')
		const second = await server.start()
		expect(server.status).toBe('listening')
		expect(second).toBeGreaterThan(0)
		const response = await fetch(`http://127.0.0.1:${second}/check`)
		expect(response.status).toBe(200)
		expect(await response.text()).toBe('ok')
	})

	it('stop() before start() is a safe no-op', async () => {
		const server = createServer({ dispatcher: pingDispatcher(), state: () => undefined })
		expect(server.status).toBe('idle')
		await expect(server.stop()).resolves.toBeUndefined()
		expect(server.status).toBe('idle')
	})

	it('double stop() is a no-op', async () => {
		const server = createServer({ dispatcher: pingDispatcher(), state: () => undefined })
		await server.start()
		await server.stop()
		expect(server.status).toBe('stopped')
		await expect(server.stop()).resolves.toBeUndefined()
		expect(server.status).toBe('stopped')
		expect(server.port).toBeUndefined()
	})

	it('destroy() while listening tears down without a prior stop, and the socket refuses new connections', async () => {
		const server = createServer({ dispatcher: pingDispatcher(), state: () => undefined })
		const port = await server.start()
		await server.destroy()
		expect(server.status).toBe('stopped')
		await expect(server.destroy()).resolves.toBeUndefined()
		await expect(fetch(`http://127.0.0.1:${port}/ping`)).rejects.toBeDefined()
	})
})

describe('Server — the stop signal reaches handlers', () => {
	it('a handler observing request.signal sees it fire on stop()', async () => {
		const dispatcher = createDispatcher<undefined>()
		let capturedSignal: AbortSignal | undefined
		let resolveEntered: () => void = () => undefined
		const entered = new Promise<void>((resolve) => {
			resolveEntered = resolve
		})
		dispatcher.add({
			method: 'GET',
			path: '/watch',
			handler: async (request) => {
				capturedSignal = request.signal
				// Observable gate — stop() below is only called once the handler is
				// provably in flight, instead of relying on a fixed-delay guess.
				resolveEntered()
				await waitForDelay(60)
				return new Response(request.signal.aborted ? 'aborted' : 'ok')
			},
		})
		const server = track(createServer({ dispatcher, state: () => undefined, drain: 500 }))
		const port = await server.start()
		const inflight = fetch(`http://127.0.0.1:${port}/watch`)
		await entered
		const stopping = server.stop()
		await waitForDelay(15)
		expect(capturedSignal?.aborted).toBe(true)
		await inflight
		await stopping
	})
})

describe('Server — setup-phase crash safety (built-in boundary encloses per-request setup)', () => {
	it('a throwing state function is caught by the boundary — 500, and the server still answers the next request', async () => {
		const dispatcher = createDispatcher<undefined>()
		dispatcher.add({ method: 'GET', path: '/ping', handler: () => new Response('pong') })
		const server = track(
			createServer({
				dispatcher,
				state: () => {
					throw new Error('state boom')
				},
			}),
		)
		const port = await server.start()
		const first = await fetch(`http://127.0.0.1:${port}/ping`)
		expect(first.status).toBe(500)
		expect(server.status).toBe('listening')
		const second = await fetch(`http://127.0.0.1:${port}/ping`)
		expect(second.status).toBe(500)
	})

	it('a malformed Host header never crashes the process — answered 400, and the server still answers the next request', async () => {
		const server = track(createServer({ dispatcher: pingDispatcher(), state: () => undefined }))
		const port = await server.start()
		const raw = await rawRequest(port, 'GET / HTTP/1.1\r\nHost: foo bar\r\n\r\n')
		expect(raw).toMatch(/^HTTP\/1\.1 400/)
		expect(raw).toContain('invalid request')
		const response = await fetch(`http://127.0.0.1:${port}/ping`)
		expect(response.status).toBe(200)
		expect(await response.text()).toBe('pong')
	})

	it('an escaping handler throw fires the error EVENT with the original error', async () => {
		const errors = createRecorder<readonly [unknown]>()
		const dispatcher = createDispatcher<undefined>()
		dispatcher.add({
			method: 'GET',
			path: '/boom',
			handler: () => {
				throw new Error('original boom')
			},
		})
		const server = track(createServer({ dispatcher, state: () => undefined }))
		server.emitter.on('error', errors.handler)
		const port = await server.start()
		const response = await fetch(`http://127.0.0.1:${port}/boom`)
		expect(response.status).toBe(500)
		expect(errors.count).toBe(1)
		const errorArg = errors.calls[0]?.[0]
		expect(errorArg).toBeInstanceOf(Error)
		expect(errorArg instanceof Error ? errorArg.message : undefined).toBe('original boom')
	})
})

describe('Server — connection facts', () => {
	it('threads a peer ip and encrypted: false over plaintext into state', async () => {
		const dispatcher = createDispatcher<EchoState>()
		dispatcher.add({
			method: 'GET',
			path: '/who',
			handler: (_request, context) => Response.json(context.state),
		})
		const server = track(
			createServer({
				dispatcher,
				state: (connection) => ({ ip: connection.ip, encrypted: connection.encrypted }),
			}),
		)
		const port = await server.start()
		const response = await fetch(`http://127.0.0.1:${port}/who`)
		const body = (await response.json()) as EchoState
		expect(typeof body.ip).toBe('string')
		expect(body.encrypted).toBe(false)
	})
})

describe('Server — context.body() caching', () => {
	it('caches the body so multiple middleware reads return the same value, read exactly once', async () => {
		// `body()` is a MiddlewareContext concern — the terminal
		// `dispatcher.handle(request, context.state)` only threads `state`, not
		// `context` itself (PROPOSAL §5.1), so only middleware can read the body.
		const dispatcher = createDispatcher<undefined>()
		dispatcher.add({ method: 'POST', path: '/echo', handler: () => new Response('ok') })
		let firstRead: unknown
		let secondRead: unknown
		const server = track(
			createServer({
				dispatcher,
				state: () => undefined,
				middleware: [
					async (request, context, next) => {
						firstRead = await context.body()
						return next(request)
					},
					async (request, context, next) => {
						// A second middleware reads it too — the same cached value, the
						// underlying stream is never read twice.
						secondRead = await context.body()
						return next(request)
					},
				],
			}),
		)
		const port = await server.start()
		const response = await fetch(`http://127.0.0.1:${port}/echo`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ n: 1 }),
		})
		expect(response.status).toBe(200)
		expect(firstRead).toEqual({ n: 1 })
		expect(secondRead).toEqual({ n: 1 })
		expect(firstRead).toBe(secondRead)
	})
})

describe('Server — concurrency', () => {
	it('serves 20 parallel requests against a slow handler — none dropped', async () => {
		const dispatcher = createDispatcher<undefined>()
		dispatcher.add({
			method: 'GET',
			path: '/echo/:id',
			handler: async (request) => {
				await waitForDelay(40)
				const id = new URL(request.url).pathname.split('/').pop()
				return new Response(id)
			},
		})
		const server = track(createServer({ dispatcher, state: () => undefined }))
		const port = await server.start()
		const ids = Array.from({ length: 20 }, (_value, index) => String(index))
		const bodies = await Promise.all(
			ids.map(async (id) => (await fetch(`http://127.0.0.1:${port}/echo/${id}`)).text()),
		)
		expect(bodies.sort((a, b) => Number(a) - Number(b))).toEqual(ids)
	})
})

describe('Server — graceful drain', () => {
	it('lets an in-flight slow handler finish, then refuses new requests', async () => {
		const dispatcher = createDispatcher<undefined>()
		dispatcher.add({
			method: 'GET',
			path: '/slow',
			handler: async () => {
				await waitForDelay(120)
				return new Response('done')
			},
		})
		const server = createServer({ dispatcher, state: () => undefined, drain: 2_000 })
		const port = await server.start()
		const inflight = fetch(`http://127.0.0.1:${port}/slow`)
		await waitForDelay(30)
		const stopping = server.stop()
		const response = await inflight
		expect(await response.text()).toBe('done')
		await stopping
		expect(server.status).toBe('stopped')
		await expect(fetch(`http://127.0.0.1:${port}/slow`)).rejects.toBeDefined()
	})

	it('forces closed after the drain deadline when a handler hangs', async () => {
		const dispatcher = createDispatcher<undefined>()
		dispatcher.add({
			method: 'GET',
			path: '/hang',
			handler: async () => {
				await waitForDelay(10_000)
				return new Response('never')
			},
		})
		const server = createServer({ dispatcher, state: () => undefined, drain: 40 })
		const port = await server.start()
		const inflight = fetch(`http://127.0.0.1:${port}/hang`).catch((error: unknown) => error)
		await waitForDelay(20)
		await server.stop()
		expect(server.status).toBe('stopped')
		await inflight
	})
})

describe('Server — boundary mapping', () => {
	it('maps a thrown HTTPError to its status + message', async () => {
		const dispatcher = createDispatcher<undefined>()
		dispatcher.add({
			method: 'GET',
			path: '/boom',
			handler: () => {
				throw new HTTPError(404, 'not here')
			},
		})
		const server = track(createServer({ dispatcher, state: () => undefined }))
		const port = await server.start()
		const response = await fetch(`http://127.0.0.1:${port}/boom`)
		expect(response.status).toBe(404)
		expect(await response.text()).toBe('not here')
	})

	it('a thrown HTTPError is silent — no error EVENT and no report call', async () => {
		const errors = createRecorder<readonly [unknown]>()
		const reports = createRecorder<readonly [unknown]>()
		const dispatcher = createDispatcher<undefined>()
		dispatcher.add({
			method: 'GET',
			path: '/boom',
			handler: () => {
				throw new HTTPError(404, 'not found')
			},
		})
		const server = track(
			createServer({
				dispatcher,
				state: () => undefined,
				report: reports.handler,
			}),
		)
		server.emitter.on('error', errors.handler)
		const port = await server.start()
		const response = await fetch(`http://127.0.0.1:${port}/boom`)
		expect(response.status).toBe(404)
		expect(await response.text()).toBe('not found')
		expect(errors.count).toBe(0)
		expect(reports.count).toBe(0)
	})

	it('maps any other throw to a 500 with a hidden message by default', async () => {
		const dispatcher = createDispatcher<undefined>()
		dispatcher.add({
			method: 'GET',
			path: '/boom',
			handler: () => {
				throw new Error('secret internals')
			},
		})
		const server = track(createServer({ dispatcher, state: () => undefined }))
		const port = await server.start()
		const response = await fetch(`http://127.0.0.1:${port}/boom`)
		expect(response.status).toBe(500)
		expect(await response.text()).not.toContain('secret internals')
	})

	it('exposes the real message when expose is true', async () => {
		const dispatcher = createDispatcher<undefined>()
		dispatcher.add({
			method: 'GET',
			path: '/boom',
			handler: () => {
				throw new Error('visible internals')
			},
		})
		const server = track(createServer({ dispatcher, state: () => undefined, expose: true }))
		const port = await server.start()
		const response = await fetch(`http://127.0.0.1:${port}/boom`)
		expect(response.status).toBe(500)
		expect(await response.text()).toContain('visible internals')
	})

	it('invokes report and swallows its own throw', async () => {
		const reports = createRecorder<readonly [unknown]>()
		const dispatcher = createDispatcher<undefined>()
		dispatcher.add({
			method: 'GET',
			path: '/boom',
			handler: () => {
				throw new Error('reported')
			},
		})
		const server = track(
			createServer({
				dispatcher,
				state: () => undefined,
				report: (error) => {
					reports.handler(error)
					throw new Error('reporting sink itself throws')
				},
			}),
		)
		const port = await server.start()
		const response = await fetch(`http://127.0.0.1:${port}/boom`)
		expect(response.status).toBe(500)
		expect(reports.count).toBe(1)
	})
})

describe('Server — lifecycle + emit safety', () => {
	it('fires start / request / stop / drain through the emitter', async () => {
		const starts = createRecorder<readonly [number]>()
		const requests = createRecorder<readonly [string, string]>()
		const stops = createRecorder<readonly []>()
		const drains = createRecorder<readonly [number]>()
		const server = track(
			createServer({
				dispatcher: pingDispatcher(),
				state: () => undefined,
				on: {
					start: starts.handler,
					request: requests.handler,
					stop: stops.handler,
					drain: drains.handler,
				},
			}),
		)
		const port = await server.start()
		await fetch(`http://127.0.0.1:${port}/ping`)
		await server.stop()
		expect(starts.calls[0]?.[0]).toBe(port)
		expect(requests.calls).toContainEqual(['GET', '/ping'])
		expect(stops.count).toBe(1)
		expect(drains.count).toBe(1)
	})

	it('a throwing observer cannot crash the server and routes to the error option', async () => {
		const errors = createRecorder<readonly [unknown, string]>()
		const server = track(
			createServer({ dispatcher: pingDispatcher(), state: () => undefined, error: errors.handler }),
		)
		server.emitter.on('request', () => {
			throw new Error('bad observer')
		})
		const port = await server.start()
		const response = await fetch(`http://127.0.0.1:${port}/ping`)
		expect(await response.text()).toBe('pong')
		expect(errors.count).toBeGreaterThanOrEqual(1)
		expect(errors.calls[0]?.[1]).toBe('request')
	})
})

describe('Server — response event', () => {
	it('fires exactly once per request with method/pathname/status and a non-negative ms, on success', async () => {
		const responses = createRecorder<
			readonly [
				{
					readonly method: string
					readonly pathname: string
					readonly status: number
					readonly ms: number
				},
			]
		>()
		const server = track(createServer({ dispatcher: pingDispatcher(), state: () => undefined }))
		server.emitter.on('response', responses.handler)
		const port = await server.start()
		const response = await fetch(`http://127.0.0.1:${port}/ping`)
		expect(response.status).toBe(200)
		expect(responses.count).toBe(1)
		const event = responses.calls[0]?.[0]
		expect(event?.method).toBe('GET')
		expect(event?.pathname).toBe('/ping')
		expect(event?.status).toBe(200)
		expect(event?.ms).toBeGreaterThanOrEqual(0)
	})

	it('fires exactly once per request on the error/boundary path too, with the mapped status', async () => {
		const responses = createRecorder<
			readonly [
				{
					readonly method: string
					readonly pathname: string
					readonly status: number
					readonly ms: number
				},
			]
		>()
		const dispatcher = createDispatcher<undefined>()
		dispatcher.add({
			method: 'GET',
			path: '/boom',
			handler: () => {
				throw new Error('boundary boom')
			},
		})
		const server = track(createServer({ dispatcher, state: () => undefined }))
		server.emitter.on('response', responses.handler)
		const port = await server.start()
		const response = await fetch(`http://127.0.0.1:${port}/boom`)
		expect(response.status).toBe(500)
		expect(responses.count).toBe(1)
		const event = responses.calls[0]?.[0]
		expect(event?.method).toBe('GET')
		expect(event?.pathname).toBe('/boom')
		expect(event?.status).toBe(500)
		expect(event?.ms).toBeGreaterThanOrEqual(0)
	})
})

describe('Server — error/report request context', () => {
	it('a non-HTTPError throw carries { method, url } to both the error event and the report sink', async () => {
		const errors =
			createRecorder<
				readonly [unknown, { readonly method: string; readonly url: URL } | undefined]
			>()
		const reports =
			createRecorder<
				readonly [unknown, { readonly method: string; readonly url: URL } | undefined]
			>()
		const dispatcher = createDispatcher<undefined>()
		dispatcher.add({
			method: 'GET',
			path: '/boom',
			handler: () => {
				throw new Error('context boom')
			},
		})
		const server = track(
			createServer({ dispatcher, state: () => undefined, report: reports.handler }),
		)
		server.emitter.on('error', errors.handler)
		const port = await server.start()
		const response = await fetch(`http://127.0.0.1:${port}/boom`)
		expect(response.status).toBe(500)
		expect(errors.count).toBe(1)
		expect(reports.count).toBe(1)
		const errorRequest = errors.calls[0]?.[1]
		expect(errorRequest?.method).toBe('GET')
		expect(errorRequest?.url).toBeInstanceOf(URL)
		expect(errorRequest?.url.pathname).toBe('/boom')
		const reportRequest = reports.calls[0]?.[1]
		expect(reportRequest?.method).toBe('GET')
		expect(reportRequest?.url).toBeInstanceOf(URL)
		expect(reportRequest?.url.pathname).toBe('/boom')
	})
})

describe('Server — upgrade seam', () => {
	it('fans a raw upgrade out to a handler that claims the socket', async () => {
		const upgrades = createRecorder<readonly [IncomingMessage, boolean]>()
		let seen: { request: IncomingMessage; socket: Duplex; head: Buffer } | undefined
		const server = track(createServer({ dispatcher: pingDispatcher(), state: () => undefined }))
		server.emitter.on('upgrade', upgrades.handler)
		server.upgrade((request, socket, head) => {
			seen = { request, socket, head }
			socket.write(
				'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
			)
			socket.end()
			return true
		})
		const port = await server.start()
		const outcome = await upgradeRequest(`http://127.0.0.1:${port}`, '/ws', {
			'Sec-WebSocket-Key': 'abc123',
		})
		expect(outcome.claimed).toBe(true)
		expect(outcome.status).toBe(101)
		expect(seen?.request.url).toBe('/ws')
		expect(Buffer.isBuffer(seen?.head)).toBe(true)
		expect(upgrades.count).toBe(1)
		expect(upgrades.calls[0]?.[1]).toBe(true)
	})

	it('destroys the socket and fires upgrade(handled: false) with no handlers', async () => {
		const upgrades = createRecorder<readonly [IncomingMessage, boolean]>()
		const server = track(createServer({ dispatcher: pingDispatcher(), state: () => undefined }))
		server.emitter.on('upgrade', upgrades.handler)
		const port = await server.start()
		const outcome = await upgradeRequest(`http://127.0.0.1:${port}`)
		expect(outcome.claimed).toBe(false)
		expect(upgrades.count).toBe(1)
		expect(upgrades.calls[0]?.[1]).toBe(false)
	})

	it('a declining handler is skipped and a later handler claims', async () => {
		const order: string[] = []
		const server = track(createServer({ dispatcher: pingDispatcher(), state: () => undefined }))
		server.upgrade(() => {
			order.push('decline')
			return false
		})
		server.upgrade((_request, socket) => {
			order.push('claim')
			socket.write(
				'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
			)
			socket.end()
			return true
		})
		const port = await server.start()
		const outcome = await upgradeRequest(`http://127.0.0.1:${port}`, '/ws')
		expect(outcome.claimed).toBe(true)
		expect(order).toEqual(['decline', 'claim'])
	})

	it('first claimer wins — a later handler never runs', async () => {
		const order: string[] = []
		const server = track(createServer({ dispatcher: pingDispatcher(), state: () => undefined }))
		server.upgrade((_request, socket) => {
			order.push('first')
			socket.write(
				'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
			)
			socket.end()
			return true
		})
		server.upgrade(() => {
			order.push('second')
			return true
		})
		const port = await server.start()
		const outcome = await upgradeRequest(`http://127.0.0.1:${port}`, '/ws')
		expect(outcome.claimed).toBe(true)
		expect(order).toEqual(['first'])
	})

	it('a throwing handler is treated as declined — the next one still claims and the server survives', async () => {
		const order: string[] = []
		const errors = createRecorder<readonly [unknown]>()
		const server = track(createServer({ dispatcher: pingDispatcher(), state: () => undefined }))
		server.emitter.on('error', errors.handler)
		server.upgrade(() => {
			order.push('throw')
			throw new Error('upgrade boom')
		})
		server.upgrade((_request, socket) => {
			order.push('claim')
			socket.write(
				'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
			)
			socket.end()
			return true
		})
		const port = await server.start()
		const outcome = await upgradeRequest(`http://127.0.0.1:${port}`, '/ws')
		expect(outcome.claimed).toBe(true)
		expect(order).toEqual(['throw', 'claim'])
		expect(errors.count).toBe(1)
		expect(errors.calls[0]?.[0]).toBeInstanceOf(Error)
		const response = await fetch(`http://127.0.0.1:${port}/ping`)
		expect(await response.text()).toBe('pong')
	})

	it('a sole handler that declines cleanly (returns false, no throw) — the socket is destroyed', async () => {
		const upgrades = createRecorder<readonly [IncomingMessage, boolean]>()
		const server = track(createServer({ dispatcher: pingDispatcher(), state: () => undefined }))
		server.emitter.on('upgrade', upgrades.handler)
		server.upgrade(() => false)
		const port = await server.start()
		const outcome = await upgradeRequest(`http://127.0.0.1:${port}`, '/nope')
		expect(outcome.claimed).toBe(false)
		expect(upgrades.count).toBe(1)
		expect(upgrades.calls[0]?.[1]).toBe(false)
	})

	it('a sole throwing handler declines — the socket is destroyed and upgrade fires handled: false', async () => {
		const upgrades = createRecorder<readonly [IncomingMessage, boolean]>()
		const errors = createRecorder<readonly [unknown]>()
		const server = track(createServer({ dispatcher: pingDispatcher(), state: () => undefined }))
		server.emitter.on('upgrade', upgrades.handler)
		server.emitter.on('error', errors.handler)
		server.upgrade(() => {
			throw new Error('sole boom')
		})
		const port = await server.start()
		const outcome = await upgradeRequest(`http://127.0.0.1:${port}`, '/nope')
		expect(outcome.claimed).toBe(false)
		expect(errors.count).toBe(1)
		expect(upgrades.count).toBe(1)
		expect(upgrades.calls[0]?.[1]).toBe(false)
	})
})

// ── Type-level: ServerOptions / ServerInterface TState flow ──────────────────

describe('ServerOptions<TState> / ServerInterface<TState> — TState flow', () => {
	it('threads TState from ServerOptions.state into the dispatcher and middleware', () => {
		interface AppState {
			readonly userId: string
		}
		expectTypeOf<ServerOptions<AppState>['dispatcher']>().toEqualTypeOf<
			DispatcherInterface<AppState>
		>()
		expectTypeOf<ServerOptions<AppState>['state']>().toEqualTypeOf<
			ConnectionStateFunction<AppState>
		>()
		expectTypeOf<ServerInterface<AppState>['dispatcher']>().toEqualTypeOf<
			DispatcherInterface<AppState>
		>()
	})

	it('exposes id, status, port, dispatcher, emitter, use, upgrade, start, stop, destroy', () => {
		expectTypeOf<ServerInterface<undefined>>().toHaveProperty('id')
		expectTypeOf<ServerInterface<undefined>>().toHaveProperty('status')
		expectTypeOf<ServerInterface<undefined>>().toHaveProperty('port')
		expectTypeOf<ServerInterface<undefined>>().toHaveProperty('dispatcher')
		expectTypeOf<ServerInterface<undefined>>().toHaveProperty('emitter')
		expectTypeOf<ServerInterface<undefined>['use']>().toBeFunction()
		expectTypeOf<ServerInterface<undefined>['upgrade']>().toBeFunction()
		expectTypeOf<ServerInterface<undefined>['start']>().returns.toEqualTypeOf<Promise<number>>()
		expectTypeOf<ServerInterface<undefined>['stop']>().returns.toEqualTypeOf<Promise<void>>()
		expectTypeOf<ServerInterface<undefined>['destroy']>().returns.toEqualTypeOf<Promise<void>>()
	})

	it('createServer returns a ServerInterface<TState> matching its options', () => {
		interface AppState {
			readonly userId: string
		}
		const dispatcher = createDispatcher<AppState>()
		const server = createServer<AppState>({ dispatcher, state: () => ({ userId: 'me' }) })
		expectTypeOf(server).toEqualTypeOf<ServerInterface<AppState>>()
	})
})

// ── Capstone: one end-to-end round-trip over a real socket ───────────────────

describe('Server — capstone', () => {
	interface AppState {
		userId?: string
	}

	it('middleware state + response post-processing, a dispatcher route reading params + state, over a real fetch round-trip', async () => {
		const dispatcher = createDispatcher<AppState>()
		dispatcher.add({
			method: 'GET',
			path: '/users/:id',
			handler: (_request, context) =>
				Response.json({ id: context.params.id, userId: context.state.userId }),
		})
		const server = track(
			createServer<AppState>({
				dispatcher,
				state: () => ({}),
				middleware: [
					async (request, context, next) => {
						context.state.userId = 'capstone-user'
						const response = await next(request)
						response.headers.set('x-capstone', 'yes')
						return response
					},
				],
			}),
		)
		const port = await server.start()
		const response = await fetch(`http://127.0.0.1:${port}/users/7`)
		expect(response.status).toBe(200)
		expect(response.headers.get('x-capstone')).toBe('yes')
		const body = (await response.json()) as { readonly id: string; readonly userId?: string }
		expect(body).toEqual({ id: '7', userId: 'capstone-user' })
	})

	it('a thrown HTTPError surfaces the boundary mapping through the wire, even behind middleware', async () => {
		const dispatcher = createDispatcher<AppState>()
		dispatcher.add({
			method: 'GET',
			path: '/users/:id',
			handler: () => {
				throw new HTTPError(404, 'user not found')
			},
		})
		const server = track(
			createServer<AppState>({
				dispatcher,
				state: () => ({}),
				middleware: [async (request, context, next) => next(request)],
			}),
		)
		const port = await server.start()
		const response = await fetch(`http://127.0.0.1:${port}/users/missing`)
		expect(response.status).toBe(404)
		expect(await response.text()).toBe('user not found')
	})

	it('an SSE route via openStream is consumed incrementally by fetch', async () => {
		const dispatcher = createDispatcher<AppState>()
		dispatcher.add({
			method: 'GET',
			path: '/events',
			handler: () => {
				const stream = openStream()
				stream.write({ event: 'greeting', data: 'hello' })
				void waitForDelay(30).then(() => {
					stream.write({ event: 'greeting', data: 'world' })
					stream.end()
				})
				return stream.response
			},
		})
		const server = track(createServer<AppState>({ dispatcher, state: () => ({}) }))
		const port = await server.start()
		const response = await fetch(`http://127.0.0.1:${port}/events`)
		expect(response.headers.get('content-type')).toContain('text/event-stream')
		const reader = response.body?.getReader()
		expect(reader).toBeDefined()
		const decoder = new TextDecoder()
		const reads: string[] = []
		let text = ''
		if (reader !== undefined) {
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				const chunk = decoder.decode(value)
				reads.push(chunk)
				text += chunk
			}
		}
		expect(reads.length).toBeGreaterThan(1)
		expect(text).toContain('event: greeting\ndata: hello\n\n')
		expect(text).toContain('event: greeting\ndata: world\n\n')
	})
})
