import { describe, expect, expectTypeOf, it } from 'vitest'
import type { ServerInterface } from '@src/server'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@src/server'
import { Server } from '@src/server'

// §16 mirror of `src/server/factories.ts` — `createServer` round-trip
// (instance satisfies the interface), option threading, and construction
// guards firing through the factory (mirrors tests/src/core/factories.test.ts).

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
