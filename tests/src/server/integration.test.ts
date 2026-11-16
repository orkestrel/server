import type { Connection, MiddlewareContext } from '@src/server'
import http from 'node:http'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createDispatcher } from '@orkestrel/router'
import { createServer, isServerError } from '@src/server'
import { createRecorder, waitForCondition } from '@orkestrel/test'
import { createLoopback } from '@orkestrel/test/server'
import {
	SEAM_BODY,
	SEAM_IMMUTABLE_RESPONSES,
	SEAM_NEXT_ARGUMENTS,
	SEAM_STATE_FACTORIES,
	ServerObservation,
	createAbortLayer,
	createAnsweringPeer,
	createArgumentLayer,
	createBodyLayer,
	countLiveObjects,
	createDeadlineLayer,
	createPingDispatcher,
	createResponseLayer,
	createSeamDispatcher,
	createSeenLayer,
	driveSeamRequests,
	sendSeamRequest,
	trackServer,
} from '../../setupServer.js'

// The exchange seam, driven through a real `Server` over real sockets. Every expectation comes from
// the declared seam contract: one `Request` per exchange, one context that carries `connection` and
// `abort`, a `next` that takes no argument, an in-flight registry of abort handles that `stop()`
// aborts, and response headers every layer can set.

const running: Array<{ stop(): Promise<void> }> = []

afterEach(async () => {
	await Promise.all(running.splice(0).map((server) => server.stop().catch(() => undefined)))
})

describe('the exchange seam — one Request per exchange', () => {
	it('aborts the request the terminal reads when a layer deadline passes', async () => {
		const requests: Request[] = []
		const server = trackServer(
			running,
			createServer({
				dispatcher: createSeamDispatcher<object>(requests, Promise.resolve()),
				state: () => ({}),
				host: '127.0.0.1',
				middleware: [createDeadlineLayer(20)],
			}),
		)
		const port = await server.start()
		const response = await fetch(`http://127.0.0.1:${port}/hold`)
		expect(response.status).toBe(200)
		await expect(response.text()).resolves.toBe('deadline of 20 ms passed')
		const reason: unknown = requests[0]?.signal.reason
		expect(reason).toBeInstanceOf(DOMException)
		expect(reason instanceof DOMException ? reason.name : undefined).toBe('TimeoutError')
	})

	it('reads the body behind a deadline layer, so fit finding F1 answers 200', async () => {
		const server = trackServer(
			running,
			createServer({
				dispatcher: createSeamDispatcher<object>([], Promise.resolve()),
				state: () => ({}),
				host: '127.0.0.1',
				middleware: [createDeadlineLayer(5_000), createBodyLayer()],
			}),
		)
		const port = await server.start()
		const response = await fetch(`http://127.0.0.1:${port}/a`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: SEAM_BODY,
		})
		expect(response.status).toBe(200)
		await expect(response.json()).resolves.toEqual({ body: { item: 'lamp' } })
	})

	it('hands every layer and the terminal one request and one context', async () => {
		const requests: Request[] = []
		const seen: Array<readonly [Request, MiddlewareContext<object>]> = []
		const server = trackServer(
			running,
			createServer({
				dispatcher: createSeamDispatcher<object>(requests, Promise.resolve()),
				state: () => ({}),
				host: '127.0.0.1',
				middleware: [createSeenLayer(seen), createSeenLayer(seen), createSeenLayer(seen)],
			}),
		)
		const port = await server.start()
		const response = await fetch(`http://127.0.0.1:${port}/plain`)
		await expect(response.text()).resolves.toBe('plain')
		expect(requests).toHaveLength(1)
		expect(seen).toHaveLength(3)
		const [terminal] = requests
		const context = seen[0]?.[1]
		expect(seen.every(([request]) => request === terminal)).toBe(true)
		expect(seen.every(([, layer]) => layer === context)).toBe(true)
	})
})

describe('the exchange seam — next takes no argument', () => {
	it.each(SEAM_NEXT_ARGUMENTS)(
		'refuses $label with a ServerError of code NEXT, and the client reads the 500',
		async ({ build }) => {
			const requests: Request[] = []
			const refusal = new ServerObservation<unknown>(undefined)
			const server = trackServer(
				running,
				createServer({
					dispatcher: createSeamDispatcher<object>(requests, Promise.resolve()),
					state: () => ({}),
					host: '127.0.0.1',
					middleware: [createArgumentLayer(build, refusal)],
				}),
			)
			const port = await server.start()
			const response = await fetch(`http://127.0.0.1:${port}/a`, {
				method: 'POST',
				body: 'original body',
			})
			expect(response.status).toBe(500)
			await expect(response.text()).resolves.toBe('Internal Server Error')
			expect(isServerError(refusal.value)).toBe(true)
			expect(isServerError(refusal.value) ? refusal.value.code : undefined).toBe('NEXT')
			expect(requests).toHaveLength(0)
		},
	)

	it('continues to the terminal on a next() call with no argument', async () => {
		const seen: Array<readonly [Request, MiddlewareContext<object>]> = []
		const server = trackServer(
			running,
			createServer({
				dispatcher: createSeamDispatcher<object>([], Promise.resolve()),
				state: () => ({}),
				host: '127.0.0.1',
				middleware: [createSeenLayer(seen)],
			}),
		)
		const port = await server.start()
		const response = await fetch(`http://127.0.0.1:${port}/a`, {
			method: 'POST',
			body: 'original body',
		})
		expect(response.status).toBe(200)
		await expect(response.text()).resolves.toBe('/a:original body')
	})
})

describe('the exchange seam — connection', () => {
	it.each(SEAM_STATE_FACTORIES)(
		'hands every layer the connection the state factory received, under $label',
		async ({ state }) => {
			const received: Connection[] = []
			const seen: Array<readonly [Request, MiddlewareContext<object>]> = []
			const server = trackServer(
				running,
				createServer({
					dispatcher: createSeamDispatcher<object>([], Promise.resolve()),
					state: (connection) => {
						received.push(connection)
						return state(connection)
					},
					host: '127.0.0.1',
					middleware: [createSeenLayer(seen), createSeenLayer(seen)],
				}),
			)
			const port = await server.start()
			await (await fetch(`http://127.0.0.1:${port}/plain`)).text()
			expect(received).toHaveLength(1)
			expect(seen).toHaveLength(2)
			expect(seen.every(([, context]) => context.connection === received[0])).toBe(true)
			expect(seen[0]?.[1].connection).toEqual({ ip: '127.0.0.1', encrypted: false })
		},
	)
})

describe('the exchange seam — abort', () => {
	it('aborts the request signal with the first reason, and a second call changes nothing', async () => {
		const requests: Request[] = []
		const first = new Error('first reason')
		const server = trackServer(
			running,
			createServer({
				dispatcher: createSeamDispatcher<object>(requests, Promise.resolve()),
				state: () => ({}),
				host: '127.0.0.1',
				middleware: [createAbortLayer('/hold', [first, new Error('second reason')])],
			}),
		)
		const port = await server.start()
		const response = await fetch(`http://127.0.0.1:${port}/hold`)
		await expect(response.text()).resolves.toBe('first reason')
		expect(requests[0]?.signal.reason).toBe(first)
	})

	it('aborts nothing on the next exchange of the same keep-alive connection', async () => {
		const requests: Request[] = []
		const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
		const server = trackServer(
			running,
			createServer({
				dispatcher: createSeamDispatcher<object>(requests, Promise.resolve()),
				state: () => ({}),
				host: '127.0.0.1',
				middleware: [createAbortLayer('/hold', ['aborted on purpose'])],
			}),
		)
		try {
			const port = await server.start()
			const aborted = await sendSeamRequest(port, '/hold', agent)
			const next = await sendSeamRequest(port, '/state', agent)
			expect(aborted).toEqual({ status: 200, body: 'aborted on purpose', reused: false })
			expect(next).toEqual({ status: 200, body: 'open', reused: true })
			expect(requests[1]?.signal.aborted).toBe(false)
		} finally {
			agent.destroy()
		}
	})

	it('aborts nothing on an exchange in flight beside it', async () => {
		const requests: Request[] = []
		const gate = Promise.withResolvers<void>()
		const server = trackServer(
			running,
			createServer({
				dispatcher: createSeamDispatcher<object>(requests, gate.promise),
				state: () => ({}),
				host: '127.0.0.1',
				middleware: [createAbortLayer('/hold', ['aborted on purpose'])],
			}),
		)
		const port = await server.start()
		const parked = fetch(`http://127.0.0.1:${port}/gate`).then(
			(reply) => reply.text(),
			(error: unknown) => error,
		)
		try {
			await waitForCondition('the /gate handler starts', () => requests.length === 1)
			const aborted = await fetch(`http://127.0.0.1:${port}/hold`)
			await expect(aborted.text()).resolves.toBe('aborted on purpose')
			expect(requests[0]?.signal.aborted).toBe(false)
		} finally {
			gate.resolve()
		}
		await expect(parked).resolves.toBe('open')
	})

	it('aborts the request signal when the peer disconnects', async () => {
		const requests: Request[] = []
		const server = trackServer(
			running,
			createServer({
				dispatcher: createSeamDispatcher<object>(requests, Promise.resolve()),
				state: () => ({}),
				host: '127.0.0.1',
			}),
		)
		const port = await server.start()
		const socket = net.createConnection({ port, host: '127.0.0.1' })
		socket.on('error', () => undefined)
		socket.write('GET /hold HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
		await waitForCondition('the /hold handler starts', () => requests.length === 1)
		expect(requests[0]?.signal.aborted).toBe(false)
		socket.destroy()
		await waitForCondition('the peer disconnect aborts the signal', () =>
			Boolean(requests[0]?.signal.aborted),
		)
	})
})

describe('the exchange seam — the in-flight registry', () => {
	it('aborts every in-flight exchange on stop(), and the drain then reports none pending', async () => {
		const requests: Request[] = []
		const drains = createRecorder<[number, number]>()
		const server = createServer({
			dispatcher: createSeamDispatcher<object>(requests, Promise.resolve()),
			state: () => ({}),
			host: '127.0.0.1',
			on: { drain: drains.handler },
		})
		const port = await server.start()
		const replies = ['/hold', '/hold', '/hold'].map((path) =>
			fetch(`http://127.0.0.1:${port}${path}`),
		)
		await waitForCondition('three /hold handlers start', () => requests.length === 3)
		await server.stop()
		const statuses = await Promise.all(replies.map(async (reply) => (await reply).status))
		expect(statuses).toEqual([200, 200, 200])
		expect(requests.every((request) => request.signal.aborted)).toBe(true)
		expect(drains.calls).toEqual([[0, 0]])
	})

	it('serves a request that arrives during the drain with its signal already aborted', async () => {
		const requests: Request[] = []
		const gate = Promise.withResolvers<void>()
		const server = createServer({
			dispatcher: createSeamDispatcher<object>(requests, gate.promise),
			state: () => ({}),
			host: '127.0.0.1',
			drain: 5_000,
		})
		const port = await server.start()
		const parked = fetch(`http://127.0.0.1:${port}/gate`).then(
			(reply) => reply.text(),
			(error: unknown) => error,
		)
		await waitForCondition('the /gate handler starts', () => requests.length === 1)
		const stopped = server.stop()
		try {
			const late = await fetch(`http://127.0.0.1:${port}/state`)
			await expect(late.text()).resolves.toBe('aborted')
		} finally {
			gate.resolve()
		}
		await expect(parked).resolves.toBe('aborted')
		await stopped
	})

	it('reports the exchanges the drain deadline cut as its pending count', async () => {
		const requests: Request[] = []
		const gate = Promise.withResolvers<void>()
		const drains = createRecorder<[number, number]>()
		const server = createServer({
			dispatcher: createSeamDispatcher<object>(requests, gate.promise),
			state: () => ({}),
			host: '127.0.0.1',
			drain: 50,
			on: { drain: drains.handler },
		})
		const port = await server.start()
		const replies = ['/gate', '/gate'].map((path) =>
			fetch(`http://127.0.0.1:${port}${path}`).catch((error: unknown) => error),
		)
		await waitForCondition('two /gate handlers start', () => requests.length === 2)
		await server.stop()
		gate.resolve()
		await Promise.all(replies)
		expect(drains.calls).toEqual([[2, 0]])
	})

	it('removes each completed exchange, so a later stop drains at once with none pending', async () => {
		const drains = createRecorder<[number, number]>()
		const agent = new http.Agent({ keepAlive: true, maxSockets: 2 })
		const server = createServer({
			dispatcher: createSeamDispatcher<object>([], Promise.resolve()),
			state: () => ({}),
			host: '127.0.0.1',
			drain: 5_000,
			on: { drain: drains.handler },
		})
		try {
			const port = await server.start()
			const replies = await Promise.all(
				['/plain', '/plain', '/state', '/plain', '/state'].map((path) =>
					sendSeamRequest(port, path, agent),
				),
			)
			expect(replies.map((reply) => reply.status)).toEqual([200, 200, 200, 200, 200])
			const started = performance.now()
			await server.stop()
			expect(performance.now() - started).toBeLessThan(5_000)
			expect(drains.calls).toEqual([[0, 0]])
		} finally {
			agent.destroy()
		}
	})
})

describe('the exchange seam — retention', () => {
	it('keeps nothing per request reachable after the exchanges complete', async () => {
		const agent = new http.Agent({ keepAlive: true, maxSockets: 4 })
		const server = trackServer(
			running,
			createServer({
				dispatcher: createPingDispatcher(),
				state: () => undefined,
				host: '127.0.0.1',
			}),
		)
		try {
			const port = await server.start()
			expect(await driveSeamRequests(port, '/ping', 500, agent)).toBe(0)
			const before = await countLiveObjects()
			expect(await driveSeamRequests(port, '/ping', 3_000, agent)).toBe(0)
			const after = await countLiveObjects()
			// Anything a request leaves reachable keeps at least one object per request; the bar is half.
			expect(after - before).toBeLessThan(1_500)
		} finally {
			agent.destroy()
		}
	})
})

describe('the exchange seam — response normalization', () => {
	it.each(SEAM_IMMUTABLE_RESPONSES)(
		'hands $label to every layer with headers it can set, and keeps its fields',
		async ({ respond, status, location, body }) => {
			const paths = createRecorder<[string | undefined]>()
			const peer = await createLoopback(createAnsweringPeer(paths))
			const seen: Response[] = []
			const dispatcher = createDispatcher<object>()
			dispatcher.add({
				method: 'GET',
				path: '/respond',
				handler: (request) => respond(request, peer.url),
			})
			const server = trackServer(
				running,
				createServer({
					dispatcher,
					state: () => ({}),
					host: '127.0.0.1',
					middleware: [createResponseLayer(seen, 'x-outer'), createResponseLayer(seen, 'x-inner')],
				}),
			)
			try {
				const port = await server.start()
				const response = await fetch(`http://127.0.0.1:${port}/respond`, { redirect: 'manual' })
				expect(response.status).toBe(status)
				expect(response.headers.get('x-outer')).toBe('set')
				expect(response.headers.get('x-inner')).toBe('set')
				expect(response.headers.get('location')).toBe(
					location === undefined ? null : `http://127.0.0.1:${port}${location}`,
				)
				await expect(response.text()).resolves.toBe(body)
				expect(seen).toHaveLength(2)
			} finally {
				await peer.destroy()
			}
		},
	)

	it('passes a mutable response through every layer by identity', async () => {
		const returned: Response[] = []
		const seen: Response[] = []
		const dispatcher = createDispatcher<object>()
		dispatcher.add({
			method: 'GET',
			path: '/respond',
			handler: () => {
				const response = new Response('mutable')
				returned.push(response)
				return response
			},
		})
		const server = trackServer(
			running,
			createServer({
				dispatcher,
				state: () => ({}),
				host: '127.0.0.1',
				middleware: [createResponseLayer(seen, 'x-outer'), createResponseLayer(seen, 'x-inner')],
			}),
		)
		const port = await server.start()
		const response = await fetch(`http://127.0.0.1:${port}/respond`)
		await expect(response.text()).resolves.toBe('mutable')
		expect(seen).toHaveLength(2)
		expect(seen.every((layer) => layer === returned[0])).toBe(true)
	})
})
