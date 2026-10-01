import type { IncomingMessage, Server as NodeHTTPServer, ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { AbortInterface } from '@orkestrel/abort'
import type { TimeoutInterface } from '@orkestrel/timeout'
import type { EmitterInterface } from '@orkestrel/emitter'
import type { DispatcherInterface } from '@orkestrel/router'
import type {
	ConnectionStateFunction,
	MiddlewareContext,
	MiddlewareHandler,
	RequestLine,
	ServerEventMap,
	ServerInterface,
	ServerOptions,
	ServerStatus,
	UpgradeHandler,
} from './types.js'
import { addAbortListener, once } from 'node:events'
import { createServer as createHTTPServer } from 'node:http'
import { finished } from 'node:stream/promises'
import { createAbort, linkSignal } from '@orkestrel/abort'
import { createTimeout } from '@orkestrel/timeout'
import { buildRequest, isEncryptedSocket, sendResponse } from '@orkestrel/router/server'
import { Emitter } from '@orkestrel/emitter'
import { isError, isFiniteNumber, isFunction, isInteger } from '@orkestrel/contract'
import { compose, readBody } from './helpers.js'
import { isAddressInfo } from './validators.js'
import { DEFAULT_BODY_LIMIT, DEFAULT_DRAIN_MS } from './constants.js'
import { HTTPError, isHTTPError, ServerError } from './errors.js'

/**
 * Represents the HTTP server facade — an observable `node:http` lifecycle composing this
 * module's own middleware onion around a consumed `@orkestrel/router`
 * dispatcher. Implements exactly {@link ServerInterface}.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 *
 * @remarks
 * - **Lifecycle.** `start(signal?)` builds the underlying `node:http`
 *   server, binds the configured {@link ServerOptions.host} / {@link
 *   ServerOptions.port} (omitted/`0` port ⇒ ephemeral, resolved from the
 *   bound address), exposes that {@link AddressInfo} through `address`, observes
 *   caller cancellation plus the configured `timeouts.start` deadline while the
 *   bind is pending, and transitions `idle → starting → listening`. A
 *   cancelled or expired bind closes its partial server and resets to `idle` for
 *   another start. `stop()` transitions
 *   to `stopping`: fires a fresh-per-run stop signal so in-flight handlers
 *   observe cancellation (a request that arrives during the drain is served
 *   with that signal already aborted), drains in-flight requests and
 *   claimed upgraded sockets up to the `drain` deadline (event-driven, no
 *   busy-loop), then closes → `stopped`. After a clean drain the close
 *   destroys every connection that carries no open request exchange, and a
 *   connection that still carries one ends when its last exchange completes.
 *   A request or an upgrade that such a connection sends after the listener
 *   closes is refused: its connection is destroyed before the request is
 *   counted or a handler sees it, so the `stop()` call waits only on work
 *   counted before the close. After an expired drain the close destroys every
 *   socket. `destroy()` is the idempotent final teardown.
 * - **Per request.** In-flight is tracked (finished on response `finish` or
 *   `close`); a `Request` is built through the router's `buildRequest`, its
 *   `signal` linked to this run's stop signal through `@orkestrel/abort`'s
 *   `linkSignal` (a fresh `Request` is constructed with the linked signal —
 *   `buildRequest`'s own abort, armed by request-side and response-side
 *   teardown, composes with the server's stop signal through `AbortSignal.any`,
 *   so a handler awaiting `request.signal` observes either); `context.state` is built through
 *   {@link ServerOptions.state} from the connection facts; the composed
 *   middleware onion runs, terminating in `dispatcher.handle`; the result is
 *   written back through `sendResponse`.
 * - **The built-in boundary** wraps the whole per-request chain, including
 *   setup: `buildRequest` runs behind its own inner boundary that maps a
 *   throw (for example, a malformed `Host` header) to a silent `400` with no
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
 *   A claimed socket joins `#upgraded` until it closes: the claimant still
 *   owns it, and the tracking exists because Node detaches an upgraded socket
 *   from the set its own close calls walk, so nothing else can end it.
 * - **Observable.** Owns an {@link Emitter} over {@link ServerEventMap}
 *   exposed as `readonly emitter`; the emitter isolates a listener throw and
 *   routes it to the `error` option rather than to the domain `error` event.
 */
export class Server<TState> implements ServerInterface<TState> {
	readonly #id: string
	readonly #dispatcher: DispatcherInterface<TState>
	readonly #state: ConnectionStateFunction<TState>
	readonly #middleware: Array<MiddlewareHandler<TState>>
	readonly #upgradeHandlers: UpgradeHandler[] = []
	readonly #upgraded = new Set<Duplex>()
	readonly #exchanges = new Map<Socket, number>()
	readonly #emitter: Emitter<ServerEventMap>
	readonly #host: string | undefined
	readonly #configuredPort: number | undefined
	readonly #drain: number
	readonly #limit: number
	readonly #expose: boolean
	readonly #report: ((error: unknown, request?: RequestLine) => void) | undefined
	readonly #timeouts: {
		readonly start?: number
		readonly request?: number
		readonly headers?: number
		readonly keepalive?: number
	}
	readonly #sockets: {
		readonly connections?: number
		readonly headers?: number
		readonly requests?: number
	}
	#http: NodeHTTPServer | undefined
	#abort: AbortInterface = createAbort()
	#wakeup: AbortInterface = createAbort()
	#status: ServerStatus = 'idle'
	#port: number | undefined
	#pending = 0

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
		const sockets = options.sockets ?? {}
		for (const [name, value] of Object.entries(sockets)) {
			if (value !== undefined && (!isInteger(value) || value < 0))
				throw new TypeError(`ServerOptions.sockets.${name} must be a non-negative integer`)
		}
		this.#id = crypto.randomUUID()
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
		this.#sockets = sockets
		this.#emitter = new Emitter<ServerEventMap>({
			...(options.on === undefined ? {} : { on: options.on }),
			...(options.error === undefined ? {} : { error: options.error }),
		})
	}

	get id(): string {
		return this.#id
	}

	get status(): ServerStatus {
		return this.#status
	}

	get port(): number | undefined {
		return this.#port
	}

	get address(): AddressInfo | undefined {
		const address = this.#http?.address()
		return isAddressInfo(address) ? address : undefined
	}

	get dispatcher(): DispatcherInterface<TState> {
		return this.#dispatcher
	}

	get emitter(): EmitterInterface<ServerEventMap> {
		return this.#emitter
	}

	use(middleware: MiddlewareHandler<TState>): void
	use(middleware: ReadonlyArray<MiddlewareHandler<TState>>): void
	use(middleware: MiddlewareHandler<TState> | ReadonlyArray<MiddlewareHandler<TState>>): void {
		if (typeof middleware === 'function') this.#middleware.push(middleware)
		else this.#middleware.push(...middleware)
	}

	upgrade(handler: UpgradeHandler): void {
		this.#upgradeHandlers.push(handler)
	}

	start(signal?: AbortSignal): Promise<number> {
		if (this.#status !== 'idle' && this.#status !== 'stopped') {
			return Promise.reject(
				new ServerError('STATUS', `server cannot start from '${this.#status}'`, {
					status: this.#status,
				}),
			)
		}
		this.#status = 'starting'
		// A fresh stop signal per run, so a restarted server is not born aborted.
		this.#abort = createAbort()
		const server = createHTTPServer((request, response) => this.#handle(request, response))
		if (this.#timeouts.request !== undefined) server.requestTimeout = this.#timeouts.request
		if (this.#timeouts.headers !== undefined) server.headersTimeout = this.#timeouts.headers
		if (this.#timeouts.keepalive !== undefined) server.keepAliveTimeout = this.#timeouts.keepalive
		if (this.#sockets.connections !== undefined) server.maxConnections = this.#sockets.connections
		if (this.#sockets.headers !== undefined) server.maxHeadersCount = this.#sockets.headers
		if (this.#sockets.requests !== undefined) server.maxRequestsPerSocket = this.#sockets.requests
		// Bound to this run's server instance, discarded with it on stop/restart —
		// no manual removal needed (the same per-run lifecycle as the request
		// handler `createHTTPServer` takes).
		server.on('upgrade', (request, socket, head) => this.#onUpgrade(request, socket, head))
		server.on('connection', (socket) => this.#trackConnection(socket))
		this.#http = server
		return this.#listen(server, signal)
	}

	async stop(): Promise<void> {
		if (this.#status !== 'listening') return
		this.#status = 'stopping'
		this.#emitter.emit('stop')
		const server = this.#http
		// A pure signal — not the drain deadline's parent (a parent abort would
		// clear the Timeout so it never fires). The drain deadline is an
		// independent clock; the wake-park inside `#drainPending` resolves on the
		// last finish or the deadline, event-driven, never a busy-loop.
		this.#abort.abort()
		const deadline: TimeoutInterface = createTimeout({ ms: this.#drain })
		deadline.start()
		await this.#drainPending(deadline.signal)
		deadline.clear()
		const pending = this.#pending
		const upgraded = this.#upgraded.size
		this.#emitter.emit('drain', pending, upgraded)
		if (server !== undefined) await this.#close(server, pending + upgraded > 0)
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

	// Track the request for draining first — before anything that can throw —
	// so the sync listener itself never throws; the rest of setup (which can
	// throw on a malformed request) is deferred into the async `#accept`
	// entry, kept behind the built-in boundary. A request parsed after the
	// close on a connection an open exchange still holds is not counted work,
	// so its connection is destroyed before the request counts or runs.
	#handle(message: IncomingMessage, response: ServerResponse): void {
		if (this.#closed) {
			message.socket.destroy()
			return
		}
		const finish = this.#trackStart()
		response.once('finish', finish)
		response.once('close', finish)
		void this.#trackExchange(message, response)
		void this.#accept(message, response)
	}

	// Build the fetch `Request` + `MiddlewareContext`, run the composed onion,
	// and write the result back — every escaping throw is caught so the
	// process can never crash on an unhandled handler (or malformed request)
	// error. `buildRequest` runs behind its own inner boundary: a throw there
	// (for example, a malformed `Host` header) maps to a silent `400`, never
	// `error`.
	async #accept(message: IncomingMessage, response: ServerResponse): Promise<void> {
		let raw: Request
		try {
			raw = buildRequest(message, { response })
		} catch {
			await this.#respond(this.#boundary(new HTTPError(400, 'invalid request')), response)
			return
		}
		// Hoisted out of the inner try (not block-scoped inside it) so that try's
		// catch can attach real request context to the `error` emit / `report`
		// sink — and so `response` can be emitted with the same facts on either
		// the success or the error path.
		const method = raw.method
		const url = new URL(raw.url)
		const start = performance.now()
		try {
			const linked = linkSignal(raw.signal, this.#abort.signal)
			const request = new Request(raw, { signal: linked })
			this.#emitter.emit('request', method, url.pathname)
			const ip = message.socket.remoteAddress
			const connection = {
				...(ip === undefined ? {} : { ip }),
				encrypted: isEncryptedSocket(message.socket),
			}
			const context: MiddlewareContext<TState> = {
				url,
				method,
				state: this.#state(connection),
				body: this.#createBody(request),
			}
			const runner = compose(this.#middleware, (currentRequest, currentContext) =>
				this.#dispatcher.handle(currentRequest, currentContext.state),
			)
			const result = await runner(request, context)
			await this.#respond(result, response)
			this.#emitter.emit('response', {
				method,
				pathname: url.pathname,
				status: result.status,
				ms: Math.round(performance.now() - start),
			})
		} catch (error) {
			const mapped = this.#boundary(error)
			if (!isHTTPError(error)) {
				this.#emitter.emit('error', error, { method, url })
				if (this.#report !== undefined) {
					try {
						this.#report(error, { method, url })
					} catch {
						// Swallowed — reporting can never crash the response.
					}
				}
			}
			await this.#respond(mapped, response)
			this.#emitter.emit('response', {
				method,
				pathname: url.pathname,
				status: mapped.status,
				ms: Math.round(performance.now() - start),
			})
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
		const message = this.#expose && isError(error) ? error.message : 'Internal Server Error'
		return new Response(message, { status: 500 })
	}

	// Fan a raw protocol-upgrade out to the registered handlers in
	// registration order: the first to return `true` claims the socket. A
	// throwing handler is treated as declined — surfaced on `error` — and the
	// fan-out continues so a later handler can still claim. Unclaimed ⇒ the
	// socket is destroyed so an unhandled upgrade never leaks a connection.
	// An upgrade parsed after the close is refused the way `#handle` refuses a
	// request: its socket is destroyed before any handler sees it.
	#onUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
		if (this.#closed) {
			socket.destroy()
			return
		}
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
		if (handled) this.#trackSocket(socket)
		else socket.destroy()
		this.#emitter.emit('upgrade', request, handled)
	}

	async #listen(server: NodeHTTPServer, signal?: AbortSignal): Promise<number> {
		const deadline =
			this.#timeouts.start === undefined ? undefined : createTimeout({ ms: this.#timeouts.start })
		const startup = deadline === undefined ? signal : linkSignal(deadline.signal, signal)
		const binding = createAbort()
		const relay =
			startup === undefined
				? undefined
				: addAbortListener(startup, () => binding.abort(startup.reason))
		let listening: Promise<unknown[]> | undefined
		// The bound port, read inside the `try` so an address carrying none takes
		// the same cleanup path a failed bind takes. `0` is this package's request
		// for an ephemeral port, so it can never stand in for an unknown one.
		let port: number
		try {
			signal?.throwIfAborted()
			deadline?.start()
			if (deadline?.ms === 0 && startup !== undefined) await once(startup, 'abort')
			startup?.throwIfAborted()
			listening = once(server, 'listening', { signal: binding.signal })
			if (startup === undefined) server.listen(this.#configuredPort ?? 0, this.#host)
			else {
				server.listen({
					port: this.#configuredPort ?? 0,
					...(this.#host === undefined ? {} : { host: this.#host }),
					signal: binding.signal,
				})
			}
			await listening
			const address = server.address()
			// This branch is unreachable through `listen(port)` and exists for the other members of `address()`'s union.
			if (!isAddressInfo(address)) {
				throw new TypeError('server bound a listener with no resolvable AddressInfo')
			}
			port = address.port
		} catch (error) {
			const expired = deadline?.expired === true
			const cancelled = startup?.aborted === true
			// A cancellation removes `events.once`'s temporary error listener. Keep
			// the discarded server guarded while a simultaneous late bind error
			// settles so it cannot escape as an uncaught process error.
			server.on('error', () => undefined)
			binding.abort(error)
			if (listening !== undefined) await listening.catch(() => undefined)
			await this.#close(server, true)
			this.#http = undefined
			this.#port = undefined
			this.#status = 'idle'
			if (expired && deadline !== undefined) {
				throw new DOMException(
					`Server startup exceeded ${deadline.ms} milliseconds`,
					'TimeoutError',
				)
			}
			if (cancelled && startup !== undefined) throw startup.reason
			throw error
		} finally {
			relay?.[Symbol.dispose]()
			deadline?.clear()
		}
		this.#port = port
		this.#status = 'listening'
		this.#emitter.emit('start', port)
		return port
	}

	#createBody(request: Request): () => Promise<unknown> {
		let cached: Promise<unknown> | undefined
		return () => {
			cached ??= readBody(request, { limit: this.#limit })
			return cached
		}
	}

	// Close the underlying server, resolving after the listener closes, which
	// Node does only after every connection has closed. A clean close (the
	// drain settled) destroys every connection with no open exchange: one that
	// never sent a request, one partway through a header block, and an idle
	// keep-alive one. That covers every connection `closeIdleConnections()`
	// ends, which `server.close()` also calls itself. A connection with an open
	// exchange, such as one whose body still uploads after its response, stays
	// open, because destroying it can reset the connection and lose that
	// response; `#trackExchange` ends it when its count returns to zero. A
	// forced close (the drain deadline expired, `destroy`, or a failed bind)
	// destroys every socket.
	//
	// A protocol-upgraded socket needs the extra loop: Node detaches it from
	// the connection set `closeAllConnections()` walks, so that call never
	// reaches it while `server.close()` still waits on it. A clean drain leaves
	// no claimed socket open.
	#close(server: NodeHTTPServer, force: boolean): Promise<void> {
		return new Promise<void>((resolve) => {
			server.close(() => resolve())
			if (force) {
				server.closeAllConnections()
				for (const socket of this.#upgraded) socket.destroy()
			} else {
				for (const [socket, open] of this.#exchanges) if (open === 0) socket.destroy()
			}
		})
	}

	// Count a connection's open exchanges from its accept to its close, so a
	// clean close can find the connections that carry none.
	#trackConnection(socket: Socket): void {
		this.#exchanges.set(socket, 0)
		socket.once('close', () => this.#exchanges.delete(socket))
	}

	// Count one exchange open on its connection until both its request message
	// has ended or closed and its response has finished or closed; a count, not
	// a flag, because a pipelining client holds several at once. While a clean
	// close waits, the connection ends as its count returns to zero. An upload
	// whose response already finished holds `stop()` until its body ends or
	// Node's keep-alive socket timeout fires, and with `timeouts.keepalive: 0`
	// a stalled upload holds it with no bound. The `error` listeners `finished`
	// attaches stay after it settles, so a later `error` on the message or the
	// response raises no uncaught exception.
	async #trackExchange(message: IncomingMessage, response: ServerResponse): Promise<void> {
		const socket = message.socket
		const open = this.#exchanges.get(socket)
		if (open === undefined) return
		this.#exchanges.set(socket, open + 1)
		await Promise.allSettled([finished(message), finished(response)])
		const left = this.#exchanges.get(socket)
		if (left === undefined) return
		this.#exchanges.set(socket, left - 1)
		if (left === 1 && this.#closed) socket.destroy()
	}

	// The listener has closed while the server stops, so the drain has settled
	// and no further request or upgrade is counted work. Derived, so it cannot
	// drift from the status and the listener it reads.
	get #closed(): boolean {
		return this.#status === 'stopping' && this.#http?.listening === false
	}

	// Everything `stop()` has to drain: in-flight requests plus the upgraded
	// sockets handlers claimed. Derived, so the two counters can never drift
	// out of step with a third stored flag.
	get #inflight(): number {
		return this.#pending + this.#upgraded.size
	}

	// Arm a fresh drain wakeup when the server goes from settled to busy.
	// Called before the new unit is counted, so a zero here means nothing was
	// in flight yet. The invariant this pair holds — `#wakeup` is un-aborted
	// whenever `#inflight` is positive — is what lets `#drainPending` park on
	// it without racing a wakeup that already fired.
	#enter(): void {
		if (this.#inflight === 0) this.#wakeup = createAbort()
	}

	// Fire the current drain wakeup once the last unit of drainable work has
	// left. Called after that unit is uncounted — event-driven, never a
	// busy-loop.
	#settle(): void {
		if (this.#inflight === 0) this.#wakeup.abort()
	}

	// Track one in-flight request; returns an idempotent finish thunk.
	#trackStart(): () => void {
		this.#enter()
		this.#pending += 1
		let done = false
		return () => {
			if (done) return
			done = true
			this.#pending -= 1
			this.#settle()
		}
	}

	// Track one claimed upgraded socket for the duration of its life. The
	// claiming handler still owns the socket — this only watches it, so the
	// stop path can drain it like a request and cut it if the deadline wins.
	// An already-dead socket never enters (nothing would ever untrack it).
	#trackSocket(socket: Duplex): void {
		if (socket.destroyed || this.#upgraded.has(socket)) return
		this.#enter()
		this.#upgraded.add(socket)
		socket.once('close', () => {
			this.#upgraded.delete(socket)
			this.#settle()
		})
	}

	// Park until every in-flight request and claimed upgraded socket is gone
	// OR `signal` fires — event-driven (wake-park), no polling.
	async #drainPending(signal: AbortSignal): Promise<void> {
		if (this.#inflight === 0 || signal.aborted) return
		await once(AbortSignal.any([signal, this.#wakeup.signal]), 'abort')
	}
}
