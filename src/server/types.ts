// ============================================================================
//  The node face — type definitions (the §5 source of truth). The `Server`
//  entity's public surface: the status machine, its observable events, the
//  upgrade seam, connection-fact-derived state, and `createServer`'s options
//  (AGENTS §5). Everything here is genuinely node-bound (PROPOSAL §4) — the
//  middleware seam + substrate types live in `@src/core`, imported here, never
//  re-declared.
// ============================================================================

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { ConnectionInfo, MiddlewareHandler } from '@src/core'
import type { DispatcherInterface } from '@orkestrel/router'
import type { EmitterErrorHandler, EmitterHooks, EmitterInterface } from '@orkestrel/emitter'

/**
 * The `Server`'s lifecycle state (AGENTS §10 vocabulary).
 *
 * @remarks
 * `idle` (never started, or a fresh instance) → `starting` (binding the
 * listener) → `listening` (accepting requests) → `stopping` (draining
 * in-flight requests) → `stopped` (closed; `start()` may run again, minting a
 * fresh stop signal). `destroy()` is a terminal teardown reachable from any
 * state, idempotent once `stopped`.
 */
export type ServerStatus = 'idle' | 'starting' | 'listening' | 'stopping' | 'stopped'

/**
 * The `Server`'s observable lifecycle events (AGENTS §13).
 *
 * @remarks
 * - `start` — `listen()` resolved; carries the actually-bound port (an
 *   ephemeral `0` resolves to the OS-assigned one).
 * - `request` — fired once per incoming request, before the middleware onion
 *   runs, carrying the raw method + the parsed pathname.
 * - `upgrade` — a raw protocol-upgrade fan-out settled; carries the original
 *   `IncomingMessage` and whether a registered {@link UpgradeHandler} claimed it.
 * - `error` — a server-level fault: an escaping throw past the built-in
 *   boundary, an upgrade handler's throw, or a listen failure.
 * - `stop` — `stop()` began (status just moved to `'stopping'`).
 * - `drain` — the graceful drain settled (deadline hit or all finished);
 *   carries the still-pending request count (`0` on a clean drain).
 */
export type ServerEventMap = {
	readonly start: readonly [port: number]
	readonly request: readonly [method: string, pathname: string]
	readonly upgrade: readonly [request: IncomingMessage, handled: boolean]
	readonly error: readonly [error: unknown]
	readonly stop: readonly []
	readonly drain: readonly [pending: number]
}

/**
 * A raw `node:http` protocol-upgrade claimant — registered via
 * {@link ServerInterface.upgrade}.
 *
 * @remarks
 * Fan-out semantics (verbatim, PROPOSAL §4): handlers run in registration
 * order, the FIRST to return `true` CLAIMS (owns) the socket and stops the
 * fan-out; a handler that THROWS is treated as declined (the throw surfaces
 * on the `error` event) and the fan-out continues; if NONE claim it, the
 * socket is destroyed so an unhandled upgrade never leaks a dangling
 * connection. `request` / `socket` / `head` are node's own raw values, handed
 * over verbatim — no assertion at this boundary (AGENTS §14).
 *
 * @param request - The raw `node:http` upgrade request
 * @param socket - The raw, now-detached `Duplex` connection
 * @param head - The first packet of the upgraded stream, if any
 * @returns `true` to CLAIM the socket (this handler now owns it), `false` to
 *   decline and let a later handler try
 */
export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean

/**
 * Derives a consumer's per-request `TState` from the adapter-injected
 * {@link ConnectionInfo} — `ServerOptions.state`, invoked once per request
 * before the middleware onion runs.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 */
export type ConnectionStateFunction<TState> = (connection: ConnectionInfo) => TState

/**
 * Options for `createServer`.
 *
 * @param dispatcher - The `@orkestrel/router` {@link DispatcherInterface} the
 *   composed middleware onion terminates into — bring-your-own router (the
 *   composition seam stays explicit and independently testable).
 * @param state - {@link ConnectionStateFunction} — builds each request's
 *   `TState` from the connection facts (peer IP, TLS flag). `X-Forwarded-For`
 *   is never implicitly trusted here; a deployment behind a trusted proxy
 *   derives its own client key in this function or in middleware.
 * @param middleware - Initial middleware, run in array order (outer-first);
 *   more may be added later via `use`.
 * @param host - The network interface `start()` binds to (`node:http`
 *   `server.listen`'s host). Omitted ⇒ node's default (all interfaces).
 * @param port - The TCP port `start()` binds to. Omitted or `0` ⇒ an
 *   EPHEMERAL, OS-assigned free port (the default); `start()` always resolves
 *   the actually-bound port. A port already in use rejects `start()` with
 *   `EADDRINUSE` — no silent ephemeral fallback (use `discoverPort` to pick a
 *   guaranteed-free port up front).
 * @param drain - The graceful-stop deadline in milliseconds: on `stop()` the
 *   server stops accepting new connections and gives in-flight requests this
 *   long to finish before forcing sockets closed. Defaults to
 *   `DEFAULT_DRAIN_MS`. Must be a non-negative finite number.
 * @param limit - The default request-body byte cap the context's `body()`
 *   reads through. Defaults to `DEFAULT_BODY_LIMIT`. Must be a non-negative
 *   finite number.
 * @param expose - Whether a non-`HTTPError` throw's message is sent in the
 *   500 response body (an `HTTPError`'s own message is always client-facing).
 *   Defaults to `false`.
 * @param report - A fire-and-forget sink the built-in boundary hands every
 *   caught error to (logging / metrics); its own throw is swallowed so
 *   reporting can never crash the response.
 * @param timeouts - `node:http` tuning knobs: `request` (max time to fully
 *   receive + respond, `requestTimeout`), `headers` (max time to receive the
 *   request headers, `headersTimeout`), `keepalive` (idle keep-alive socket
 *   timeout, `keepAliveTimeout`). `headers` must not exceed `keepalive` (the
 *   Slowloris footgun) — construction throws a `TypeError` otherwise.
 * @param on - The reserved {@link EmitterHooks} for {@link ServerEventMap}
 *   (AGENTS §8), wiring initial lifecycle listeners at construction.
 * @param error - The emitter's listener-error handler (AGENTS §13) — a
 *   listener throw routes here, never to the domain `error` event.
 */
export interface ServerOptions<TState> {
	readonly dispatcher: DispatcherInterface<TState>
	readonly state: ConnectionStateFunction<TState>
	readonly middleware?: readonly MiddlewareHandler<TState>[]
	readonly host?: string
	readonly port?: number
	readonly drain?: number
	readonly limit?: number
	readonly expose?: boolean
	readonly report?: (error: unknown) => void
	readonly timeouts?: {
		readonly request?: number
		readonly headers?: number
		readonly keepalive?: number
	}
	readonly on?: EmitterHooks<ServerEventMap>
	readonly error?: EmitterErrorHandler
}

/**
 * The HTTP server facade — an observable `node:http` lifecycle that composes
 * a middleware onion (the `@src/core` seam) around a consumed
 * `@orkestrel/router` {@link DispatcherInterface}.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 *
 * @remarks
 * `use` adds middleware and `upgrade` registers a protocol-upgrade claimant,
 * both configurable before or after `start()`. `start()` binds the configured
 * `host`/`port` (an omitted/`0` port ⇒ an EPHEMERAL port, resolved from the
 * bound address) and resolves the actually-bound port. `stop()` refuses new
 * connections, fires the stop signal so in-flight handlers can observe it,
 * drains up to the configured deadline, then closes. `destroy()` is the final
 * idempotent teardown. Per request: a `Request` is built via the router's
 * `buildRequest` (its signal linked to the server's stop signal), the
 * composed middleware onion runs terminating in `dispatcher.handle`, and the
 * result is written back via `sendResponse` — every escaping throw is caught
 * by the built-in boundary (`HTTPError` → its status; anything else → a
 * hidden-unless-`expose` `500`) so a handler error can never crash the
 * process.
 */
export interface ServerInterface<TState> {
	readonly id: string
	readonly status: ServerStatus
	readonly port: number | undefined
	readonly dispatcher: DispatcherInterface<TState>
	readonly emitter: EmitterInterface<ServerEventMap>
	use(middleware: MiddlewareHandler<TState>): void
	use(middleware: readonly MiddlewareHandler<TState>[]): void
	upgrade(handler: UpgradeHandler): void
	start(): Promise<number>
	stop(): Promise<void>
	destroy(): Promise<void>
}
