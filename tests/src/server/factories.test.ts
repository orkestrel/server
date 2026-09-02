import { describe, expect, expectTypeOf, it } from 'vitest'
import type { NegotiatorInterface, ServerInterface, StreamInterface } from '@src/server'
import { createDispatcher } from '@orkestrel/router'
import {
	createNegotiator,
	createServer,
	createStream,
	Negotiator,
	Server,
	Stream,
} from '@src/server'

// Mirror of `src/server/factories.ts` — each factory's round-trip (the instance
// it returns satisfies the interface it declares) plus its return-type
// assertion, `createServer`'s option threading, and the construction guards
// firing through the factory.

describe('createNegotiator — round-trip', () => {
	it('returns a Negotiator instance implementing NegotiatorInterface', () => {
		const negotiator = createNegotiator()
		expect(negotiator).toBeInstanceOf(Negotiator)
		const check: NegotiatorInterface = negotiator
		expect(check).toBe(negotiator)
	})

	it('is independently usable — negotiate/encoding/language/format all work', async () => {
		const negotiator = createNegotiator()
		expect(negotiator.negotiate('text/html', ['text/html'])).toBe('text/html')
		expect(negotiator.encoding('gzip', ['gzip'])).toBe('gzip')
		expect(negotiator.language('en', ['en'])).toBe('en')
		const response = await negotiator.format(
			new Request('http://localhost/', { headers: { accept: 'text/plain' } }),
			{
				url: new URL('http://localhost/'),
				method: 'GET',
				state: undefined,
				body: async () => undefined,
			},
			{ 'text/plain': () => new Response('ok') },
		)
		await expect(response.text()).resolves.toBe('ok')
	})

	it('returns NegotiatorInterface — a factory return type assertion', () => {
		expectTypeOf(createNegotiator()).toEqualTypeOf<NegotiatorInterface>()
	})
})

describe('createServer — round-trip', () => {
	it('returns a Server instance implementing ServerInterface, idle and not yet started', () => {
		const dispatcher = createDispatcher<undefined>()
		const server = createServer({ dispatcher, state: () => undefined })
		expect(server).toBeInstanceOf(Server)
		const check: ServerInterface<undefined> = server
		expect(check).toBe(server)
		expect(server.status).toBe('idle')
		expect(server.port).toBeUndefined()
		expect(server.emitter).toBeDefined()
		expect(typeof server.use).toBe('function')
		expect(typeof server.upgrade).toBe('function')
		expect(typeof server.start).toBe('function')
		expect(typeof server.stop).toBe('function')
		expect(typeof server.destroy).toBe('function')
	})

	it('threads the dispatcher option through to the interface', () => {
		const dispatcher = createDispatcher<undefined>()
		const server = createServer({ dispatcher, state: () => undefined })
		expect(server.dispatcher).toBe(dispatcher)
	})

	it('is independently usable — starts, serves, and stops', async () => {
		const dispatcher = createDispatcher<undefined>()
		dispatcher.add({ method: 'GET', path: '/ping', handler: () => new Response('pong') })
		const server = createServer({ dispatcher, state: () => undefined })
		const port = await server.start()
		const response = await fetch(`http://127.0.0.1:${port}/ping`)
		expect(await response.text()).toBe('pong')
		await server.stop()
	})

	it('propagates construction guards (e.g. timeouts.headers <= timeouts.keepalive)', () => {
		const dispatcher = createDispatcher<undefined>()
		expect(() =>
			createServer({
				dispatcher,
				state: () => undefined,
				timeouts: { headers: 5_000, keepalive: 1_000 },
			}),
		).toThrow(TypeError)
	})

	it('returns ServerInterface<TState> — a factory return type assertion', () => {
		const dispatcher = createDispatcher<undefined>()
		expectTypeOf(createServer({ dispatcher, state: () => undefined })).toEqualTypeOf<
			ServerInterface<undefined>
		>()
	})
})

describe('createStream — round-trip', () => {
	it('returns a Stream instance implementing StreamInterface, open and writable', () => {
		const stream = createStream()
		expect(stream).toBeInstanceOf(Stream)
		const check: StreamInterface = stream
		expect(check).toBe(stream)
		expect(stream.closed).toBe(false)
		stream.end()
	})

	it('threads the status and header options through to the response', () => {
		const stream = createStream({ status: 202, headers: { 'X-Trace': 'abc' } })
		expect(stream.response.status).toBe(202)
		expect(stream.response.headers.get('x-trace')).toBe('abc')
		stream.end()
	})

	it('is independently usable — writes events a consumer reads off the response body', async () => {
		const stream = createStream()
		stream.write({ event: 'token', data: 'hello' })
		stream.comment('keep-alive')
		stream.end()
		await expect(new Response(stream.response.body).text()).resolves.toBe(
			'event: token\ndata: hello\n\n: keep-alive\n\n',
		)
	})

	it('returns StreamInterface — a factory return type assertion', () => {
		expectTypeOf(createStream()).toEqualTypeOf<StreamInterface>()
	})
})
