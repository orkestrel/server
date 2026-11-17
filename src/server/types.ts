// ============================================================================
//  The middleware seam + substrate — type definitions, the source of truth for
//  this half of the package. Two families, both `readonly`, both
//  fetch/string-pure (no `node:*`, no DOM):
//
//    1. The middleware seam — {@link MiddlewareContext}, {@link NextFunction},
//       {@link MiddlewareHandler} — the contract `compose` wires
//       together and the `@orkestrel/middleware` package peer-depends on.
//       {@link Connection} is the adapter-injected per-request fact
//       slice a consumer's `state` function turns into its `TState`.
//    2. The shared substrate's data shapes — cookies ({@link CookieOptions}),
//       tokens ({@link TokenSecret} / {@link SignerInterface} / {@link TokenOptions}), negotiation
//       ({@link AcceptEntry} / {@link Encoding} / {@link FormatHandlerMap} /
//       {@link NegotiatorInterface}), conditional requests ({@link RangeSpec}),
//       SSE ({@link SSEMessage} / {@link StreamOptions} / {@link
//       SSEStreamInterface}), and the body pipeline ({@link BodyOptions}) — what
//       `helpers.ts` implements against and middleware builds on.
// ============================================================================

/**
 * Represents the composition context — plain data, one per request, shared by every
 * middleware and, as `state`, by the route handlers behind the dispatcher.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 *
 * @remarks
 * - `url` — the parsed request {@link URL} (mirrors the router's own parse, so
 *   a middleware never re-parses it).
 * - `method` — the raw request verb; the dispatcher (not this seam) narrows it
 *   to a known {@link import('@orkestrel/router').Method}.
 * - `state` — the shared bag threaded from the adapter's `state` factory,
 *   through every middleware, into `dispatcher.handle`'s `state` — the same
 *   object a route handler reads as `context.state`.
 * - `connection` — the {@link Connection} the server built for this request,
 *   the same object the `state` factory received.
 * - `body()` — lazily collect the request body (byte-limited, transparently
 *   decompressed, prototype-scrubbed for JSON), cached so repeated calls (a
 *   body-parsing middleware, then the handler) read the underlying stream
 *   exactly once.
 * - `abort(reason)` — abort this exchange: the request's own `signal` aborts
 *   with `reason`. A second call changes nothing, and no other exchange is
 *   aborted.
 *
 * One context describes the accepted exchange: `compose` hands every layer and
 * the terminal the same object, and nothing replaces it.
 *
 * @example
 * ```ts
 * const middleware: MiddlewareHandler<{ readonly userId?: string }> = async (_request, context, next) => {
 * 	const body = await context.body()
 * 	return next()
 * }
 * ```
 */
export interface MiddlewareContext<TState> {
	readonly url: URL
	readonly method: string
	readonly state: TState
	readonly connection: Connection
	body(): Promise<unknown>
	abort(reason?: unknown): void
}

/**
 * Represents the downstream continuation a {@link MiddlewareHandler} invokes to run the
 * rest of the onion — guarded so a second call within one invocation rejects.
 *
 * @remarks
 * Call it with no argument to run the downstream chain on the same `Request`
 * and context and receive its `Response`; omit the call entirely to
 * short-circuit with a `Response` built by this middleware instead. A second
 * call, or a call that passes an argument, rejects with a `ServerError` of
 * code `'NEXT'`, and a refused call still spends the one call: each middleware
 * runs the chain at most once, and every layer sees the one `Request` the server
 * built. A response whose headers are
 * immutable, such as a `Response.redirect` result, resolves as a copy whose
 * headers the layer can set.
 *
 * @returns The downstream chain's resolved `Response`
 */
export type NextFunction = () => Promise<Response>

/**
 * Represents one link in the middleware onion — runs around the rest of the chain.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 *
 * @remarks
 * Transform the response (`await next()` then modify the result),
 * short-circuit (return a `Response` without calling `next`), abort the
 * exchange (`context.abort(reason)`), or thread data through `context.state`
 * — only fetch-standard `Request`/`Response`, and the request every layer
 * receives is the one the server built.
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
 * Represents the per-request connection facts the server face injects — the only data
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
export interface Connection {
	readonly ip?: string
	readonly encrypted: boolean
}

/**
 * Represents a secret, or a `[current, ...older]` rotation list, for signing and
 * verifying a stateless, HMAC-signed token.
 *
 * @remarks
 * A single `string` is the lone secret. A `readonly string[]` is a rotation
 * list in `[current, ...older]` order: the signer `createSigner` builds from it
 * signs with the first (current) key and verifies a token signed by any key in
 * the list — so a key rotates by building a signer with the fresh secret
 * prepended and keeping the old until every outstanding token has expired.
 * Every entry is non-blank; `createSigner` refuses a blank one.
 */
export type TokenSecret = string | readonly string[]

/**
 * Represents an HMAC-SHA256 signer over the keys of one {@link TokenSecret}, held in
 * `[current, ...older]` order.
 *
 * @remarks
 * A changed secret list is another signer: build another one and hand it to
 * every consumer, because no method rotates the keys in place.
 *
 * @example
 * ```ts
 * import { createSigner } from '@orkestrel/server'
 *
 * const signer = createSigner(['current-secret', 'previous-secret'])
 * const signature = await signer.sign('payload')
 * await signer.verify('payload', signature) // true
 * ```
 */
export interface SignerInterface {
	/**
	 * Signs `message` with the first (current) key — the base64url HMAC-SHA256 of
	 * its UTF-8 bytes.
	 *
	 * @param message - The text to sign; a lone surrogate encodes as U+FFFD
	 * @returns The canonical base64url signature
	 */
	sign(message: string): Promise<string>
	/**
	 * Checks whether `signature` is the canonical base64url HMAC-SHA256 of
	 * `message` under any held key, walking the keys in order and returning at
	 * the first match.
	 *
	 * @param message - The signed text
	 * @param signature - The candidate signature
	 * @returns True if a held key signed `message` as `signature`; false otherwise
	 *
	 * @remarks
	 * Answers `false` before reading a key when `signature` is not canonical
	 * base64url or does not decode to the 32 bytes of an HMAC-SHA256. A valid
	 * signature returns at its key's position, so its timing reveals that
	 * position; an invalid one reads every key. The `Signer` class never rejects
	 * for a pair of strings; a consumer implementation whose `verify` rejects
	 * makes `verifyToken` and `readSignedCookie` reject with its error.
	 */
	verify(message: string, signature: string): Promise<boolean>
}

/**
 * Options for `signToken` — how a stateless, HMAC-signed token is minted.
 *
 * @param signer - The {@link SignerInterface} whose `sign` signs the payload.
 * @param ttl - An optional lifetime in milliseconds. When set, the expiry
 *   timestamp is bound into the signed payload (HMAC-covered, tamper-proof);
 *   `verifyToken` rejects the token once that instant has passed. Omitted ⇒
 *   the token never expires.
 */
export interface TokenOptions {
	readonly signer: SignerInterface
	readonly ttl?: number
}

/**
 * Represents the `Set-Cookie` attributes for `serializeCookie` (and any signed-cookie
 * transport built over it).
 *
 * @param path - The `Path` directive; defaults to `'/'`.
 * @param domain - The `Domain` directive; omitted ⇒ a host-only cookie.
 * @param maxAge - The `Max-Age` directive in seconds (the wire unit, not a
 *   millisecond `ttl`); `0` expires the cookie immediately.
 * @param httpOnly - The `HttpOnly` directive; defaults to `true`.
 * @param secure - The `Secure` directive: `true` forces it, `false`
 *   suppresses it, and omitted/`undefined` (the default) derives it from the
 *   connection through {@link import('./helpers.js').resolveSecure} — `Secure` on
 *   a TLS connection, off over plaintext HTTP ({@link
 *   Connection.encrypted}). A `sameSite: 'None'` cookie is always
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
 * Represents one parsed entry of a weighted `Accept` / `Accept-Encoding` /
 * `Accept-Language` header — a value and its quality weight, the element type
 * `parseAcceptHeader` returns (sorted by `q` descending).
 *
 * @remarks
 * `value` is the lower-cased token (`text/html`, `gzip`, `en-us`, or a
 * wildcard). `q` is the quality weight in `[0, 1]` (the `;q=` parameter,
 * default `1` when absent); a `;q=0` entry explicitly rejects that token — a
 * parser keeps it (so a caller can honor the rejection) rather than
 * dropping it.
 */
export interface AcceptEntry {
	readonly value: string
	readonly q: number
}

/**
 * Rates one candidate media type against a parsed `Accept` header — the
 * quality and specificity `matchMediaType` reports for the best matching
 * {@link AcceptEntry}.
 *
 * @remarks
 * `q` is the client's quality weight in `[0, 1]`. `rank` is the specificity of
 * the entry that matched: `0` for an exact type, `1` for a subtype wildcard
 * (`type/*`), `2` for the any-range (`* / *`). A lower `rank` wins, and a
 * higher `q` breaks a rank tie.
 */
export interface MediaMatch {
	readonly q: number
	readonly rank: number
}

/**
 * Represents a content-coding the substrate compresses or decompresses with. Its
 * members are the `Content-Encoding` and `Accept-Encoding` token vocabulary the
 * substrate understands.
 *
 * @remarks
 * `gzip` / `deflate` map to `CompressionStream` / `DecompressionStream`
 * (web-standard, no external codec); `identity` is the no-op "uncompressed"
 * coding. Brotli (`br`) has no `CompressionStream` implementation yet, so it
 * is deliberately omitted here — Brotli parity is the middleware package's
 * node-entry decision, not this core's. A constrained set of external-spec
 * literals, so it stays a union, not a behavioral toggle.
 */
export type Encoding = 'gzip' | 'deflate' | 'identity'

/**
 * Represents a map of media type → handler for {@link NegotiatorInterface.format} — the
 * content-negotiation dispatch table.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 *
 * @remarks
 * Each key is a media type the route can produce (`application/json`,
 * `text/html`, …) and each value the responder that returns that
 * representation as a `Response`. `format` negotiates the client's preferred
 * key from the request `Accept` header and invokes the matching handler, or
 * answers `406 Not Acceptable` when none of the offered types is acceptable.
 * The keys are the `available` set negotiation chooses from, so their order
 * is the server's tie-break preference (a client accepting the any-media-
 * range gets the first key). A key matches its media type case-insensitively.
 */
export type FormatHandlerMap<TState> = Readonly<
	Record<
		string,
		(request: Request, context: MiddlewareContext<TState>) => Response | Promise<Response>
	>
>

/**
 * Represents content negotiation over the weighted `Accept` family — a reusable,
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
	 * Picks the best `available` value for a weighted `Accept`-style `header` —
	 * the generic media-type primitive (`encoding` / `language` build on it).
	 *
	 * @param header - The raw weighted header value (for example `text/html, application/json;q=0.9`)
	 * @param available - The values the server can produce, in preference (tie-break) order
	 * @returns The best acceptable value, or `undefined` when none is
	 */
	negotiate(header: string, available: readonly string[]): string | undefined
	/**
	 * Picks the best `available` content-coding for an `Accept-Encoding` header
	 * — the coding axis of the same q-value parser (a bare `*` wildcard ⇒ the
	 * first `available`).
	 *
	 * @param header - The raw `Accept-Encoding` header value (for example `gzip;q=1.0, deflate;q=0.8`)
	 * @param available - The codings the server offers, in preference order
	 * @returns The best acceptable coding, or `undefined` when none is
	 *
	 * @remarks
	 * An absent, empty, or unparseable header resolves to `undefined` — no
	 * compression — rather than to the first offered coding, because an absent
	 * `Accept-Encoding` makes identity the correct answer.
	 * {@link NegotiatorInterface.negotiate} and
	 * {@link NegotiatorInterface.language} fall back to the first offered value
	 * instead.
	 */
	encoding(header: string, available: readonly Encoding[]): Encoding | undefined
	/**
	 * Picks the best `available` language for an `Accept-Language` header —
	 * `negotiate` with a language-prefix match (`en` accepts `en-US`) and a
	 * bare `*` wildcard.
	 *
	 * @param header - The raw `Accept-Language` header value (for example `en-US, en;q=0.8, fr;q=0.5`)
	 * @param available - The languages the server offers, in preference order
	 * @returns The best acceptable language, or `undefined` when none is
	 */
	language(header: string, available: readonly string[]): string | undefined
	/**
	 * Dispatches to the handler whose media type the client most prefers —
	 * reads the request `Accept`, negotiates against `handlers`' keys, and
	 * invokes the winner; `406` when none is acceptable.
	 *
	 * @remarks
	 * Every response it returns, the `406` included, carries `Vary: Accept`
	 * merged into any `Vary` the handler set, because `Accept` selected it. The
	 * handler's response is returned as a copy with those headers, so a
	 * response whose headers are immutable, such as `Response.redirect`, also
	 * carries the field.
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
 * Represents one Server-Sent Event to serialize to the wire.
 *
 * @remarks
 * - `data` — the event payload (required). Serialized as one or more `data:`
 *   lines: the value is split on `\r\n`, `\r`, and `\n` into a `data:` line
 *   per segment, so it round-trips through a consumer's multi-`data` concat
 *   with each line break read as `\n`.
 * - `event` — the optional event type, emitted as an `event:` line; omitted
 *   ⇒ the consumer's default (`message`).
 * - `id` — the optional last-event-id, emitted as an `id:` line.
 * - `retry` — the optional reconnection time in milliseconds, emitted as a
 *   `retry:` line.
 */
export interface SSEMessage {
	readonly data: string
	/** Requires one line; `serializeEvent` refuses a line break. */
	readonly event?: string
	/** Requires one line with no NUL; `serializeEvent` refuses a line break or a NUL. */
	readonly id?: string
	/** Requires a non-negative safe integer; `serializeEvent` refuses any other number. */
	readonly retry?: number
}

/**
 * Options for an {@link SSEStreamInterface} — how `createStream` opens the
 * streaming response.
 *
 * @param status - The HTTP status the streaming response is opened with;
 *   defaults to `200`.
 * @param headers - Extra response headers merged over the SSE headers the
 *   seam always sets ({@link SSE_HEADERS}); a caller repeating one of those
 *   keys replaces the seam's value, in any casing.
 */
export interface StreamOptions {
	readonly status?: number
	readonly headers?: Readonly<Record<string, string>>
}

/**
 * Represents a handle to write Server-Sent Events to an open, fetch-standard streaming
 * `Response` — the generic streaming surface `createStream` returns over a
 * `ReadableStream`.
 *
 * @remarks
 * Agent-agnostic by design: it speaks only the SSE wire vocabulary ({@link
 * SSEMessage}), so any streaming consumer maps its own events onto `write`.
 * `response` is the `Response` to return from the route handler (its body is
 * the `ReadableStream` this handle writes into). Each `write` serializes the
 * message to the wire, enqueues it, and reports whether that process-local
 * queue still has capacity; a producer that receives `false` parks on
 * `drain()` before writing again. `comment` writes a `: text` keep-alive line
 * per line of its text (ignored by a conforming SSE parser — no spurious
 * event); `end` closes the stream. The stream opens with one comment line, so
 * the response pump has a first chunk and the headers leave before any event.
 * Every method is a safe no-op once `closed` is `true`, so a late `write`
 * never throws.
 *
 * The readiness signal is deliberately local: it reflects the
 * `ReadableStream` controller's queue, not proof that a remote peer consumed
 * bytes. With a drain-honoring response pump, that queue stops draining while
 * the process-local socket sink is backpressured, so a cooperative producer
 * can bound its contribution to transport buffering without polling. A caller
 * that ignores the boolean keeps the prior unconditional-enqueue behavior.
 * The stream's default strategy measures queued chunks, not their byte length,
 * so a producer seeking a byte bound must also bound each individual message.
 * Return `response` before awaiting a `false` write or `drain()`: the consumer
 * cannot pull until it receives the response, and the opening comment fills
 * the queue, so a `drain()` before any write also waits on that pull.
 */
export interface SSEStreamInterface {
	/** Holds the streaming `Response` to return from the route handler. */
	readonly response: Response
	/** Reports whether the underlying stream is done (ended, or the consumer disconnected). */
	readonly closed: boolean
	/**
	 * Serializes and enqueues one {@link SSEMessage} to the wire, reporting whether the
	 * process-local queue still has capacity afterward — `false` also once the stream
	 * is closed.
	 *
	 * @param message - The event to send (its `data` split on `\n` into `data:` lines)
	 * @returns True if the process-local stream queue has capacity after
	 *   accepting the event; false otherwise — the queue is full or the stream
	 *   is closed. A `false` event was still accepted unless `closed` was already
	 *   `true`; await {@link drain} before producing another event.
	 * @throws {ServerError} Thrown when the stream is open and `serializeEvent`
	 *   refuses a field of `message`, with code `'EVENT'`; nothing is enqueued
	 */
	write(message: SSEMessage): boolean
	/**
	 * Writes a `: text` SSE comment line — a keep-alive a conforming parser ignores,
	 * and a no-op once the stream is closed.
	 *
	 * @param text - The comment text (sent after the `: ` prefix, one comment line per line)
	 */
	comment(text: string): void
	/**
	 * Parks until the process-local stream queue has capacity again — resolving on the
	 * consumer pull that restores it, or immediately when capacity is already available
	 * or the stream is closed, and never polling.
	 *
	 * @returns A promise that resolves when a consumer pull restores positive
	 *   desired size, or immediately when capacity is already available or the
	 *   stream is closed. The wakeup is event-driven; it does not poll and does
	 *   not prove that a remote peer consumed the queued bytes.
	 */
	drain(): Promise<void>
	/**
	 * Ends the stream, completing the response — a no-op once already `closed`, and it
	 * settles any parked producer.
	 */
	end(): void
}

/**
 * Represents the parsed outcome of an HTTP `Range` request header.
 *
 * @remarks
 * A `Range: bytes=start-end` against a known resource `size` resolves to one
 * of two shapes, discriminated by `satisfiable` (the axis is whether the
 * requested span overlaps the resource):
 *
 * - **`satisfiable: true`** — a concrete, clamped byte window `[start, end]`
 *   (inclusive, the HTTP wire convention), normalized from the header's
 *   open / suffix / closed forms against `size`.
 * - **`satisfiable: false`** — the range lies wholly outside the resource.
 *
 * `parseRange` returns `undefined` for an absent / unparseable / multi-range
 * / non-`bytes` header — the "no range, serve the whole resource" case — so
 * the three outcomes (full / partial / unsatisfiable) are distinguished
 * without a separate flag. It is total — a hostile header never throws.
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
 * @param decompression - The maximum decompressed body size in bytes (the
 *   zip-bomb cap) for a `Content-Encoding: gzip` / `deflate` request body. A
 *   highly-compressible payload small on the wire (under `limit`) can inflate
 *   enormously, so a byte-counting `TransformStream` aborts the pipe the
 *   instant decompressed output would exceed this. Defaults to {@link
 *   import('./constants.js').DEFAULT_DECOMPRESSED_LIMIT} (16 MiB) —
 *   independent of `limit`, not aligned with it; a non-positive value means
 *   uncapped decompressed output — use only when `limit` already bounds the
 *   compressed input.
 */
export interface BodyOptions {
	readonly limit?: number
	readonly decompression?: number
}

// ============================================================================
//  The node face — type definitions, the source of truth for the `Server`
//  entity's public surface: the status machine, its observable events, the
//  upgrade seam, connection-fact-derived state, and `createServer`'s options.
//  Everything here is genuinely node-bound — the middleware seam + substrate
//  types are declared earlier in this same file, never re-declared.
// ============================================================================

import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import type { DispatcherInterface } from '@orkestrel/router'
import type { EmitterErrorHandler, EmitterHooks, EmitterInterface } from '@orkestrel/emitter'

/**
 * Represents the `Server`'s lifecycle state.
 *
 * @remarks
 * `idle` (never started, or a fresh instance) → `starting` (binding the
 * listener) → `listening` (accepting requests) → `stopping` (draining
 * in-flight requests) → `stopped` (closed; `start()` may run again).
 * `destroy()` is a terminal teardown reachable from any
 * state, idempotent once `stopped`.
 */
export type ServerStatus = 'idle' | 'starting' | 'listening' | 'stopping' | 'stopped'

/**
 * Represents the machine-readable category a
 * {@link import('./errors.js').ServerError} carries — `'STATUS'` for a forbidden
 * lifecycle call, `'NEXT'` for a second `next` call or one with an argument, `'EVENT'` for an SSE field
 * the wire cannot carry, `'SECRET'` for a malformed signer secret.
 *
 * @remarks
 * A `ServerError` reports a call the caller programmed and the substrate
 * refuses, not a client-facing fault — {@link import('./errors.js').HTTPError}
 * owns the latter and keys on `status` instead. The categories are disjoint, so
 * a `catch` narrowed by {@link import('./errors.js').isServerError} reads `code`
 * to tell them apart.
 */
export type ServerErrorCode =
	/** Identifies a lifecycle call the current {@link ServerStatus} forbids. */
	| 'STATUS'
	/** Identifies a middleware that called its `next` a second time, or with an argument. */
	| 'NEXT'
	/** Identifies an SSE message field the event-stream wire cannot carry. */
	| 'EVENT'
	/** Identifies a signer secret that is not a string or a list of strings, is empty, or holds a blank entry. */
	| 'SECRET'

/**
 * Identifies the request a server-level fault came from — its method and its
 * parsed URL.
 *
 * @remarks
 * Carried by {@link ServerEventMap.error}'s optional second element and by
 * {@link ServerOptions.report}'s optional second parameter, and present only
 * when the fault happened on the per-request path — an upgrade-handler throw
 * or a listen failure has no fetch `Request` to derive it from.
 */
export interface RequestLine {
	readonly method: string
	readonly url: URL
}

/**
 * Records one finished request — the payload {@link ServerEventMap.response}
 * carries.
 *
 * @remarks
 * `method` and `pathname` come from the parsed request, `status` is the status
 * actually sent (on the success path or the outer-boundary error path), and
 * `ms` is the elapsed time in whole milliseconds.
 */
export interface ResponseRecord {
	readonly method: string
	readonly pathname: string
	readonly status: number
	readonly ms: number
}

/**
 * Represents the `Server`'s observable lifecycle events.
 *
 * @remarks
 * - `start` — `listen()` resolved; carries the actually-bound port (an
 *   ephemeral `0` resolves to the OS-assigned one).
 * - `request` — fired once per incoming request, before the middleware onion
 *   runs, carrying the raw method + the parsed pathname.
 * - `upgrade` — a raw protocol-upgrade fan-out settled; carries the original
 *   `IncomingMessage` and whether a registered {@link UpgradeHandler} claimed it.
 * - `error` — a fault, fired once per fault. On the per-request path that is
 *   a throw the built-in boundary reports (every throw except an `HTTPError`
 *   whose status the response carries, a returned status no `Response`
 *   carries included), a response write that fails, or a throw the terminal
 *   catch holds; each carries the request's {@link RequestLine}, the same
 *   pair `report` receives. A throw after a peer disconnect is no fault and
 *   fires nothing. The request is `undefined` for an upgrade-handler throw
 *   (no fetch `Request` exists on that path — only a raw `IncomingMessage`),
 *   a listen failure, and a fault on the `400` path of a request no
 *   `Request` could be built for, a failed write of that `400` included.
 * - `stop` — `stop()` began (status moved to `'stopping'`). An upgrade
 *   handler that owns a long-lived socket closes it from here, so the drain
 *   settles instead of running out the deadline.
 * - `drain` — the graceful drain settled (deadline hit or all finished);
 *   carries the still-pending request count and the still-attached upgraded
 *   socket count. Both `0` is a clean drain; either non-zero means the close
 *   that follows was forced and cut that work.
 * - `response` — fired once for each response that finished, after the
 *   server wrote its last byte, on the success path and the outer-boundary
 *   error path alike. It carries the method, the parsed pathname, `status`,
 *   the status the server wrote (the handler's, or the rendered status of a
 *   throw), and `ms`, the time from the exchange's acceptance, before
 *   `request` fires, to that last byte, in whole milliseconds. A response
 *   whose peer disconnected first, a body-less answer included, and a write
 *   that failed fire no `response`,
 *   and neither does a request rejected at the `buildRequest` inner boundary
 *   (a plain `400`, for example a malformed `Host` header), because no parsed
 *   `Request` exists yet to derive its facts from.
 */
export type ServerEventMap = {
	readonly start: readonly [port: number]
	readonly request: readonly [method: string, pathname: string]
	readonly upgrade: readonly [request: IncomingMessage, handled: boolean]
	readonly error: readonly [error: unknown, request?: RequestLine]
	readonly stop: readonly []
	readonly drain: readonly [pending: number, upgraded: number]
	readonly response: readonly [event: ResponseRecord]
}

/**
 * Represents a raw `node:http` protocol-upgrade claimant — registered through
 * {@link ServerInterface.upgrade}.
 *
 * @remarks
 * Fan-out semantics: handlers run in registration
 * order, the first to return `true` claims (owns) the socket and stops the
 * fan-out; a handler that throws is treated as declined (the throw surfaces
 * on the `error` event) and the fan-out continues; if none claim it, the
 * socket is destroyed so an unhandled upgrade never leaks a dangling
 * connection. `request` / `socket` / `head` are node's own raw values, handed
 * over verbatim — no assertion at this boundary.
 *
 * A claimed socket is tracked until it closes. The handler still owns it —
 * the server only watches — but `stop()` drains that socket like an
 * in-flight request and destroys it if the `drain` deadline expires first.
 * Node detaches an upgraded socket from its own connection set, so neither
 * `closeIdleConnections()` nor `closeAllConnections()` reaches it and this
 * tracking is what lets `stop()` and `destroy()` finish at all. A handler
 * that wants a protocol-clean goodbye (a WebSocket close frame) sends it on
 * the server's `stop` event and closes the socket; the drain settles the
 * moment the last one goes.
 *
 * @param request - The raw `node:http` upgrade request
 * @param socket - The raw, now-detached `Duplex` connection
 * @param head - The first packet of the upgraded stream, if any
 * @returns True if the handler claims the socket (this handler now owns
 *   it); false otherwise, declining so a later handler can try
 */
export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean

/**
 * Derives a consumer's per-request `TState` from the adapter-injected
 * {@link Connection} — `ServerOptions.state`, invoked once per request
 * before the middleware onion runs.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 */
export type ConnectionStateFunction<TState> = (connection: Connection) => TState

/**
 * Options for `createServer` — the dispatcher and per-request state factory the
 * server requires, plus its listener, drain, boundary, timeout, socket-cap, and
 * emitter knobs.
 *
 * @param dispatcher - The `@orkestrel/router` {@link DispatcherInterface} the
 *   composed middleware onion terminates into — bring-your-own router (the
 *   composition seam stays explicit and independently testable).
 * @param state - {@link ConnectionStateFunction} — builds each request's
 *   `TState` from the connection facts (peer IP, TLS flag). `X-Forwarded-For`
 *   is never implicitly trusted here; a deployment behind a trusted proxy
 *   derives its own client key in this function or in middleware.
 * @param middleware - Initial middleware, run in array order (outer-first);
 *   more may be added later by using `use`.
 * @param host - The network interface `start()` binds to (`node:http`
 *   `server.listen`'s host). Omitted ⇒ node's default (all interfaces).
 * @param port - The TCP port `start()` binds to. Omitted or `0` ⇒ an
 *   ephemeral, OS-assigned free port (the default); `start()` always resolves
 *   the actually-bound port. A port already in use rejects `start()` with
 *   `EADDRINUSE` — no silent ephemeral fallback (use `discoverPort` to pick a
 *   guaranteed-free port up front).
 * @param drain - The graceful-stop deadline in milliseconds: on `stop()` the
 *   server stops accepting new connections and gives in-flight requests,
 *   claimed upgraded sockets, and connections that still carry an open
 *   request exchange this long to finish before forcing every remaining
 *   socket closed. Defaults to `DEFAULT_DRAIN_MS`. Must be an integer from
 *   0 through 2_147_483_647; construction throws a `TypeError` otherwise.
 *   A long-lived upgraded socket that nothing closes therefore costs
 *   `stop()` this whole budget, so a WebSocket handler closes its sockets
 *   on the `stop` event to settle sooner.
 * @param limit - The default request-body byte cap the context's `body()`
 *   reads through. Defaults to `DEFAULT_BODY_LIMIT`. Must be a non-negative
 *   finite number.
 * @param expose - Whether a non-`HTTPError` throw's message is sent in the
 *   500 response body (an `HTTPError`'s own message is always client-facing).
 *   Defaults to `false`.
 * @param report - A fire-and-forget sink the built-in boundary hands each
 *   fault to (logging / metrics), with the same `(error, RequestLine)` the
 *   `error` event carries: every throw except an `HTTPError` whose status the
 *   response carries, a returned status no `Response` carries, a response
 *   write that fails, and a throw the terminal catch holds. A throw after a
 *   peer disconnect is no fault. A sink that throws, or returns a promise
 *   that rejects, is contained, so the response still goes out, except a
 *   rejected native promise whose species constructor cannot build a promise:
 *   its `constructor` lookup throws or yields a value that is neither
 *   `undefined` nor an object, its `Symbol.species` lookup throws or yields a
 *   value that is neither `undefined`, `null`, nor a constructor, or that
 *   constructor throws or never passes its executor callable resolve and
 *   reject functions. Such a promise refuses every reaction, so its rejection
 *   reaches `unhandledRejection`, which ends the process under Node's default
 *   unhandled-rejection mode; the response still goes out. The request is absent
 *   only for a fault on the `400` path of a request no `Request` could be
 *   built for, a failed write of that `400` included.
 * @param timeouts - Timeouts in milliseconds: `start` (the maximum time to
 *   bind the listener; `0` permits no startup window), and three that
 *   `start()` passes to `node:http`'s `createServer` as options: `headers`
 *   (`headersTimeout`, the time to receive the request headers), `request`
 *   (`requestTimeout`, the time to receive the whole request; no server
 *   timeout bounds the response), and `keepalive` (`keepAliveTimeout`, the
 *   idle time a kept-alive connection waits for its next request; Node adds
 *   its `keepAliveTimeoutBuffer`, 1_000 ms by default, so a `keepalive` of
 *   400 closes an idle connection after about 1_400 ms). `0` disables each
 *   of those three. An omitted one keeps Node's default: `request` is
 *   `DEFAULT_REQUEST_TIMEOUT_MS`, `headers` the lesser of
 *   `DEFAULT_HEADERS_TIMEOUT_MS` and `request`, and `keepalive` Node's
 *   `keepAliveTimeout` default. When `headers` or `request` passes while a
 *   response is being sent, Node closes the connection, which cuts that
 *   response short; otherwise, including after a response has finished
 *   while its upload continues, Node answers `408` and closes the
 *   connection. The server sets Node's
 *   `connectionsCheckingInterval` to `Math.ceil(m / 2)` milliseconds, where
 *   `m` is the smaller positive of `headers` and `request` as Node applies
 *   them, so each expires at most one such interval after it passes; with
 *   neither positive, Node keeps its own interval. `start`, `headers`, and
 *   `request` must be integers from 0 through 2_147_483_647, and
 *   `keepalive` an integer from 0 through 2_147_482_647, so that Node's
 *   timer of `keepalive` plus its buffer stays within that limit; `headers`
 *   must not exceed `request` while `request` is positive, Node's own
 *   relation. Construction throws a `TypeError` otherwise. A response deadline belongs to a middleware, such as
 *   `@orkestrel/middleware`'s `createDeadline`, which aborts the exchange
 *   through `context.abort`. A startup expiry rejects with a `DOMException`
 *   named `TimeoutError`; caller cancellation rejects with the caller
 *   signal's `reason`.
 * @param sockets - `node:http` socket caps: `connections` maps to
 *   `maxConnections` (`0` rejects every incoming connection), `headers` maps
 *   to `maxHeadersCount` (`0` disables the limit), and `requests` maps to
 *   `maxRequestsPerSocket` (`0` disables the limit). Every present value must
 *   be a non-negative integer. Omitted leaves preserve node's defaults.
 * @param on - The reserved {@link EmitterHooks} for {@link ServerEventMap},
 *   wiring initial lifecycle listeners at construction.
 * @param error - The emitter's listener-error handler — a
 *   listener throw routes here, never to the domain `error` event.
 */
export interface ServerOptions<TState> {
	readonly dispatcher: DispatcherInterface<TState>
	readonly state: ConnectionStateFunction<TState>
	readonly middleware?: ReadonlyArray<MiddlewareHandler<TState>>
	readonly host?: string
	readonly port?: number
	readonly drain?: number
	readonly limit?: number
	readonly expose?: boolean
	readonly report?: (error: unknown, request?: RequestLine) => void
	readonly timeouts?: {
		readonly start?: number
		readonly request?: number
		readonly headers?: number
		readonly keepalive?: number
	}
	readonly sockets?: {
		readonly connections?: number
		readonly headers?: number
		readonly requests?: number
	}
	readonly on?: EmitterHooks<ServerEventMap>
	readonly error?: EmitterErrorHandler
}

/**
 * Represents the HTTP server facade — an observable `node:http` lifecycle that composes
 * a middleware onion (this module's own middleware seam) around a consumed
 * `@orkestrel/router` {@link DispatcherInterface}.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 *
 * @remarks
 * `use` adds middleware and `upgrade` registers a protocol-upgrade claimant,
 * both configurable before or after `start()`. `start(signal?)` binds the
 * configured `host`/`port` (an omitted/`0` port ⇒ an ephemeral port, resolved
 * from the bound address), exposes that {@link AddressInfo} through `address`,
 * observes caller cancellation plus `timeouts.start` while binding, and resolves
 * the actually-bound port. A cancelled or expired bind closes its partial server
 * and resets to `idle`. `stop()` aborts the signal of every in-flight request so
 * handlers can observe it, drains in-flight requests and claimed upgraded sockets up to
 * the configured deadline, then closes the listener and ends each connection
 * when no request exchange is open on it; when that same deadline expires it
 * destroys every socket still open. `destroy()` is the final idempotent teardown. Per request: one `Request` is
 * built through the router's `buildRequest` with the exchange's own abort signal,
 * the composed middleware onion runs terminating in
 * `dispatcher.handle`, and the result is written back through
 * `sendResponse` — every escaping throw is caught by the
 * built-in boundary (an `HTTPError` whose status `Response` admits → its
 * status; anything else → a hidden-unless-`expose` `500`) so a handler error
 * can never crash the process.
 */
export interface ServerInterface<TState> {
	/** Holds the instance's correlation id, minted once per `Server` and stable for its lifetime. */
	readonly id: string
	/** Reports the current lifecycle phase — see {@link ServerStatus}. */
	readonly status: ServerStatus
	/**
	 * Holds the bound listener's TCP port — the `port` of {@link address} — or
	 * `undefined` while no listener is active.
	 */
	readonly port: number | undefined
	/** Holds the bound listener address, or `undefined` while no listener is active. */
	readonly address: AddressInfo | undefined
	/** Holds the `@orkestrel/router` dispatcher the composed middleware onion terminates into. */
	readonly dispatcher: DispatcherInterface<TState>
	/** Holds the lifecycle emitter over {@link ServerEventMap}. */
	readonly emitter: EmitterInterface<ServerEventMap>
	/**
	 * Appends one middleware, or an array of them in order, to the onion, outer-to-inner
	 * in call order.
	 *
	 * @param middleware - One handler, or the ordered array of handlers to append
	 *
	 * @remarks
	 * Callable before or after `start()`; an appended handler runs on the next
	 * request the composed onion serves.
	 */
	use(middleware: MiddlewareHandler<TState>): void
	use(middleware: ReadonlyArray<MiddlewareHandler<TState>>): void
	/**
	 * Registers an {@link UpgradeHandler} claimant that runs in registration order; a
	 * claimed socket is tracked until it closes.
	 *
	 * @param handler - The claimant; the first to return `true` claims the socket
	 */
	upgrade(handler: UpgradeHandler): void
	/**
	 * Binds the configured `host` and `port`, or an ephemeral port, under an optional
	 * caller `AbortSignal`, and resolves the actually-bound port.
	 *
	 * @param signal - Optional caller cancellation observed only while startup
	 *   is pending; aborting after this method resolves does not stop the server.
	 * @returns The actually-bound TCP port
	 *
	 * @remarks
	 * Rejects with a {@link import('./errors.js').ServerError} of code
	 * `'STATUS'` when the current {@link ServerStatus} is neither `'idle'` nor
	 * `'stopped'`, carrying that status in its `context`. Narrow it with
	 * {@link import('./errors.js').isServerError}. A listener whose address is
	 * not an `AddressInfo` — a pipe listener, which this package's options
	 * cannot request — closes the partial listener and rejects with a
	 * `TypeError` rather than reporting `0`.
	 */
	start(signal?: AbortSignal): Promise<number>
	/**
	 * Stops gracefully within the `drain` deadline: aborts every in-flight request's signal, drains in-flight
	 * requests and claimed upgraded sockets, then closes the listener; after a clean drain it
	 * ends each connection when no request exchange is open on it, and when the deadline
	 * expires it destroys every socket still open.
	 *
	 * @remarks
	 * Drainable work is every in-flight request plus every upgraded socket a
	 * handler claimed. The drain parks on that work reaching zero or the
	 * `drain` deadline expiring, emits the `drain` event with both remaining
	 * counts, and then closes the listener. A request that arrives while the
	 * drain runs is counted and served with its signal already aborted. A
	 * request or an upgrade that a connection sends after the listener closes
	 * is refused: the server destroys that connection before the request is
	 * counted or a handler sees it. An exchange opens when a request reaches
	 * the handler and stays open until its request message and its response
	 * have closed. The `close` listeners that this tracking attaches leave when
	 * they fire, so none outlives the exchange. After a clean drain
	 * the close destroys every connection with no open exchange: an idle
	 * keep-alive one, one that never sent a request, and one partway through
	 * any header block, because a request whose headers never completed is not
	 * counted work. A connection that still carries an open exchange, including
	 * one whose handler answered while its body still uploads, ends when its
	 * last exchange completes, and the `stop()` call resolves after that
	 * connection closes. Node's `request` timeout bounds an upload that keeps
	 * sending after its response, unless `timeouts.request` is `0`, when no
	 * Node timeout bounds it. The deadline that bounds the drain therefore
	 * stays armed through this wait:
	 * when it expires before the server's `close` event, the server destroys
	 * every socket still open, as an expired drain does, so no connection
	 * holds the `stop()` call past the `drain` deadline. A request Node
	 * answers itself, such as the `417` response to an unknown `Expect` value,
	 * never reaches the handler and opens no exchange. When either count is
	 * still non-zero, the close destroys every socket at once, including the
	 * claimed upgraded ones Node's own force-close cannot reach. The `drain`
	 * counts say whether a request or a claimed socket was cut, and a cut
	 * during the clean close's wait reports `[0, 0]`, because every response
	 * had finished at the clean drain. That cut ends the unread part of an
	 * upload the handler had already answered, and destroying its socket can
	 * also reset the connection and lose the answered response the peer has
	 * not yet read. No event reports that cut or that loss. A `stop()` call
	 * made while a stop runs returns that stop's promise, including a call
	 * made from a `stop` event listener or from a listener on an aborted request signal.
	 *
	 * @returns Resolves after the listener is closed and the status is
	 *   `'stopped'`; a call from `'idle'`, `'starting'`, or `'stopped'` while
	 *   no stop runs resolves at once and changes nothing
	 */
	stop(): Promise<void>
	/**
	 * Tears down for good: force-closes the listener and every socket, then the emitter —
	 * terminal and idempotent from any state.
	 *
	 * @returns Resolves after nothing is left open; idempotent from any state
	 */
	destroy(): Promise<void>
}
