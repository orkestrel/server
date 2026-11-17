import type { Connection, MiddlewareContext, RequestLine, ResponseRecord } from '@src/server'
import type { ServerListenerReading } from '../../setupServer.js'
import http from 'node:http'
import net from 'node:net'
import { inspect, isDeepStrictEqual } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { isInteger } from '@orkestrel/contract'
import { createDispatcher } from '@orkestrel/router'
import { buildErrorResponse, createServer, isServerError } from '@src/server'
import { createRecorder, readProperty, waitForCondition, waitForDelay } from '@orkestrel/test'
import { createLoopback } from '@orkestrel/test/server'
import {
	BOUNDARY_BODY_FAULT,
	BOUNDARY_F3_CASES,
	BOUNDARY_F3_THROWS,
	BOUNDARY_FIRST_CHUNK,
	BOUNDARY_REFUSED_REQUEST,
	BOUNDARY_RETURNED_STATUSES,
	BOUNDARY_SLOW_MS,
	BOUNDARY_THROWN_STATUSES,
	abandonBoundaryBody,
	abandonBoundaryRequest,
	abandonBoundaryUpload,
	createBoundaryDispatcher,
	inferBoundaryReply,
	readBoundaryRaw,
	readBoundaryReplies,
	readBoundaryReply,
	SEAM_BODY,
	SEAM_CONSTRUCTION_CASES,
	SEAM_IMMUTABLE_RESPONSES,
	SEAM_NEXT_ARGUMENTS,
	SEAM_STATE_FACTORIES,
	SERVER_CONTROL_INTERVAL,
	SERVER_FRAMING_INPUTS,
	SERVER_INTERVAL_CASES,
	SERVER_MATRIX_TIMEOUTS,
	SERVER_TIMEOUT_SLACK,
	ServerExchanges,
	ServerObservation,
	buildControlOptions,
	connectServerClient,
	countServerListeners,
	createAbortLayer,
	createAnsweringPeer,
	createArgumentLayer,
	createBodyLayer,
	countLiveObjects,
	countRequestConstructions,
	createCountingDispatcher,
	createDeadlineLayer,
	createMatrixControl,
	createMatrixDispatcher,
	createRetryLayer,
	createPingDispatcher,
	createResponseLayer,
	createRoutedControl,
	createRoutedDispatcher,
	createRouterControl,
	createSeamDispatcher,
	createSeenLayer,
	driveSeamRequests,
	driveServerDrip,
	driveServerIdle,
	filterServerHeaders,
	frameServerInput,
	sendSeamRequest,
	subtractServerListeners,
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

	it('refuses a next() call after a refused next(request), so the terminal never runs and the client reads the 500', async () => {
		const requests: Request[] = []
		const refusal = new ServerObservation<unknown>(undefined)
		const server = trackServer(
			running,
			createServer({
				dispatcher: createSeamDispatcher<object>(requests, Promise.resolve()),
				state: () => ({}),
				host: '127.0.0.1',
				middleware: [createRetryLayer(refusal)],
			}),
		)
		const port = await server.start()
		const response = await fetch(`http://127.0.0.1:${port}/plain`)
		expect(response.status).toBe(500)
		await expect(response.text()).resolves.toBe('Internal Server Error')
		expect(isServerError(refusal.value) ? refusal.value.code : undefined).toBe('NEXT')
		expect(requests).toHaveLength(0)
	})

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

describe('the exchange seam — one Request construction per exchange', () => {
	it.each(SEAM_CONSTRUCTION_CASES)(
		'constructs one Request for $label',
		async ({ method, path, status }) => {
			const constructions = createRecorder<[]>()
			const server = trackServer(
				running,
				createServer({
					dispatcher: createSeamDispatcher<object>([], Promise.resolve()),
					state: () => ({}),
					host: '127.0.0.1',
					middleware: [createSeenLayer([]), createSeenLayer([])],
				}),
			)
			const port = await server.start()
			const restore = countRequestConstructions(constructions)
			try {
				const response = await fetch(`http://127.0.0.1:${port}${path}`, {
					method,
					...(method === 'POST' ? { body: 'counted body' } : {}),
				})
				expect(response.status).toBe(status)
				await response.text()
			} finally {
				restore()
			}
			expect(constructions.calls).toHaveLength(1)
		},
	)
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
			// Counts live JS objects only: a retained primitive string, number, or primitive Map or Set
			// entry escapes it, and neither `queryObjects(String)` nor `heapUsed` closes that gap here.
			expect(after - before).toBeLessThan(1_500)
		} finally {
			agent.destroy()
		}
		// Passing runs read 3,742–4,775 ms under suite load; the budget is about three times the slowest.
	}, 15_000)
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

// The boundary and its outcomes, driven through a real `Server` over real sockets. Every expectation
// comes from the Fetch declarations and the ruling: a status `Response` admits answers itself, a null
// body status sends no body, every other status answers 500 and is reported once, a body failure
// after the headers reaches the client as an abort and `error` and `report` once, and a peer
// disconnect is no fault and fires no `response`.

describe('the boundary — status totality', () => {
	it.each([
		{ label: 'thrown', prefix: '/throw/', statuses: BOUNDARY_THROWN_STATUSES },
		{ label: 'returned', prefix: '/return/', statuses: BOUNDARY_RETURNED_STATUSES },
	])(
		'answers every $label status as Response admits it, and reports each other one once',
		// An unanswered exchange holds its group for the idle limit; the budget covers every group.
		{ timeout: 60_000 },
		async ({ prefix, statuses }) => {
			const rejections = createRecorder<readonly [unknown]>()
			process.on('unhandledRejection', rejections.handler)
			try {
				const reports = createRecorder<readonly [unknown, RequestLine | undefined]>()
				const errors = createRecorder<readonly [unknown, RequestLine | undefined]>()
				const server = trackServer(
					running,
					createServer({
						dispatcher: createBoundaryDispatcher([]),
						state: () => undefined,
						host: '127.0.0.1',
						report: reports.handler,
					}),
				)
				server.emitter.on('error', errors.handler)
				const port = await server.start()
				const paths = statuses.map((status) => `${prefix}${String(status)}`)
				const replies = await readBoundaryReplies(port, paths)
				const rows = statuses.map((status, index) => {
					const reply = replies[index]
					const expected = inferBoundaryReply(status)
					const reported = reports.calls.filter(([, line]) => line?.url.pathname === paths[index])
					return {
						status,
						observed: {
							status: reply?.status,
							body: reply?.body,
							empty: reply?.wire === '',
							complete: reply?.complete,
							reports: reported.length,
						},
						expected: {
							status: expected.status,
							body: expected.body,
							empty: expected.body === '',
							complete: true,
							reports: expected.reports,
						},
					}
				})
				expect(
					rows
						.filter((row) => !isDeepStrictEqual(row.observed, row.expected))
						.map((row) => inspect(row, { breakLength: Number.POSITIVE_INFINITY })),
				).toEqual([])
				expect(errors.count).toBe(reports.count)
				const control = await readBoundaryReply(port, '/ping')
				expect(control.body).toBe('pong')
				await waitForDelay(10)
				expect(rejections.calls).toEqual([])
			} finally {
				process.off('unhandledRejection', rejections.handler)
			}
		},
	)
})

describe('the boundary — one renderer, fit finding F3', () => {
	it.each(BOUNDARY_F3_CASES)(
		'answers throw $index under expose $expose with $status through the server and the renderer alike',
		async ({ index, expose, status, body, reports: count }) => {
			const reports = createRecorder<readonly [unknown, RequestLine | undefined]>()
			const server = trackServer(
				running,
				createServer({
					dispatcher: createBoundaryDispatcher([]),
					state: () => undefined,
					host: '127.0.0.1',
					expose,
					report: reports.handler,
				}),
			)
			const port = await server.start()
			const reply = await readBoundaryReply(port, `/f3/${String(index)}`)
			expect({ status: reply.status, body: reply.body }).toEqual({ status, body })
			const rendered = buildErrorResponse(BOUNDARY_F3_THROWS[index], expose)
			expect({ status: rendered.status, body: await rendered.text() }).toEqual({ status, body })
			expect(
				reports.calls.map(([error, line]) => [error, line?.method, line?.url.pathname]),
			).toEqual(count === 0 ? [] : [[BOUNDARY_F3_THROWS[index], 'GET', `/f3/${String(index)}`]])
		},
	)
})

describe('the boundary — a body failure after the headers', () => {
	it('destroys the connection, so the client reads an abort, and reaches error and report once', async () => {
		const reports = createRecorder<readonly [unknown, RequestLine | undefined]>()
		const errors = createRecorder<readonly [unknown, RequestLine | undefined]>()
		const responses = createRecorder<readonly [ResponseRecord]>()
		const server = trackServer(
			running,
			createServer({
				dispatcher: createBoundaryDispatcher([]),
				state: () => undefined,
				host: '127.0.0.1',
				report: reports.handler,
			}),
		)
		server.emitter.on('error', errors.handler)
		server.emitter.on('response', responses.handler)
		const port = await server.start()
		const reply = await readBoundaryReply(port, '/fail-body')
		expect({ status: reply.status, body: reply.body, complete: reply.complete }).toEqual({
			status: 200,
			body: BOUNDARY_FIRST_CHUNK,
			complete: false,
		})
		expect((await readBoundaryReply(port, '/ping')).body).toBe('pong')
		await waitForCondition('the control response fires', () =>
			responses.calls.some(([record]) => record.pathname === '/ping'),
		)
		const faults = [errors, reports].map((recorder) =>
			recorder.calls.map(([error, line]) => [error, line?.method, line?.url.pathname]),
		)
		expect(faults).toEqual([
			[[BOUNDARY_BODY_FAULT, 'GET', '/fail-body']],
			[[BOUNDARY_BODY_FAULT, 'GET', '/fail-body']],
		])
		expect(responses.calls.map(([record]) => record.pathname)).toEqual(['/ping'])
	})
})

describe('the boundary — the response event', () => {
	it('fires no response, no error, and no report for a peer that disconnects before the end', async () => {
		const entered: string[] = []
		const reports = createRecorder<readonly [unknown, RequestLine | undefined]>()
		const errors = createRecorder<readonly [unknown, RequestLine | undefined]>()
		const responses = createRecorder<readonly [ResponseRecord]>()
		const server = trackServer(
			running,
			createServer({
				dispatcher: createBoundaryDispatcher(entered),
				state: () => undefined,
				host: '127.0.0.1',
				report: reports.handler,
			}),
		)
		server.emitter.on('error', errors.handler)
		server.emitter.on('response', responses.handler)
		const port = await server.start()
		await abandonBoundaryRequest(port, '/hang', entered)
		await abandonBoundaryUpload(port, entered)
		expect(await abandonBoundaryBody(port)).toBe(BOUNDARY_FIRST_CHUNK)
		await abandonBoundaryRequest(port, '/late-empty', entered)
		await abandonBoundaryRequest(port, '/late-204', entered)
		await waitForCondition(
			'the null body routes answer after their peers left',
			() => entered.includes('/late-empty answered') && entered.includes('/late-204 answered'),
		)
		expect((await readBoundaryReply(port, '/ping')).body).toBe('pong')
		await waitForCondition('the control response fires', () =>
			responses.calls.some(([record]) => record.pathname === '/ping'),
		)
		expect(responses.calls.map(([record]) => record.pathname)).toEqual(['/ping'])
		expect([errors.count, reports.count]).toEqual([0, 0])
	})

	it('fires response for an exchange the server aborted and then answered with no body', async () => {
		const errors = createRecorder<readonly [unknown, RequestLine | undefined]>()
		const responses = createRecorder<readonly [ResponseRecord]>()
		const server = trackServer(
			running,
			createServer({
				dispatcher: createBoundaryDispatcher([]),
				state: () => undefined,
				host: '127.0.0.1',
				middleware: [createAbortLayer('/answer-empty', ['a deadline passed'])],
			}),
		)
		server.emitter.on('error', errors.handler)
		server.emitter.on('response', responses.handler)
		const port = await server.start()
		const reply = await readBoundaryReply(port, '/answer-empty')
		expect([reply.status, reply.body, reply.complete]).toEqual([200, '', true])
		await waitForCondition('the response fires', () => responses.count === 1)
		expect(responses.calls.map(([record]) => [record.pathname, record.status])).toEqual([
			['/answer-empty', 200],
		])
		expect(errors.count).toBe(0)
	})

	it('records the status written and the time from acceptance to the finished body', async () => {
		const responses = createRecorder<readonly [ResponseRecord]>()
		const server = trackServer(
			running,
			createServer({
				dispatcher: createBoundaryDispatcher([]),
				state: () => undefined,
				host: '127.0.0.1',
			}),
		)
		server.emitter.on('response', responses.handler)
		const port = await server.start()
		const [slow, unavailable] = await Promise.all([
			readBoundaryReply(port, '/slow'),
			readBoundaryReply(port, '/unavailable'),
		])
		expect([slow.status, slow.body, slow.complete]).toEqual([200, BOUNDARY_FIRST_CHUNK, true])
		expect(unavailable.status).toBe(503)
		await waitForCondition('both responses fire', () => responses.count === 2)
		const records = new Map(responses.calls.map(([record]) => [record.pathname, record]))
		expect(records.get('/slow')?.status).toBe(200)
		expect(records.get('/unavailable')?.status).toBe(503)
		expect(records.get('/slow')?.ms).toBeGreaterThanOrEqual(2 * BOUNDARY_SLOW_MS - 1)
		expect(records.get('/unavailable')?.ms).toBeGreaterThanOrEqual(BOUNDARY_SLOW_MS - 1)
	})
})

describe('the boundary — the terminal catch', () => {
	it('never rejects an exchange, and pairs every error event with one report', async () => {
		const rejections = createRecorder<readonly [unknown]>()
		process.on('unhandledRejection', rejections.handler)
		try {
			const reports = createRecorder<readonly [unknown, RequestLine | undefined]>()
			const errors = createRecorder<readonly [unknown, RequestLine | undefined]>()
			const server = trackServer(
				running,
				createServer({
					dispatcher: createBoundaryDispatcher([]),
					state: () => undefined,
					host: '127.0.0.1',
					report: async (error, line) => {
						reports.handler(error, line)
						throw new Error('the reporting sink rejects')
					},
				}),
			)
			server.emitter.on('error', errors.handler)
			const port = await server.start()
			const replies = await readBoundaryReplies(port, [
				'/throw/600',
				'/throw/304',
				'/return/0',
				'/boom',
				'/fail-body',
				'/ping',
			])
			expect(replies).toHaveLength(6)
			await waitForDelay(10)
			expect(rejections.calls).toEqual([])
			expect(errors.count).toBe(reports.count)
		} finally {
			process.off('unhandledRejection', rejections.handler)
		}
	})
})

describe('the boundary — the inner phase', () => {
	it('answers a request buildRequest refuses with a silent 400', async () => {
		const reports = createRecorder<readonly [unknown, RequestLine | undefined]>()
		const errors = createRecorder<readonly [unknown, RequestLine | undefined]>()
		const responses = createRecorder<readonly [ResponseRecord]>()
		const server = trackServer(
			running,
			createServer({
				dispatcher: createBoundaryDispatcher([]),
				state: () => undefined,
				host: '127.0.0.1',
				report: reports.handler,
			}),
		)
		server.emitter.on('error', errors.handler)
		server.emitter.on('response', responses.handler)
		const port = await server.start()
		const reply = await readBoundaryRaw(port, BOUNDARY_REFUSED_REQUEST)
		expect(reply.text).toMatch(/^HTTP\/1\.1 400/)
		expect((await readBoundaryReply(port, '/ping')).body).toBe('pong')
		await waitForCondition('the control response fires', () => responses.count === 1)
		expect([errors.count, reports.count, responses.count]).toEqual([0, 0, 1])
	})

	it('settles a refused request before the idle limit, whatever fails on its 400 path', async () => {
		const rejections = createRecorder<readonly [unknown]>()
		process.on('unhandledRejection', rejections.handler)
		try {
			const server = trackServer(
				running,
				createServer({
					dispatcher: createBoundaryDispatcher([]),
					state: () => undefined,
					host: '127.0.0.1',
				}),
			)
			const port = await server.start()
			const reply = await readBoundaryRaw(port, BOUNDARY_REFUSED_REQUEST)
			expect(reply.idle).toBe(false)
			await waitForDelay(10)
			expect(rejections.calls).toEqual([])
		} finally {
			process.off('unhandledRejection', rejections.handler)
		}
	})
})

// The server matrix: a real `Server` and a bare `node:http` control fed the same bytes over raw
// sockets. Each expectation is the control's framing class, the raw client's own framing parse,
// or the client's knowledge that the server closed the connection.

describe('the server matrix — timeouts delegated to node:http', () => {
	const { headers, request, keepalive } = SERVER_MATRIX_TIMEOUTS

	it.each(SERVER_INTERVAL_CASES)(
		'hands node:http a checking interval of $interval ms under $label',
		async ({ target, timeouts, interval }) => {
			const exchanges = new ServerExchanges()
			const server = trackServer(
				running,
				createServer({
					dispatcher: createMatrixDispatcher<object>(),
					state: () => ({}),
					host: '127.0.0.1',
					timeouts,
				}),
			)
			try {
				const port = await server.start()
				await (await fetch(`http://127.0.0.1:${port}${target}`)).text()
				// `@types/node` declares the interval as an option only; Node keeps it on the instance.
				const live = readProperty<unknown>(exchanges.server(target), 'connectionsCheckingInterval')
				expect(live).toBe(interval)
			} finally {
				exchanges.destroy()
			}
		},
	)

	it('answers a header drip slower than timeouts.headers as the control does, within its window', async () => {
		const control = await createLoopback(
			createMatrixControl(
				buildControlOptions(SERVER_MATRIX_TIMEOUTS, SERVER_CONTROL_INTERVAL),
				createRecorder(),
			),
		)
		const server = trackServer(
			running,
			createServer({
				dispatcher: createMatrixDispatcher<object>(),
				state: () => ({}),
				host: '127.0.0.1',
				timeouts: SERVER_MATRIX_TIMEOUTS,
			}),
		)
		try {
			const port = await server.start()
			// Node fires a timeout at most one checking interval, half of it here, after it passes.
			const window = headers * 1.5 + SERVER_TIMEOUT_SLACK
			const [expected, actual] = await Promise.all(
				[control.port, port].map((target) =>
					driveServerDrip(target, 'GET /a HTTP/1.1\r\nHost: x\r\n', 'X-Drip: on\r\n', window),
				),
			)
			expect(expected?.framing).toEqual({ statuses: [408], closed: true })
			expect(actual?.framing).toEqual(expected?.framing)
			expect(expected?.elapsed).toBeGreaterThanOrEqual(headers)
			expect(actual?.elapsed).toBeGreaterThanOrEqual(headers)
			expect(actual?.elapsed).toBeLessThanOrEqual(window)
		} finally {
			await control.destroy()
		}
	})

	it('answers a body drip slower than timeouts.request as the control does, within its window', async () => {
		const control = await createLoopback(
			createMatrixControl(
				buildControlOptions(SERVER_MATRIX_TIMEOUTS, SERVER_CONTROL_INTERVAL),
				createRecorder(),
			),
		)
		const server = trackServer(
			running,
			createServer({
				dispatcher: createMatrixDispatcher<object>(),
				state: () => ({}),
				host: '127.0.0.1',
				timeouts: SERVER_MATRIX_TIMEOUTS,
			}),
		)
		try {
			const port = await server.start()
			const window = request * 1.5 + SERVER_TIMEOUT_SLACK
			const head = 'POST /a HTTP/1.1\r\nHost: x\r\nContent-Length: 100000\r\n\r\n'
			const [expected, actual] = await Promise.all(
				[control.port, port].map((target) => driveServerDrip(target, head, 'a', window)),
			)
			expect(expected?.framing).toEqual({ statuses: [408], closed: true })
			expect(actual?.framing).toEqual(expected?.framing)
			expect(expected?.elapsed).toBeGreaterThanOrEqual(request)
			expect(actual?.elapsed).toBeGreaterThanOrEqual(request)
			expect(actual?.elapsed).toBeLessThanOrEqual(window)
		} finally {
			await control.destroy()
		}
	})

	it('closes an idle keep-alive connection after timeouts.keepalive as the control does', async () => {
		const node = createMatrixControl(
			buildControlOptions(SERVER_MATRIX_TIMEOUTS, SERVER_CONTROL_INTERVAL),
			createRecorder(),
		)
		const control = await createLoopback(node)
		const server = trackServer(
			running,
			createServer({
				dispatcher: createMatrixDispatcher<object>(),
				state: () => ({}),
				host: '127.0.0.1',
				timeouts: SERVER_MATRIX_TIMEOUTS,
			}),
		)
		try {
			const port = await server.start()
			// Node adds `keepAliveTimeoutBuffer` to the idle socket timeout from v22.19.0 on.
			const buffer: unknown = node.keepAliveTimeoutBuffer
			const window = keepalive + (isInteger(buffer) ? buffer : 0) + SERVER_TIMEOUT_SLACK
			const [expected, actual] = await Promise.all(
				[control.port, port].map((target) => driveServerIdle(target, window)),
			)
			expect(expected?.framing).toEqual({ statuses: [200], closed: true })
			expect(actual?.framing).toEqual(expected?.framing)
			expect(actual?.elapsed).toBeGreaterThanOrEqual(keepalive)
			expect(actual?.elapsed).toBeLessThanOrEqual(window)
		} finally {
			await control.destroy()
		}
	})
})

describe('the server matrix — the routed 405, HEAD, and OPTIONS', () => {
	it('answers a 405 that carries Allow, framed by its Content-Length', async () => {
		const server = trackServer(
			running,
			createServer({
				dispatcher: createRoutedDispatcher<object>(createRecorder()),
				state: () => ({}),
				host: '127.0.0.1',
			}),
		)
		const client = await connectServerClient(await server.start(), ['DELETE', 'GET'])
		try {
			client.write(
				'DELETE /items HTTP/1.1\r\nHost: x\r\n\r\nGET /items HTTP/1.1\r\nHost: x\r\n\r\n',
			)
			await client.wait(2, 'the 405 and the GET after it')
			const [refusal, next] = client.complete
			expect(refusal?.status).toBe(405)
			expect(refusal?.headers.allow?.split(', ')).toEqual(expect.arrayContaining(['GET', 'HEAD']))
			expect(next?.status).toBe(200)
		} finally {
			client.destroy()
		}
	})

	it('answers a 405 whose Allow carries OPTIONS', async () => {
		const server = trackServer(
			running,
			createServer({
				dispatcher: createRoutedDispatcher<object>(createRecorder()),
				state: () => ({}),
				host: '127.0.0.1',
			}),
		)
		const client = await connectServerClient(await server.start(), ['DELETE'])
		try {
			client.write('DELETE /items HTTP/1.1\r\nHost: x\r\n\r\n')
			await client.wait(1, 'the 405')
			expect(client.complete[0]?.headers.allow?.split(', ')).toContain('OPTIONS')
		} finally {
			client.destroy()
		}
	})

	it('answers an automatic HEAD with no body and the GET headers, as the control does', async () => {
		const control = await createLoopback(createRoutedControl())
		const server = trackServer(
			running,
			createServer({
				dispatcher: createRoutedDispatcher<object>(createRecorder()),
				state: () => ({}),
				host: '127.0.0.1',
			}),
		)
		const port = await server.start()
		const raw =
			'GET /items HTTP/1.1\r\nHost: x\r\n\r\nHEAD /items HTTP/1.1\r\nHost: x\r\n\r\nGET /items HTTP/1.1\r\nHost: x\r\n\r\n'
		const clients = await Promise.all(
			[control.port, port].map((target) => connectServerClient(target, ['GET', 'HEAD', 'GET'])),
		)
		try {
			for (const client of clients) client.write(raw)
			await Promise.all(clients.map((client) => client.wait(3, 'GET, HEAD, and GET')))
			const [expected, actual] = clients.map((client) => client.complete)
			expect(actual?.map((response) => [response.status, response.body])).toEqual([
				[200, 'items'],
				[200, ''],
				[200, 'items'],
			])
			expect(actual?.map((response) => response.status)).toEqual(
				expected?.map((response) => response.status),
			)
			const head = filterServerHeaders(actual?.[1]?.headers ?? {})
			expect(head).toEqual(filterServerHeaders(expected?.[1]?.headers ?? {}))
			expect(head).toEqual(filterServerHeaders(actual?.[0]?.headers ?? {}))
			expect(head['x-items']).toBe('listed')
		} finally {
			for (const client of clients) client.destroy()
			await control.destroy()
		}
	})

	it('cancels the GET body source of an automatic HEAD', async () => {
		const cancels = createRecorder<[unknown]>()
		const server = trackServer(
			running,
			createServer({
				dispatcher: createRoutedDispatcher<object>(cancels),
				state: () => ({}),
				host: '127.0.0.1',
			}),
		)
		const client = await connectServerClient(await server.start(), ['HEAD'])
		try {
			client.write('HEAD /items HTTP/1.1\r\nHost: x\r\n\r\n')
			await client.wait(1, 'the HEAD')
			await waitForCondition('the GET body source is cancelled', () => cancels.calls.length === 1)
			expect(cancels.calls).toHaveLength(1)
		} finally {
			client.destroy()
		}
	})

	it('answers an automatic OPTIONS with 204 and an Allow, and no body', async () => {
		const server = trackServer(
			running,
			createServer({
				dispatcher: createRoutedDispatcher<object>(createRecorder()),
				state: () => ({}),
				host: '127.0.0.1',
			}),
		)
		const client = await connectServerClient(await server.start(), ['OPTIONS', 'GET'])
		try {
			client.write(
				'OPTIONS /items HTTP/1.1\r\nHost: x\r\n\r\nGET /items HTTP/1.1\r\nHost: x\r\n\r\n',
			)
			await client.wait(2, 'the OPTIONS and the GET after it')
			const [options, next] = client.complete
			expect(options?.status).toBe(204)
			expect(options?.body).toBe('')
			expect(options?.headers.allow?.split(', ')).toEqual(
				expect.arrayContaining(['GET', 'HEAD', 'OPTIONS']),
			)
			expect(next?.status).toBe(200)
		} finally {
			client.destroy()
		}
	})
})

describe('the server matrix — the framing differential', () => {
	it.each(SERVER_FRAMING_INPUTS)('frames $label as the bare control does', async (input) => {
		const calls = createRecorder<[string | undefined]>()
		const control = await createLoopback(createMatrixControl({}, calls))
		const requests = createRecorder<[string, string]>()
		const responses = createRecorder<[ResponseRecord]>()
		const server = trackServer(
			running,
			createServer({
				dispatcher: createMatrixDispatcher<object>(),
				state: () => ({}),
				host: '127.0.0.1',
				on: { request: requests.handler, response: responses.handler },
			}),
		)
		try {
			const port = await server.start()
			const expected = await frameServerInput(control.port, input)
			const actual = await frameServerInput(port, input)
			expect(expected.statuses.length).toBeGreaterThan(0)
			expect(actual).toEqual(expected)
			// Where Node answers before the handler, the server reports no exchange.
			const answered = calls.calls.length === 0
			expect(answered ? [...requests.calls, ...responses.calls] : []).toEqual([])
		} finally {
			await control.destroy()
		}
	})
})

describe('the server matrix — listeners per exchange', () => {
	it('attaches at most two listeners per event to each message and response, and removes them when the exchange ends', async () => {
		const exchanges = new ServerExchanges()
		const readings = createRecorder<[string, ServerListenerReading]>()
		const dispatcher = createCountingDispatcher<undefined>(exchanges, readings)
		const control = await createLoopback(createRouterControl(dispatcher))
		const server = trackServer(
			running,
			createServer({ dispatcher, state: () => undefined, host: '127.0.0.1' }),
		)
		try {
			const port = await server.start()
			const arms = [[control.port, '/count/control'] as const, [port, '/count/server'] as const]
			const ended = await Promise.all(
				arms.map(async ([target, path]) => {
					await (await fetch(`http://127.0.0.1:${target}${path}`)).text()
					const [message, response] = exchanges.exchange(path) ?? []
					await waitForCondition(`the ${path} exchange ends`, () =>
						Boolean(message?.closed && response?.closed),
					)
					return {
						message: message === undefined ? {} : countServerListeners(message),
						response: response === undefined ? {} : countServerListeners(response),
					}
				}),
			)
			const entry = ['/count/control', '/count/server'].map(
				(path) => readings.calls.find(([target]) => target === path)?.[1],
			)
			const [controlEntry, serverEntry] = entry
			const [controlEnded, serverEnded] = ended
			expect(controlEntry).toBeDefined()
			expect(serverEntry).toBeDefined()
			const own = [
				subtractServerListeners(serverEntry?.message ?? {}, controlEntry?.message ?? {}),
				subtractServerListeners(serverEntry?.response ?? {}, controlEntry?.response ?? {}),
			]
			const left = [
				subtractServerListeners(serverEnded?.message ?? {}, controlEnded?.message ?? {}),
				subtractServerListeners(serverEnded?.response ?? {}, controlEnded?.response ?? {}),
			]
			for (const [event, count] of own.flatMap((counts) => Object.entries(counts))) {
				expect(
					count,
					`the server's own ${event} listeners at the handler's entry`,
				).toBeGreaterThanOrEqual(0)
				expect(
					count,
					`the server's own ${event} listeners at the handler's entry`,
				).toBeLessThanOrEqual(2)
			}
			expect(own.some((counts) => Object.values(counts).some((count) => count > 0))).toBe(true)
			for (const [event, count] of left.flatMap((counts) => Object.entries(counts))) {
				expect(count, `the server's own ${event} listeners after the exchange ends`).toBe(0)
			}
		} finally {
			exchanges.destroy()
			await control.destroy()
		}
	})
})
