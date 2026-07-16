// ============================================================================
//  The middleware seam + substrate — type definitions (the §5 source of
//  truth). Two families, both `readonly` per AGENTS §11, both fetch/string-
//  pure (no `node:*`, no DOM):
//
//    1. The middleware seam — {@link MiddlewareContext}, {@link NextFunction},
//       {@link MiddlewareHandler} — the frozen contract `compose` (U3) wires
//       together and the future `@orkestrel/middleware` package peer-depends
//       on. {@link ConnectionInfo} is the adapter-injected per-request fact
//       slice a consumer's `state` function turns into its `TState`.
//    2. The shared substrate's data shapes — cookies ({@link CookieOptions}),
//       tokens ({@link TokenSecret} / {@link TokenOptions}), negotiation
//       ({@link AcceptEntry} / {@link Encoding} / {@link FormatHandlerMap} /
//       {@link NegotiatorInterface}), conditional requests ({@link RangeSpec}),
//       SSE ({@link SSEMessage} / {@link StreamOptions} / {@link
//       StreamInterface}), and the body pipeline ({@link BodyOptions}) — the
//       future-middleware fuel `helpers.ts` (U2) implements against.
// ============================================================================

/**
 * The composition context — plain data, one per request, shared by every
 * middleware AND (as `state`) by the route handlers behind the dispatcher.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 *
 * @remarks
 * - `url` — the parsed request {@link URL} (mirrors the router's own parse, so
 *   a middleware never re-parses it).
 * - `method` — the raw request verb; the dispatcher (not this seam) narrows it
 *   to a known {@link import('@orkestrel/router').Method}.
 * - `state` — THE shared bag threaded from the adapter's `state` factory,
 *   through every middleware, into `dispatcher.handle`'s `state` — the same
 *   object a route handler reads as `context.state`.
 * - `body()` — lazily collect the request body (byte-limited, transparently
 *   decompressed, prototype-scrubbed for JSON), cached so repeated calls (a
 *   body-parsing middleware, then the handler) read the underlying stream
 *   exactly once.
 *
 * @example
 * ```ts
 * const middleware: MiddlewareHandler<{ readonly userId?: string }> = async (request, context, next) => {
 * 	const body = await context.body()
 * 	return next(request)
 * }
 * ```
 */
export interface MiddlewareContext<TState> {
	readonly url: URL
	readonly method: string
	readonly state: TState
	body(): Promise<unknown>
}

/**
 * The downstream continuation a {@link MiddlewareHandler} invokes to run the
 * rest of the onion.
 *
 * @remarks
 * Call it (optionally with a substituted `Request`) to run the downstream
 * chain and receive its `Response`; omit the call entirely to short-circuit
 * with a `Response` built by this middleware instead. A SECOND call rejects
 * (the double-`next` guard) — each middleware runs the chain at most once.
 *
 * @param request - An optional replacement `Request` to hand downstream
 *   (omitted ⇒ the original request continues)
 * @returns The downstream chain's resolved `Response`
 */
export type NextFunction = (request?: Request) => Promise<Response>

/**
 * One link in the middleware onion — runs around the rest of the chain.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 *
 * @remarks
 * Transform the request (call `next(newRequest)`), transform the response
 * (`await next()` then modify the result), short-circuit (return a `Response`
 * without calling `next`), or thread data via `context.state` — no mutable
 * framework object anywhere, only fetch-standard `Request`/`Response`.
 *
 * @example
 * ```ts
 * const withRequestId: MiddlewareHandler<{ readonly requestId: string }> = async (request, context, next) => {
 * 	const response = await next()
 * 	response.headers.set('X-Request-ID', context.state.requestId)
 * 	return response
 * }
 * ```
 */
export type MiddlewareHandler<TState> = (
	request: Request,
	context: MiddlewareContext<TState>,
	next: NextFunction,
) => Response | Promise<Response>

/**
 * The per-request connection facts the server face injects — the ONLY data
 * that genuinely exists solely on the socket, surfaced so middleware and a
 * consumer's `state` factory stay core-pure.
 *
 * @remarks
 * - `ip` — the socket peer address, for a spoof-proof rate-limit key. Never
 *   derived from `X-Forwarded-For` (a client-controlled header) — a
 *   deployment behind a trusted proxy derives its own client key explicitly.
 * - `encrypted` — whether the connection is TLS, for an auto-`Secure` cookie
 *   decision ({@link CookieOptions.secure} left `undefined`).
 */
export interface ConnectionInfo {
	readonly ip?: string
	readonly encrypted: boolean
}

/**
 * A secret (or rotation list) for signing + verifying a stateless, HMAC-signed
 * token.
 *
 * @remarks
 * A single `string` is the lone secret. A `readonly string[]` is a rotation
 * list in `[current, ...older]` order: `signToken` always signs with the
 * FIRST (current) secret, while `verifyToken` accepts a token signed by ANY
 * secret in the list — so a key rotates by prepending the new one and keeping
 * the old until every outstanding token has expired, with zero downtime.
 */
export type TokenSecret = string | readonly string[]

/**
 * Options for `signToken` — how a stateless, HMAC-signed token is minted.
 *
 * @param secret - The {@link TokenSecret} to sign with; `signToken` always
 *   uses the FIRST secret (a single string, or the current head of a
 *   rotation list). An empty rotation list is a misconfiguration and throws.
 * @param ttl - An optional lifetime in milliseconds. When set, the expiry
 *   timestamp is bound INTO the signed payload (HMAC-covered, tamper-proof);
 *   `verifyToken` rejects the token once that instant has passed. Omitted ⇒
 *   the token never expires.
 */
export interface TokenOptions {
	readonly secret: TokenSecret
	readonly ttl?: number
}

/**
 * The `Set-Cookie` attributes for `serializeCookie` (and any signed-cookie
 * transport built over it).
 *
 * @param path - The `Path` directive; defaults to `'/'`.
 * @param domain - The `Domain` directive; omitted ⇒ a host-only cookie.
 * @param maxAge - The `Max-Age` directive in SECONDS (the wire unit, not a
 *   millisecond `ttl`); `0` expires the cookie immediately.
 * @param httpOnly - The `HttpOnly` directive; defaults to `true`.
 * @param secure - The `Secure` directive: `true` forces it, `false`
 *   suppresses it, and omitted/`undefined` (the default) derives it from the
 *   connection via {@link import('./helpers.js').resolveSecure} — `Secure` on
 *   a TLS connection, off over plaintext HTTP ({@link
 *   ConnectionInfo.encrypted}). A `sameSite: 'None'` cookie is ALWAYS
 *   `Secure` regardless (the spec requires it).
 * @param sameSite - The `SameSite` directive; defaults to `'Lax'`.
 */
export interface CookieOptions {
	readonly path?: string
	readonly domain?: string
	readonly maxAge?: number
	readonly httpOnly?: boolean
	readonly secure?: boolean
	readonly sameSite?: 'Strict' | 'Lax' | 'None'
}

/**
 * One parsed entry of a weighted `Accept` / `Accept-Encoding` / `Accept-Language`
 * header — a value and its quality weight, the element type `parseAcceptHeader`
 * returns (sorted by `q` descending).
 *
 * @remarks
 * `value` is the lower-cased token (`text/html`, `gzip`, `en-us`, or a
 * wildcard). `q` is the quality weight in `[0, 1]` (the `;q=` parameter,
 * default `1` when absent); a `;q=0` entry explicitly REJECTS that token — a
 * parser keeps it (so a caller can honor the rejection) rather than
 * dropping it.
 */
export interface AcceptEntry {
	readonly value: string
	readonly q: number
}

/**
 * A content-coding the substrate compresses / decompresses with — the
 * `Content-Encoding` / `Accept-Encoding` token vocabulary it understands.
 *
 * @remarks
 * `gzip` / `deflate` map to `CompressionStream` / `DecompressionStream`
 * (web-standard, no external codec); `identity` is the no-op "uncompressed"
 * coding. Brotli (`br`) has no `CompressionStream` implementation yet, so it
 * is deliberately OMITTED here — Brotli parity is the future middleware
 * package's node-entry decision (§3 of the proposal), not this core's. A
 * constrained set of external-spec literals, so it stays a union, not a
 * behavioral toggle (AGENTS §4.4).
 */
export type Encoding = 'gzip' | 'deflate' | 'identity'

/**
 * A map of media type → handler for {@link NegotiatorInterface.format} — the
 * content-negotiation dispatch table.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 *
 * @remarks
 * Each key is a media type the route can PRODUCE (`application/json`,
 * `text/html`, …) and each value the responder that returns that
 * representation as a `Response`. `format` negotiates the client's preferred
 * key from the request `Accept` header and invokes the matching handler, or
 * answers `406 Not Acceptable` when none of the offered types is acceptable.
 * The keys are the `available` set negotiation chooses from, so their order
 * is the server's tie-break preference (a client accepting the any-media-
 * range gets the first key).
 */
export type FormatHandlerMap<TState> = Readonly<
	Record<
		string,
		(request: Request, context: MiddlewareContext<TState>) => Response | Promise<Response>
	>
>

/**
 * Content negotiation over the weighted `Accept` family — a reusable,
 * cross-middleware machine (not itself a middleware).
 *
 * @remarks
 * Parses a weighted `Accept` / `Accept-Encoding` / `Accept-Language` header
 * (q-values honored, `*` wildcards honored, a `;q=0` rejection respected) and
 * picks the client's most-preferred value the server also offers. `negotiate`
 * is the generic primitive (media types); `encoding` / `language` are its
 * sibling axes. `format` is the dispatcher — it reads the request `Accept`,
 * negotiates against a {@link FormatHandlerMap}'s keys, and invokes the
 * winning handler, resolving `406 Not Acceptable` when none is acceptable.
 *
 * @example
 * ```ts
 * const response = await negotiator.format(request, context, {
 * 	'application/json': (request, context) => Response.json({ ok: true }),
 * 	'text/html': (request, context) => new Response('<p>ok</p>', { headers: { 'Content-Type': 'text/html' } }),
 * })
 * ```
 */
export interface NegotiatorInterface {
	/**
	 * Pick the best `available` value for a weighted `Accept`-style `header` —
	 * the generic media-type primitive (`encoding` / `language` build on it).
	 *
	 * @param header - The raw weighted header value (e.g. `text/html, application/json;q=0.9`)
	 * @param available - The values the server can produce, in preference (tie-break) order
	 * @returns The best acceptable value, or `undefined` when none is
	 */
	negotiate(header: string, available: readonly string[]): string | undefined
	/**
	 * Pick the best `available` content-coding for an `Accept-Encoding` header
	 * — `negotiate` scoped to codings (a bare `*` wildcard ⇒ the first `available`).
	 *
	 * @param header - The raw `Accept-Encoding` header value (e.g. `gzip;q=1.0, deflate;q=0.8`)
	 * @param available - The codings the server offers, in preference order
	 * @returns The best acceptable coding, or `undefined` when none is
	 */
	encoding(header: string, available: readonly Encoding[]): Encoding | undefined
	/**
	 * Pick the best `available` language for an `Accept-Language` header —
	 * `negotiate` with a language-prefix match (`en` accepts `en-US`) and a
	 * bare `*` wildcard.
	 *
	 * @param header - The raw `Accept-Language` header value (e.g. `en-US, en;q=0.8, fr;q=0.5`)
	 * @param available - The languages the server offers, in preference order
	 * @returns The best acceptable language, or `undefined` when none is
	 */
	language(header: string, available: readonly string[]): string | undefined
	/**
	 * Dispatch to the handler whose media type the client most prefers — read
	 * the request `Accept`, negotiate against `handlers`' keys, and invoke the
	 * winner; `406` when none is acceptable.
	 *
	 * @typeParam TState - The consumer's opaque per-request state type
	 * @param request - The in-flight `Request`
	 * @param context - The request's {@link MiddlewareContext}
	 * @param handlers - The media type → responder {@link FormatHandlerMap} the route offers
	 * @returns The winning handler's `Response`, or a `406 Not Acceptable` `Response`
	 */
	format<TState>(
		request: Request,
		context: MiddlewareContext<TState>,
		handlers: FormatHandlerMap<TState>,
	): Promise<Response>
}

/**
 * One Server-Sent Event to serialize to the wire.
 *
 * @remarks
 * - `data` — the event payload (required). Serialized as one or more `data:`
 *   lines: the value is split on `\n` into a `data:` line PER segment, so it
 *   round-trips through a consumer's multi-`data` concat.
 * - `event` — the optional event TYPE, emitted as an `event:` line; omitted
 *   ⇒ the consumer's default (`message`).
 * - `id` — the optional last-event-id, emitted as an `id:` line.
 * - `retry` — the optional reconnection time in milliseconds, emitted as a
 *   `retry:` line.
 */
export interface SSEMessage {
	readonly data: string
	/** Must be a SINGLE-LINE value — an embedded newline would corrupt the SSE wire format. */
	readonly event?: string
	/** Must be a SINGLE-LINE value — an embedded newline would corrupt the SSE wire format. */
	readonly id?: string
	readonly retry?: number
}

/**
 * Options for the `openStream` seam.
 *
 * @param status - The HTTP status the streaming response is opened with;
 *   defaults to `200`.
 * @param headers - Extra response headers merged with the SSE headers the
 *   seam always sets ({@link SSE_HEADERS}) — a key the seam owns is never
 *   overridden.
 */
export interface StreamOptions {
	readonly status?: number
	readonly headers?: Readonly<Record<string, string>>
}

/**
 * A handle to write Server-Sent Events to an open, fetch-standard streaming
 * `Response` — the generic streaming surface `openStream` returns over a
 * `ReadableStream`.
 *
 * @remarks
 * Agent-agnostic by design: it speaks only the SSE wire vocabulary ({@link
 * SSEMessage}), so any streaming consumer maps its own events onto `write`.
 * `response` is the `Response` to return from the route handler (its body is
 * the `ReadableStream` this handle writes into). Each `write` serializes the
 * message to the wire and enqueues it; `comment` writes a `: text` keep-alive
 * line (ignored by a conforming SSE parser — no spurious event); `end` closes
 * the stream. Every method is a SAFE NO-OP once `closed` is `true`, so a late
 * `write` never throws.
 */
export interface StreamInterface {
	/** The streaming `Response` to return from the route handler. */
	readonly response: Response
	/** Whether the underlying stream is done (ended, or the consumer disconnected). */
	readonly closed: boolean
	/**
	 * Serialize + enqueue one {@link SSEMessage} to the wire (a no-op once `closed`).
	 *
	 * @param message - The event to send (its `data` split on `\n` into `data:` lines)
	 */
	write(message: SSEMessage): void
	/**
	 * Write a `: text` SSE comment line — a keep-alive a conforming parser ignores.
	 *
	 * @param text - The comment text (sent after the `: ` prefix)
	 */
	comment(text: string): void
	/** End the stream, completing the response (a no-op once already `closed`). */
	end(): void
}

/**
 * The parsed outcome of an HTTP `Range` request header.
 *
 * @remarks
 * A `Range: bytes=start-end` against a known resource `size` resolves to ONE
 * of two shapes, discriminated by `satisfiable` (the axis is whether the
 * requested span overlaps the resource):
 *
 * - **`satisfiable: true`** — a concrete, clamped byte window `[start, end]`
 *   (INCLUSIVE, the HTTP wire convention), normalized from the header's
 *   open / suffix / closed forms against `size`.
 * - **`satisfiable: false`** — the range lies wholly outside the resource.
 *
 * `parseRange` returns `undefined` for an ABSENT / unparseable / multi-range
 * / non-`bytes` header — the "no range, serve the whole resource" case — so
 * the three outcomes (full / partial / unsatisfiable) are distinguished
 * without a separate flag. It is TOTAL — a hostile header never throws.
 */
export type RangeSpec =
	| { readonly satisfiable: true; readonly start: number; readonly end: number }
	| { readonly satisfiable: false }

/**
 * Options for `readBody` — how the shared body-collection pipeline caps and
 * decompresses a request body.
 *
 * @param limit - The maximum request body size in bytes; a larger body
 *   throws a {@link import('./errors.js').ContentTooLargeError} (413).
 *   Defaults to {@link DEFAULT_BODY_LIMIT}.
 * @param decompression - The maximum DECOMPRESSED body size in bytes (the
 *   zip-bomb cap) for a `Content-Encoding: gzip` / `deflate` request body. A
 *   highly-compressible payload small ON THE WIRE (under `limit`) can inflate
 *   enormously, so a byte-counting `TransformStream` aborts the pipe the
 *   instant decompressed output would exceed this. Defaults to {@link
 *   import('./constants.js').DEFAULT_DECOMPRESSED_LIMIT} (16 MiB) —
 *   INDEPENDENT of `limit`, not aligned with it; a non-positive value means
 *   UNCAPPED decompressed output — use only when `limit` already bounds the
 *   compressed input.
 */
export interface BodyOptions {
	readonly limit?: number
	readonly decompression?: number
}

// ============================================================================
//  The node face — type definitions (the §5 source of truth). The `Server`
//  entity's public surface: the status machine, its observable events, the
//  upgrade seam, connection-fact-derived state, and `createServer`'s options
//  (AGENTS §5). Everything here is genuinely node-bound (PROPOSAL §4) — the
//  middleware seam + substrate types are declared above in this same file,
//  never re-declared.
// ============================================================================

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
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
 *   boundary, an upgrade handler's throw, or a listen failure. Carries the
 *   originating request's method + parsed `url` when the fault happened on
 *   the per-request path; `undefined` for an upgrade-handler throw (no fetch
 *   `Request` exists on that path — only a raw `IncomingMessage`) or a listen
 *   failure.
 * - `stop` — `stop()` began (status just moved to `'stopping'`).
 * - `drain` — the graceful drain settled (deadline hit or all finished);
 *   carries the still-pending request count (`0` on a clean drain).
 * - `response` — fired after the response has been sent, for every request
 *   that reaches the middleware pipeline (the success path and the
 *   outer-boundary error path); carries the method, parsed pathname, final
 *   status, and elapsed time in milliseconds. A request rejected at the
 *   `buildRequest` INNER boundary (a plain `400`, e.g. a malformed `Host`
 *   header) emits no `response` — no parsed `Request` exists yet to derive
 *   its facts from.
 */
export type ServerEventMap = {
	readonly start: readonly [port: number]
	readonly request: readonly [method: string, pathname: string]
	readonly upgrade: readonly [request: IncomingMessage, handled: boolean]
	readonly error: readonly [error: unknown, request?: { method: string; url: URL }]
	readonly stop: readonly []
	readonly drain: readonly [pending: number]
	readonly response: readonly [
		event: { method: string; pathname: string; status: number; ms: number },
	]
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
 *   caught error to (logging / metrics), along with the originating
 *   request's method + parsed `url` when one is available (absent on an
 *   upgrade-path fault); its own throw is swallowed so reporting can never
 *   crash the response.
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
	readonly report?: (error: unknown, request?: { method: string; url: URL }) => void
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
 * a middleware onion (this module's own middleware seam) around a consumed
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
