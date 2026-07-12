import type { IncomingMessage, Server as NodeHTTPServer, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { AbortInterface } from '@orkestrel/abort'
import type { TimeoutInterface } from '@orkestrel/timeout'
import type { EmitterInterface } from '@orkestrel/emitter'
import type { MiddlewareContext, MiddlewareHandler } from '@src/core'
import type { DispatcherInterface } from '@orkestrel/router'
import type {
	ConnectionStateFunction,
	ServerEventMap,
	ServerInterface,
	ServerOptions,
	ServerStatus,
	UpgradeHandler,
} from './types.js'
import { createServer as createHTTPServer } from 'node:http'
import {
	compose,
	DEFAULT_BODY_LIMIT,
	DEFAULT_DRAIN_MS,
	HTTPError,
	isHTTPError,
	readBody,
} from '@src/core'
import { createAbort, linkSignal } from '@orkestrel/abort'
import { createTimeout } from '@orkestrel/timeout'
import { buildRequest, isEncryptedSocket, sendResponse } from '@orkestrel/router/server'
import { Emitter } from '@orkestrel/emitter'
import { isFiniteNumber, isFunction } from '@orkestrel/contract'
import { isAddressInfo } from './helpers.js'

/**
 * The HTTP server facade — an observable `node:http` lifecycle composing the
 * `@src/core` middleware onion around a consumed `@orkestrel/router`
 * dispatcher.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 *
 * @remarks
 * - **Lifecycle (AGENTS §10).** `start()` builds the underlying `node:http`
 *   server, binds the configured {@link ServerOptions.host} / {@link
 *   ServerOptions.port} (omitted/`0` port ⇒ EPHEMERAL, resolved from the
 *   bound address), and transitions `idle → starting → listening`. `stop()`
 *   transitions to `stopping`: refuses new connections, fires a fresh-per-run
 *   stop signal so in-flight handlers observe cancellation, drains up to the
 *   `drain` deadline (event-driven, no busy-loop), then closes → `stopped`.
 *   `destroy()` is the idempotent final teardown.
 * - **Per request.** In-flight is tracked (finished on response `finish` or
 *   `close`); a `Request` is built via the router's `buildRequest`, its
 *   `signal` LINKED to this run's stop signal via `@orkestrel/abort`'s
 *   `linkSignal` (a fresh `Request` is constructed with the linked signal —
 *   `buildRequest`'s own abort, tied to client disconnect, composes with the
 *   server's stop signal via `AbortSignal.any`, so a handler awaiting
 *   `request.signal` observes BOTH); `context.state` is built via
 *   {@link ServerOptions.state} from the connection facts; the composed
 *   middleware onion runs, terminating in `dispatcher.handle`; the result is
 *   written back via `sendResponse`.
 * - **The built-in boundary** wraps the WHOLE per-request chain, including
 *   setup: `buildRequest` runs behind its own inner boundary that maps a
 *   throw (e.g. a malformed `Host` header) to a silent `400` with no
 *   `error` emit; everything after (`Request` reconstruction, connection
 *   facts, `state`, the composed onion, and `dispatcher.handle`) runs
 *   behind the outer boundary — a thrown `HTTPError` renders as its status +
 *   message; any other throw renders `500` (message hidden unless
 *   `expose`), `report` is invoked (its own throw swallowed), and `error` is
 *   emitted. A server-owned last resort wraps the final `sendResponse`
 *   write itself: if even that fails, the connection is destroyed rather
 *   than left to escape as an unhandled error.
 * - **Upgrade fan-out** — verbatim old semantics (first-claimer-wins, a
 *   throwing handler is treated as declined and surfaced on `error`, an
 *   unclaimed upgrade destroys the socket), bound per-run to this instance.
 * - **Observable (§13).** Owns an {@link Emitter} over {@link ServerEventMap}
 *   exposed as `readonly emitter`; the emitter isolates a listener throw and
 *   routes it to the `error` OPTION (not the domain `error` event).
 */
export class Server<TState> implements ServerInterface<TState> {
	readonly id = crypto.randomUUID()
	readonly #dispatcher: DispatcherInterface<TState>
	readonly #state: ConnectionStateFunction<TState>
	readonly #middleware: MiddlewareHandler<TState>[]
	readonly #upgradeHandlers: UpgradeHandler[] = []
	readonly #emitter: Emitter<ServerEventMap>
	readonly #host: string | undefined
	readonly #configuredPort: number | undefined
	readonly #drain: number
	readonly #limit: number
	readonly #expose: boolean
	readonly #report: ((error: unknown) => void) | undefined
	readonly #timeouts: {
		readonly request?: number
		readonly headers?: number
		readonly keepalive?: number
	}
	#http: NodeHTTPServer | undefined
	#abort: AbortInterface = createAbort()
	#status: ServerStatus = 'idle'
	#port: number | undefined
	#pending = 0
	#waiters: (() => void)[] = []

	constructor(options: ServerOptions<TState>) {
		if (!isFunction(options.state)) throw new TypeError('ServerOptions.state must be a function')
		if (options.report !== undefined && !isFunction(options.report))
			throw new TypeError('ServerOptions.report must be a function')
		const drain = options.drain ?? DEFAULT_DRAIN_MS
		if (!isFiniteNumber(drain) || drain < 0)
			throw new TypeError('ServerOptions.drain must be a non-negative finite number')
		const limit = options.limit ?? DEFAULT_BODY_LIMIT
		if (!isFiniteNumber(limit) || limit < 0)
			throw new TypeError('ServerOptions.limit must be a non-negative finite number')
		const timeouts = options.timeouts ?? {}
		for (const [name, value] of Object.entries(timeouts)) {
			if (value !== undefined && (!isFiniteNumber(value) || value < 0))
				throw new TypeError(`ServerOptions.timeouts.${name} must be a non-negative finite number`)
		}
		if (
			timeouts.headers !== undefined &&
			timeouts.keepalive !== undefined &&
			timeouts.headers > timeouts.keepalive
		) {
			throw new TypeError('ServerOptions.timeouts.headers must not exceed timeouts.keepalive')
		}
		this.#dispatcher = options.dispatcher
		this.#state = options.state
		this.#middleware = options.middleware === undefined ? [] : [...options.middleware]
		this.#host = options.host
		this.#configuredPort = options.port
		this.#drain = drain
		this.#limit = limit
		this.#expose = options.expose ?? false
		this.#report = options.report
		this.#timeouts = timeouts
		this.#emitter = new Emitter<ServerEventMap>({ on: options.on, error: options.error })
	}

	get status(): ServerStatus {
		return this.#status
	}

	get port(): number | undefined {
		return this.#port
	}

	get dispatcher(): DispatcherInterface<TState> {
		return this.#dispatcher
	}

	get emitter(): EmitterInterface<ServerEventMap> {
		return this.#emitter
	}

	use(middleware: MiddlewareHandler<TState>): void
	use(middleware: readonly MiddlewareHandler<TState>[]): void
	use(middleware: MiddlewareHandler<TState> | readonly MiddlewareHandler<TState>[]): void {
		if (typeof middleware === 'function') this.#middleware.push(middleware)
		else this.#middleware.push(...middleware)
	}

	upgrade(handler: UpgradeHandler): void {
		this.#upgradeHandlers.push(handler)
	}

	start(): Promise<number> {
		if (this.#status !== 'idle' && this.#status !== 'stopped') {
			return Promise.reject(new Error(`server cannot start from '${this.#status}'`))
		}
		this.#status = 'starting'
		// A fresh stop signal per run, so a restarted server is not born aborted.
		this.#abort = createAbort()
		const server = createHTTPServer((request, response) => this.#handle(request, response))
		if (this.#timeouts.request !== undefined) server.requestTimeout = this.#timeouts.request
		if (this.#timeouts.headers !== undefined) server.headersTimeout = this.#timeouts.headers
		if (this.#timeouts.keepalive !== undefined) server.keepAliveTimeout = this.#timeouts.keepalive
		// Bound to THIS run's server instance, discarded with it on stop/restart —
		// no manual removal needed (the same per-run lifecycle as the handler above).
		server.on('upgrade', (request, socket, head) => this.#onUpgrade(request, socket, head))
		this.#http = server
		return new Promise<number>((resolve, reject) => {
			const onError = (error: Error): void => {
				server.off('listening', onListening)
				this.#http = undefined
				this.#status = 'idle'
				reject(error)
			}
			const onListening = (): void => {
				server.off('error', onError)
				const port = this.#resolvePort(server)
				this.#port = port
				this.#status = 'listening'
				this.#emitter.emit('start', port)
				resolve(port)
			}
			server.once('error', onError)
			server.once('listening', onListening)
			server.listen(this.#configuredPort ?? 0, this.#host)
		})
	}

	async stop(): Promise<void> {
		if (this.#status !== 'listening') return
		this.#status = 'stopping'
		this.#emitter.emit('stop')
		const server = this.#http
		// A pure signal — NOT the drain deadline's parent (a parent abort would
		// clear the Timeout so it never fires). The drain deadline is an
		// independent clock; the wake-park below resolves on the last finish OR
		// the deadline, event-driven, never a busy-loop.
		this.#abort.abort()
		const deadline: TimeoutInterface = createTimeout({ ms: this.#drain })
		deadline.start()
		await this.#drainPending(deadline.signal)
		deadline.clear()
		const pending = this.#pending
		this.#emitter.emit('drain', pending)
		if (server !== undefined) await this.#close(server, pending > 0)
		this.#http = undefined
		this.#port = undefined
		this.#status = 'stopped'
	}

	async destroy(): Promise<void> {
		if (this.#status === 'stopped' && this.#http === undefined) {
			this.#emitter.destroy()
			return
		}
		if (!this.#abort.aborted) this.#abort.abort()
		const server = this.#http
		if (server !== undefined) await this.#close(server, true)
		this.#http = undefined
		this.#port = undefined
		this.#status = 'stopped'
		this.#emitter.destroy()
	}

	// Track the request for draining FIRST — before anything that can throw —
	// so the sync listener itself never throws; the rest of setup (which CAN
	// throw on a malformed request) is deferred into the async `#accept`
	// entry, kept behind the built-in boundary.
	#handle(message: IncomingMessage, response: ServerResponse): void {
		const finish = this.#trackStart()
		response.once('finish', finish)
		response.once('close', finish)
		void this.#accept(message, response)
	}

	// Build the fetch `Request` + `MiddlewareContext`, run the composed onion,
	// and write the result back — every escaping throw is caught so the
	// process can never crash on an unhandled handler (or malformed request)
	// error. `buildRequest` runs behind its OWN inner boundary: a throw there
	// (e.g. a malformed `Host` header) maps to a silent `400`, never `error`.
	async #accept(message: IncomingMessage, response: ServerResponse): Promise<void> {
		let raw: Request
		try {
			raw = buildRequest(message)
		} catch {
			await this.#respond(this.#boundary(new HTTPError(400, 'invalid request')), response)
			return
		}
		try {
			const linked = linkSignal(raw.signal, this.#abort.signal)
			const request = new Request(raw, { signal: linked })
			const url = new URL(request.url)
			this.#emitter.emit('request', request.method, url.pathname)
			const connection = {
				ip: message.socket.remoteAddress,
				encrypted: isEncryptedSocket(message.socket),
			}
			let cached: Promise<unknown> | undefined
			const context: MiddlewareContext<TState> = {
				url,
				method: request.method,
				state: this.#state(connection),
				body: () => {
					cached ??= readBody(request, { limit: this.#limit })
					return cached
				},
			}
			const runner = compose(this.#middleware, (currentRequest, currentContext) =>
				this.#dispatcher.handle(currentRequest, currentContext.state),
			)
			const result = await runner(request, context)
			await this.#respond(result, response)
		} catch (error) {
			const mapped = this.#boundary(error)
			if (!isHTTPError(error)) {
				this.#emitter.emit('error', error)
				if (this.#report !== undefined) {
					try {
						this.#report(error)
					} catch {
						// Swallowed — reporting can never crash the response.
					}
				}
			}
			await this.#respond(mapped, response)
		}
	}

	// The server-owned last resort: even a write failure inside
	// `sendResponse` cannot escape and crash the process — the underlying
	// response (and its socket) is destroyed instead.
	async #respond(result: Response, response: ServerResponse): Promise<void> {
		try {
			await sendResponse(result, response)
		} catch {
			response.destroy()
		}
	}

	// The built-in boundary — an `HTTPError` renders as its status + message;
	// any other throw renders `500` with its message hidden unless `expose`.
	#boundary(error: unknown): Response {
		if (isHTTPError(error)) return new Response(error.message, { status: error.status })
		const message = this.#expose && error instanceof Error ? error.message : 'Internal Server Error'
		return new Response(message, { status: 500 })
	}

	// Fan a raw protocol-upgrade out to the registered handlers in
	// registration order: the FIRST to return `true` CLAIMS the socket. A
	// throwing handler is treated as DECLINED — surfaced on `error` — and the
	// fan-out continues so a later handler can still claim. Unclaimed ⇒ the
	// socket is destroyed so an unhandled upgrade never leaks a connection.
	#onUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
		let handled = false
		for (const handler of this.#upgradeHandlers) {
			try {
				if (handler(request, socket, head)) {
					handled = true
					break
				}
			} catch (error) {
				this.#emitter.emit('error', error)
			}
		}
		if (!handled) socket.destroy()
		this.#emitter.emit('upgrade', request, handled)
	}

	// Resolve the bound port from the server's address, narrowed via a guard
	// (an `AddressInfo` carries a numeric `port`; a string / null address has
	// none). No assertion — an unresolvable address yields `0`.
	#resolvePort(server: NodeHTTPServer): number {
		const address = server.address()
		if (isAddressInfo(address)) return address.port
		return 0
	}

	// Close the underlying server, resolving once it stops accepting
	// connections. A keep-alive client leaves its socket IDLE after a
	// response, which would hang a plain `close()` — so idle sockets are
	// always dropped (an in-flight request is untouched); when `force` is set
	// (the drain deadline fired with work still in flight, or `destroy`)
	// every open socket is destroyed so the callback fires promptly.
	#close(server: NodeHTTPServer, force: boolean): Promise<void> {
		return new Promise<void>((resolve) => {
			server.close(() => resolve())
			if (force) server.closeAllConnections()
			else server.closeIdleConnections()
		})
	}

	// Track one in-flight request; returns an idempotent finish thunk. When
	// the last in-flight request finishes, every parked drain waiter is woken
	// — event-driven, never a busy-loop.
	#trackStart(): () => void {
		this.#pending += 1
		let finished = false
		return () => {
			if (finished) return
			finished = true
			this.#pending -= 1
			if (this.#pending === 0) {
				const waiters = this.#waiters
				this.#waiters = []
				for (const wake of waiters) wake()
			}
		}
	}

	// Park until the in-flight count reaches zero OR `signal` fires —
	// event-driven (wake-park), no polling.
	#drainPending(signal: AbortSignal): Promise<void> {
		if (this.#pending === 0 || signal.aborted) return Promise.resolve()
		return new Promise<void>((resolve) => {
			const onDone = (): void => {
				signal.removeEventListener('abort', onDone)
				resolve()
			}
			this.#waiters.push(onDone)
			signal.addEventListener('abort', onDone, { once: true })
		})
	}
}
