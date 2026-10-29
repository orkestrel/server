import type { ServerErrorCode } from './types.js'
import {
	holds,
	INTRINSICS,
	isFunction,
	isInstance,
	isNumber,
	isObject,
	isString,
} from '@orkestrel/contract'
import { CONTENT_TOO_LARGE_ERROR_BRAND, HTTP_ERROR_BRAND, SERVER_ERROR_BRAND } from './constants.js'

/**
 * Represents an error a handler (or middleware) throws to produce an HTTP response of a
 * specific status.
 *
 * @remarks
 * Carries the HTTP `status` to send and an optional `context` record (the
 * offending field / value). The server's built-in error boundary catches it
 * and renders a response of `status` with the error's `message` as the body
 * — so an `HTTPError`'s message is always client-facing (it is the handler's
 * deliberate signal), unlike a generic throw whose message is hidden unless
 * `expose` is set. Subclass it (as {@link ContentTooLargeError} does) for
 * specific statuses, or throw it directly. Narrow a caught value with
 * {@link isHTTPError}. The machine-readable discriminator is `status`; there is
 * no separate `code`.
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
	declare readonly [HTTP_ERROR_BRAND]: this

	constructor(status: number, message: string, context?: Readonly<Record<string, unknown>>) {
		super(message)
		Object.defineProperty(this, HTTP_ERROR_BRAND, { value: this })
		this.name = 'HTTPError'
		this.status = status
		if (context !== undefined) this.context = context
	}
}

/**
 * Represents the {@link HTTPError} thrown when a request body exceeds the body
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
		Object.defineProperty(this, CONTENT_TOO_LARGE_ERROR_BRAND, { value: this })
		this.name = 'ContentTooLargeError'
	}
}

/**
 * Narrows an unknown caught value to an {@link HTTPError}, including a subclass such
 * as {@link ContentTooLargeError}, and recognizes an instance from another copy of
 * this package through its own identity brand.
 *
 * @param value - The value to test (typically a `catch` binding)
 * @returns True if `value` is an {@link HTTPError}; false otherwise
 *
 * @remarks
 * Requires a global Error instance with a derived prototype, its own identity brand,
 * a numeric status, a string message, and an absent or object-valued context.
 * Callable contexts are accepted. Subclass names are unrestricted.
 * Transparent proxies and branded plain objects are rejected.
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
	return holds(() => {
		if (!isInstance(value, Error) || INTRINSICS.prototype(value) === Error.prototype) return false
		if (!INTRINSICS.own(value, HTTP_ERROR_BRAND)) return false
		if (INTRINSICS.describe(value, HTTP_ERROR_BRAND)?.value !== value) return false
		const context: unknown = INTRINSICS.reflect.read(value, 'context')
		return (
			isNumber(INTRINSICS.reflect.read(value, 'status')) &&
			isString(INTRINSICS.reflect.read(value, 'message')) &&
			(context === undefined || isObject(context) || isFunction(context))
		)
	})
}

/**
 * Recognizes a branded body-limit error, including subclasses and other package copies.
 *
 * @example
 * ```ts
 * isContentTooLargeError(new ContentTooLargeError(1024)) // true
 * ```
 */
export function isContentTooLargeError(value: unknown): value is ContentTooLargeError {
	return holds(
		() =>
			isHTTPError(value) &&
			INTRINSICS.own(value, CONTENT_TOO_LARGE_ERROR_BRAND) &&
			INTRINSICS.describe(value, CONTENT_TOO_LARGE_ERROR_BRAND)?.value === value,
	)
}

/**
 * Represents the error this package raises when a caller programmed a call the
 * entity refuses, carrying `'STATUS'` or `'NEXT'` as its code.
 *
 * @remarks
 * Carries a machine-readable {@link ServerErrorCode} and an optional `context`
 * record naming the offending facts. This is a programmer error, so it carries
 * no HTTP `status`: a `'STATUS'` lifecycle refusal is raised to the caller that
 * invoked the lifecycle method, and a `'NEXT'` double-`next` refusal escapes its
 * middleware into the request boundary, which reaches it as a generic 500 with
 * the message hidden unless `expose` is set. Throw an {@link HTTPError} for a
 * client-facing fault instead. Narrow a caught value with
 * {@link isServerError}.
 *
 * @example
 * ```ts
 * import { ServerError } from '@src/server'
 *
 * const error = new ServerError('STATUS', "server cannot start from 'listening'", {
 * 	status: 'listening',
 * })
 * error.code // 'STATUS'
 * ```
 */
export class ServerError extends Error {
	readonly code: ServerErrorCode
	readonly context?: Readonly<Record<string, unknown>>

	constructor(code: ServerErrorCode, message: string, context?: Readonly<Record<string, unknown>>) {
		super(message)
		Object.defineProperty(this, SERVER_ERROR_BRAND, { value: this })
		this.name = 'ServerError'
		this.code = code
		if (context !== undefined) this.context = context
	}
}

/**
 * Narrows an unknown caught value to a {@link ServerError} — the code-bearing refusal
 * of a call the caller programmed.
 *
 * @param value - The value to test (typically a `catch` binding)
 * @returns True if `value` is a {@link ServerError}; false otherwise
 *
 * @remarks
 * Requires the own identity brand, a declared code, a string message, and an absent
 * or object-valued context on a global Error with a derived prototype.
 * Callable contexts and subclasses are accepted; transparent proxies are rejected.
 *
 * @example
 * ```ts
 * import { createServer, isServerError } from '@src/server'
 * import { createDispatcher } from '@orkestrel/router'
 *
 * const server = createServer({ dispatcher: createDispatcher(), state: () => ({}) })
 * await server.start()
 * try {
 * 	await server.start()
 * } catch (error) {
 * 	if (isServerError(error)) console.log(error.code) // 'STATUS'
 * }
 * await server.stop()
 * ```
 */
export function isServerError(value: unknown): value is ServerError {
	return holds(() => {
		if (!isInstance(value, Error) || INTRINSICS.prototype(value) === Error.prototype) return false
		if (!INTRINSICS.own(value, SERVER_ERROR_BRAND)) return false
		if (INTRINSICS.describe(value, SERVER_ERROR_BRAND)?.value !== value) return false
		const code: unknown = INTRINSICS.reflect.read(value, 'code')
		const context: unknown = INTRINSICS.reflect.read(value, 'context')
		return (
			(code === 'STATUS' || code === 'NEXT') &&
			isString(INTRINSICS.reflect.read(value, 'message')) &&
			(context === undefined || isObject(context) || isFunction(context))
		)
	})
}
