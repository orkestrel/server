// AGENTS §12: a handler signals a client-facing fault by throwing an
// `HTTPError` carrying the HTTP `status` to send; the server's error boundary
// (§5.3 of the proposal) turns it into a response of that status. Any OTHER
// throw is a programmer/runtime error → a 500 (its message hidden unless
// `expose`). The machine-readable field here is the numeric `status` (plus an
// optional `context` bag) — `MultipartError` is NOT ported here: it moves to
// the future `@orkestrel/middleware` package with its owner (`createMultipart`).
//
// Dual-package hazard: `instanceof HTTPError` fails when the thrown value was
// constructed by a DIFFERENT copy of this package (version skew, a linked
// workspace) — the two copies' `HTTPError` constructors are distinct objects
// even though they are structurally identical. `isHTTPError` therefore tries
// `instanceof` first (the common, cheap case) and falls back to a total
// structural check keyed by a `Symbol.for`-interned brand (`HTTP_ERROR_BRAND`,
// shared across every copy via the global symbol registry) plus the exact
// fields the server's boundary reads off a recognized error (`status`,
// `message`) — so a foreign-copy instance the guard accepts can never crash
// the boundary that trusts it.

import { isNumber, isString } from '@orkestrel/contract'
import { HTTP_ERROR_BRAND } from './constants.js'

/**
 * An error a handler (or middleware) throws to produce an HTTP response of a
 * specific status.
 *
 * @remarks
 * Carries the HTTP `status` to send and an optional `context` record (the
 * offending field / value). The server's built-in error boundary catches it
 * and renders a response of `status` with the error's `message` as the body
 * — so an `HTTPError`'s message is ALWAYS client-facing (it is the handler's
 * deliberate signal), unlike a generic throw whose message is hidden unless
 * `expose` is set. Subclass it (as {@link ContentTooLargeError} does) for
 * specific statuses, or throw it directly. Narrow a caught value with
 * {@link isHTTPError}.
 *
 * @example
 * ```ts
 * import { HTTPError } from '@src/server'
 *
 * const handler = async (request: Request): Promise<Response> => {
 * 	const user = await find(new URL(request.url).searchParams.get('id'))
 * 	if (user === undefined) throw new HTTPError(404, 'user not found')
 * 	return Response.json(user)
 * }
 * ```
 */
export class HTTPError extends Error {
	readonly status: number
	readonly context?: Readonly<Record<string, unknown>>
	// The cross-copy brand (AGENTS §12 / dual-package hazard) — `isHTTPError`
	// reads it structurally when `instanceof` fails across package copies.
	// Not a public field to set by hand: the constructor is the only writer.
	readonly [HTTP_ERROR_BRAND] = true

	constructor(status: number, message: string, context?: Readonly<Record<string, unknown>>) {
		super(message)
		this.name = 'HTTPError'
		this.status = status
		this.context = context
	}
}

/**
 * The {@link HTTPError} thrown when a request body exceeds the body
 * pipeline's size limit — a `413 Content Too Large`.
 *
 * @remarks
 * Thrown by `readBody` (and the middleware context's cached `body()`) when
 * the received bytes exceed the configured {@link
 * import('./types.js').BodyOptions.limit}, carrying the `limit` in its
 * `context`. The server's error boundary renders it as a 413.
 *
 * @example
 * ```ts
 * import { ContentTooLargeError, isHTTPError } from '@src/server'
 *
 * try {
 * 	await readBody(request, { limit: 1024 })
 * } catch (error) {
 * 	if (isHTTPError(error)) console.log(error.status) // 413
 * }
 * ```
 */
export class ContentTooLargeError extends HTTPError {
	constructor(limit: number) {
		super(413, `request body exceeds the ${limit}-byte limit`, { limit })
		this.name = 'ContentTooLargeError'
	}
}

/**
 * Narrow an unknown caught value to an {@link HTTPError} (including its
 * subclasses, e.g. {@link ContentTooLargeError}).
 *
 * @param value - The value to test (typically a `catch` binding)
 * @returns `true` when `value` is an {@link HTTPError}
 *
 * @remarks
 * Tries `instanceof` first, then falls back to a total structural check for
 * an instance built by a DIFFERENT copy of this package (the dual-package
 * hazard — version skew, a linked workspace duplicate) whose `HTTPError`
 * constructor is a distinct object from this copy's: the value must carry
 * the cross-copy brand (interned via `Symbol.for`, so every copy resolves the
 * same key) AND expose the exact fields the server's error boundary reads off
 * a recognized `HTTPError` — a numeric `status` and a string `message`. A
 * plain object that merely carries a `status` WITHOUT the brand is rejected.
 *
 * @example
 * ```ts
 * import { isHTTPError } from '@src/server'
 *
 * try {
 * 	await handle(request)
 * } catch (error) {
 * 	if (isHTTPError(error)) console.log(error.status, error.message)
 * }
 * ```
 */
export function isHTTPError(value: unknown): value is HTTPError {
	if (value instanceof HTTPError) return true
	if (typeof value !== 'object' || value === null) return false
	if (!(HTTP_ERROR_BRAND in value) || value[HTTP_ERROR_BRAND] !== true) return false
	if (!('status' in value) || !('message' in value)) return false
	return isNumber(value.status) && isString(value.message)
}
