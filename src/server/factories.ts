import type { NegotiatorInterface, ServerInterface, ServerOptions } from './types.js'
import { Negotiator } from './Negotiator.js'
import { Server } from './Server.js'

/**
 * Create a {@link NegotiatorInterface} — the reusable content-negotiation
 * machine over the weighted `Accept` family.
 *
 * @remarks
 * Prefer this over `new Negotiator()` at call sites that only need the
 * interface.
 *
 * @returns A {@link NegotiatorInterface}
 *
 * @example
 * ```ts
 * import { createNegotiator } from '@src/server'
 *
 * const negotiator = createNegotiator()
 * negotiator.negotiate('text/html, application/json;q=0.9', ['application/json', 'text/html'])
 * // 'text/html'
 * ```
 */
export function createNegotiator(): NegotiatorInterface {
	return new Negotiator()
}

/**
 * Create a {@link ServerInterface} — the node face's HTTP server facade over
 * a consumed `@orkestrel/router` dispatcher.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param options - {@link ServerOptions}
 * @returns A {@link ServerInterface}, not yet started
 *
 * @example
 * ```ts
 * import { createServer } from '@src/server'
 * import { createDispatcher } from '@orkestrel/router'
 *
 * const dispatcher = createDispatcher<{ readonly ip?: string }>()
 * dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })
 *
 * const server = createServer({
 * 	dispatcher,
 * 	state: (connection) => ({ ip: connection.ip }),
 * })
 * const port = await server.start()
 * await server.stop()
 * ```
 */
export function createServer<TState>(options: ServerOptions<TState>): ServerInterface<TState> {
	return new Server(options)
}
