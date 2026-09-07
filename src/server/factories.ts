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
 * @example Substrate direct use — tokens, cookies, negotiation
 * ```ts
 * import type { MiddlewareContext } from '@orkestrel/server'
 * import {
 * 	createNegotiator,
 * 	decodeTokenPayload,
 * 	decompressRequestBody,
 * 	readSignedCookie,
 * 	signToken,
 * 	verifyToken,
 * 	writeSignedCookie,
 * } from '@orkestrel/server'
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
 *
 * const headers = new Headers()
 * await writeSignedCookie(headers, 'session', 'user-1', 'secret')
 * const value = await readSignedCookie(
 * 	new Request('http://x', { headers: { cookie: 'session=abc' } }),
 * 	'session',
 * 	'secret',
 * )
 * await verifyToken('bad.token', 'secret') // undefined — total, never throws
 *
 * const token = await signToken('client', { secret: 'shh' })
 * decodeTokenPayload(token.split('.')[0]) // 'client' — the shared decode step verifyToken applies after a signature match
 *
 * const gzipped = new Uint8Array(
 * 	await new Response(
 * 		new Blob(['hi']).stream().pipeThrough(new CompressionStream('gzip')),
 * 	).arrayBuffer(),
 * )
 * const body = await decompressRequestBody(gzipped, 'gzip', 1_048_576)
 * new TextDecoder().decode(body) // 'hi' — capped decompression, the zip-bomb defense
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
