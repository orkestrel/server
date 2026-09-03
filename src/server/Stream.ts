import type { SSEMessage, StreamInterface, StreamOptions } from './types.js'
import { serializeEvent } from './helpers.js'
import { SSE_HEADERS } from './constants.js'

/**
 * Represents the Server-Sent-Events handle over an open, fetch-standard streaming
 * `Response`. Implements exactly {@link StreamInterface}.
 *
 * @remarks
 * Builds the `Response` at construction from
 * {@link import('./constants.js').SSE_HEADERS} with any `options.headers`
 * merged OVER them, at `options.status` (default `200`). A caller repeating one
 * of those keys therefore replaces the seam's value, in any casing. The
 * instance owns the stream's
 * controller, its text encoder, the closed flag, and the parked producer's
 * wakeup, so the whole handle is one entity rather than a closure over four
 * bindings.
 *
 * `write` serializes one message ({@link serializeEvent}), enqueues it, and
 * returns whether the controller still has positive desired size. A producer
 * receiving `false` awaits `drain()`; that promise resolves on the next
 * consumer pull restoring capacity, or on stream closure. `comment` writes a
 * `: text` keep-alive line a conforming SSE parser ignores; `end` closes the
 * stream. Every method is a SAFE NO-OP once `closed` (ended by `end()`, or
 * the consumer cancelled the stream), so a late write never throws.
 *
 * The readiness signal reflects only the process-local `ReadableStream`
 * queue — it is not proof that a remote peer consumed bytes. When the response
 * pump honors its socket sink's drain state, socket pressure stops body pulls
 * and therefore keeps this queue full, letting a cooperative producer bound
 * its buffering. Ignoring the return value preserves an unconditional-enqueue
 * producer. The default stream strategy counts chunks rather than their byte
 * length, so a byte-bounded producer must also cap each message. Return
 * `response` before awaiting a `false` write, because the consumer cannot pull
 * until it receives the response.
 *
 * @example
 * ```ts
 * import { Stream } from '@src/server'
 *
 * const stream = new Stream()
 * void Promise.resolve().then(async () => {
 * 	if (!stream.write({ event: 'token', data: 'hello' })) await stream.drain()
 * 	stream.comment('keep-alive')
 * 	stream.end()
 * })
 * // return stream.response from the route handler
 * ```
 */
export class Stream implements StreamInterface {
	readonly #encoder = new TextEncoder()
	readonly #response: Response
	#controller: ReadableStreamDefaultController<Uint8Array> | undefined
	#closed = false
	#wakeup: PromiseWithResolvers<void> | undefined

	constructor(options?: StreamOptions) {
		// The underlying source is a table of bound methods rather than inline
		// callbacks: every branch it names reaches `#` state, and instance-bound
		// work belongs in a method rather than in a function nested here.
		const body = new ReadableStream<Uint8Array>({
			start: this.#attach.bind(this),
			pull: this.#pull.bind(this),
			cancel: this.#cancel.bind(this),
		})
		// `Headers.set` matches a field name case-insensitively and replaces every
		// existing value, so any spelling of a seam-owned key wins. An object
		// spread would resolve the collision case-sensitively and leave `Headers`
		// to append the re-cased spelling into one comma-joined value.
		const headers = new Headers(SSE_HEADERS)
		for (const [name, value] of Object.entries(options?.headers ?? {})) headers.set(name, value)
		this.#response = new Response(body, { status: options?.status ?? 200, headers })
	}

	get response(): Response {
		return this.#response
	}

	get closed(): boolean {
		return this.#closed
	}

	write(message: SSEMessage): boolean {
		if (this.#closed || this.#controller === undefined) return false
		this.#enqueue(serializeEvent(message))
		return this.#controller.desiredSize !== null && this.#controller.desiredSize > 0
	}

	comment(text: string): void {
		this.#enqueue(`: ${text}\n\n`)
	}

	drain(): Promise<void> {
		const desired = this.#controller?.desiredSize
		if (this.#closed || (desired !== undefined && desired !== null && desired > 0)) {
			return Promise.resolve()
		}
		this.#wakeup ??= Promise.withResolvers<void>()
		return this.#wakeup.promise
	}

	end(): void {
		if (this.#closed) return
		this.#closed = true
		this.#controller?.close()
		this.#settle()
	}

	// The stream hands its controller over at start; every write path reads it
	// and treats an absent one as "not yet writable".
	#attach(controller: ReadableStreamDefaultController<Uint8Array>): void {
		this.#controller = controller
	}

	// A pull that restored positive desired size is the wakeup a parked
	// producer is waiting on; a pull that did not restore it changes nothing.
	#pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
		if (controller.desiredSize === null || controller.desiredSize <= 0) return
		this.#settle()
	}

	// The CONSUMER cancelled the stream: the handle is closed from the far end,
	// so a parked producer settles rather than waiting for a pull that cannot come.
	#cancel(): void {
		this.#closed = true
		this.#settle()
	}

	// Encode and enqueue one wire fragment, ignoring a closed or unstarted stream.
	#enqueue(text: string): void {
		if (this.#closed || this.#controller === undefined) return
		this.#controller.enqueue(this.#encoder.encode(text))
	}

	// Release a parked producer and drop the spent wakeup, so the next park
	// allocates a fresh one.
	#settle(): void {
		this.#wakeup?.resolve()
		this.#wakeup = undefined
	}
}
