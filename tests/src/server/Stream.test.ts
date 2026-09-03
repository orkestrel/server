import { describe, expect, expectTypeOf, it } from 'vitest'
import type { StreamInterface } from '@src/server'
import { Stream } from '@src/server'

// Mirror of `src/server/Stream.ts` — the SSE handle over a real
// `ReadableStream` (no mocks): the response it opens, the wire it writes, the
// process-local readiness signal, the drain wakeup, and the two ways it closes
// (the producer's `end`, and the consumer cancelling).

describe('Stream', () => {
	it('exposes boolean write readiness and an asynchronous drain wakeup', () => {
		expectTypeOf<StreamInterface['write']>().returns.toEqualTypeOf<boolean>()
		expectTypeOf<StreamInterface['drain']>().returns.toEqualTypeOf<Promise<void>>()
	})

	it('opens a Response with the SSE headers', () => {
		const stream = new Stream()
		expect(stream.response.headers.get('content-type')).toContain('text/event-stream')
		expect(stream.closed).toBe(false)
	})

	it('honors the status and merges an unrelated caller header beside the seam-owned ones', () => {
		const stream = new Stream({ status: 201, headers: { 'X-Trace': 'abc' } })
		expect(stream.response.status).toBe(201)
		expect(stream.response.headers.get('x-trace')).toBe('abc')
		expect(stream.response.headers.get('content-type')).toContain('text/event-stream')
		expect(stream.response.headers.get('cache-control')).toBe('no-cache')
	})

	it('lets a caller repeating a seam-owned key REPLACE it in any casing', () => {
		const exact = new Stream({ headers: { 'Content-Type': 'text/plain' } })
		expect(exact.response.headers.get('content-type')).toBe('text/plain')
		const recased = new Stream({ headers: { 'content-type': 'text/plain' } })
		expect(recased.response.headers.get('content-type')).toBe('text/plain')
	})

	it('is a safe no-op once ended', async () => {
		const stream = new Stream()
		stream.end()
		expect(stream.closed).toBe(true)
		expect(stream.write({ data: 'late' })).toBe(false)
		expect(() => stream.comment('late')).not.toThrow()
		await expect(stream.drain()).resolves.toBeUndefined()
		expect(() => stream.end()).not.toThrow()
	})

	it('keeps accepting events when a caller ignores the readiness signal', async () => {
		const stream = new Stream()
		expect(stream.write({ event: 'token', data: 'first' })).toBe(false)
		expect(stream.write({ event: 'token', data: 'second' })).toBe(false)
		stream.end()
		const text = await new Response(stream.response.body).text()
		expect(text).toBe('event: token\ndata: first\n\nevent: token\ndata: second\n\n')
	})

	it('writes a comment as an SSE keep-alive line a parser ignores', async () => {
		const stream = new Stream()
		stream.comment('keep-alive')
		stream.write({ data: 'after' })
		stream.end()
		const text = await new Response(stream.response.body).text()
		expect(text).toBe(': keep-alive\n\ndata: after\n\n')
	})

	it('parks at the stream high-water mark and wakes on the next consumer pull', async () => {
		const stream = new Stream()
		expect(stream.write({ data: 'queued' })).toBe(false)
		let drained = false
		const draining = stream.drain().then(() => {
			drained = true
		})
		await Promise.resolve()
		expect(drained).toBe(false)
		const body = stream.response.body
		expect(body).not.toBeNull()
		if (body === null) return
		const reader = body.getReader()
		const first = await reader.read()
		await draining
		expect(drained).toBe(true)
		expect(new TextDecoder().decode(first.value)).toBe('data: queued\n\n')
		stream.end()
		await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
	})

	it('settles a parked producer when the stream ends', async () => {
		const stream = new Stream()
		expect(stream.write({ data: 'queued' })).toBe(false)
		const draining = stream.drain()
		stream.end()
		await expect(draining).resolves.toBeUndefined()
	})

	it('flips closed and becomes a safe no-op when the CONSUMER cancels the stream', async () => {
		const stream = new Stream()
		const body = stream.response.body
		expect(body).not.toBeNull()
		if (body === null) return
		const reader = body.getReader()
		await reader.cancel()
		expect(stream.closed).toBe(true)
		expect(stream.write({ data: 'after-cancel' })).toBe(false)
		await expect(stream.drain()).resolves.toBeUndefined()
	})

	it('implements exactly StreamInterface', () => {
		const stream = new Stream()
		const check: StreamInterface = stream
		expect(check).toBe(stream)
		stream.end()
	})
})
