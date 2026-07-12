import type { ServerInterface, ServerOptions } from './types.js'
import { Server } from './Server.js'

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
