import type {
	NegotiatorInterface,
	ServerInterface,
	ServerOptions,
	StreamInterface,
	StreamOptions,
} from './types.js'
import { Negotiator } from './Negotiator.js'
import { Server } from './Server.js'
import { Stream } from './Stream.js'

/**
 * Creates a {@link NegotiatorInterface} — the reusable content-negotiation
 * machine over the weighted `Accept` family.
 *
 * @returns A {@link NegotiatorInterface}
 *
 * @example
 * ```ts
 * import type { MiddlewareContext } from '@src/server'
 * import { createNegotiator } from '@src/server'
 *
 * declare const context: MiddlewareContext<Record<string, never>>
 *
 * const negotiator = createNegotiator()
 * negotiator.negotiate('text/html, application/json;q=0.9', ['application/json', 'text/html']) // 'text/html'
 * negotiator.encoding('gzip;q=1.0, deflate;q=0.8', ['gzip', 'deflate']) // 'gzip'
 * negotiator.language('en-US, en;q=0.8, fr;q=0.5', ['en', 'fr']) // 'en'
 * await negotiator.format(new Request('http://x'), context, {
 * 	'application/json': (_request, _context) => Response.json({ ok: true }),
 * })
 * ```
 */
export function createNegotiator(): NegotiatorInterface {
	return new Negotiator()
}

/**
 * Creates a {@link ServerInterface} — the node face's HTTP server facade over
 * a consumed `@orkestrel/router` dispatcher.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param options - {@link ServerOptions}
 * @returns A {@link ServerInterface}, not yet started
 *
 * @example Quickstart: dispatcher, middleware, lifecycle
 * ```ts
 * import type { MiddlewareHandler } from '@orkestrel/server'
 * import { createServer } from '@orkestrel/server'
 * import { createDispatcher } from '@orkestrel/router'
 *
 * interface State {
 * 	readonly requestId: string
 * 	readonly ip: string | undefined
 * }
 *
 * const dispatcher = createDispatcher<State>()
 * dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })
 *
 * const logRequestId: MiddlewareHandler<State> = async (_request, context, next) => {
 * 	const response = await next()
 * 	response.headers.set('X-Request-ID', context.state.requestId)
 * 	return response
 * }
 *
 * const server = createServer<State>({
 * 	dispatcher,
 * 	state: (connection) => ({ requestId: crypto.randomUUID(), ip: connection.ip }),
 * })
 * server.use(logRequestId)
 * const port = await server.start()
 * await server.stop()
 * await server.destroy()
 * ```
 */
export function createServer<TState>(options: ServerOptions<TState>): ServerInterface<TState> {
	return new Server(options)
}

/**
 * Creates a {@link StreamInterface} — a generic Server-Sent-Events stream whose
 * `response` is a fetch-standard streaming `Response` a route returns.
 *
 * @param options - {@link StreamOptions}
 * @returns A {@link StreamInterface} whose stream is open
 *
 * @example
 * ```ts
 * import { createStream } from '@src/server'
 *
 * const stream = createStream()
 * void Promise.resolve().then(async () => {
 * 	if (!stream.write({ event: 'token', data: 'hello' })) await stream.drain()
 * 	stream.comment('keep-alive')
 * 	stream.end()
 * })
 * // return stream.response from the route handler
 * ```
 */
export function createStream(options?: StreamOptions): StreamInterface {
	return new Stream(options)
}
