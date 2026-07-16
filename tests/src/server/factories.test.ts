import { describe, expect, expectTypeOf, it } from 'vitest'
import type { NegotiatorInterface, ServerInterface } from '@src/server'
import { createDispatcher } from '@orkestrel/router'
import { createNegotiator, createServer, Negotiator, Server } from '@src/server'

// §16 mirror of `src/server/factories.ts` — `createNegotiator` round-trip
// (instance satisfies the interface) plus its return-type assertion, and
// `createServer` round-trip (instance satisfies the interface), option
// threading, and construction guards firing through the factory.

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
