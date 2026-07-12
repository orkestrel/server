// AGENTS §12: a handler signals a client-facing fault by throwing an
// `HTTPError` carrying the HTTP `status` to send; the server's error boundary
// (§5.3 of the proposal) turns it into a response of that status. Any OTHER
// throw is a programmer/runtime error → a 500 (its message hidden unless
// `expose`). The machine-readable field here is the numeric `status` (plus an
// optional `context` bag) — `MultipartError` is NOT ported here: it moves to
// the future `@orkestrel/middleware` package with its owner (`createMultipart`).

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
 * import { HTTPError } from '@src/core'
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
 * import { ContentTooLargeError, isHTTPError } from '@src/core'
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
 * @example
 * ```ts
 * import { isHTTPError } from '@src/core'
 *
 * try {
 * 	await handle(request)
 * } catch (error) {
 * 	if (isHTTPError(error)) console.log(error.status, error.message)
 * }
 * ```
 */
export function isHTTPError(value: unknown): value is HTTPError {
	return value instanceof HTTPError
}
