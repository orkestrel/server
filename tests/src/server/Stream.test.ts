import type { IncomingMessage } from 'node:http'
import http from 'node:http'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { SSEStreamInterface } from '@src/server'
import { sendResponse } from '@orkestrel/router/server'
import { createSSEParser } from '@orkestrel/sse'
import { waitForEvent } from '@orkestrel/test'
import { createLoopback } from '@orkestrel/test/server'
import { ServerError, Stream } from '@src/server'
import { ServerObservation } from '../../setupServer.js'

// Mirror of `src/server/Stream.ts` — the SSE handle over a real
// `ReadableStream` (no mocks): the response it opens, the wire it writes, the
// process-local readiness signal, the drain wakeup, and the two ways it closes
// (the producer's `end`, and the consumer cancelling).

describe('Stream', () => {
	it('exposes boolean write readiness and an asynchronous drain wakeup', () => {
		expectTypeOf<SSEStreamInterface['write']>().returns.toEqualTypeOf<boolean>()
		expectTypeOf<SSEStreamInterface['drain']>().returns.toEqualTypeOf<Promise<void>>()
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
		expect(text).toBe(': \n\nevent: token\ndata: first\n\nevent: token\ndata: second\n\n')
	})

	it('writes a comment as an SSE keep-alive line a parser ignores', async () => {
		const stream = new Stream()
		stream.comment('keep-alive')
		stream.write({ data: 'after' })
		stream.end()
		const text = await new Response(stream.response.body).text()
		expect(text).toBe(': \n\n: keep-alive\n\ndata: after\n\n')
		expect(createSSEParser().parse(text)).toEqual([{ data: 'after' }])
	})

	it('opens with one comment line, so the body carries bytes before the first event', async () => {
		const stream = new Stream()
		stream.end()
		const text = await new Response(stream.response.body).text()
		expect(text).toBe(': \n\n')
		expect(createSSEParser().parse(text)).toEqual([])
	})

	it('sends the response headers through the router pump before the first event', async () => {
		const stream = new Stream()
		const loopback = await createLoopback(
			http.createServer((_incoming, target) => {
				void sendResponse(stream.response, target)
			}),
		)
		const client = http.get(loopback.url)
		client.on('error', () => undefined)
		try {
			const [response] = await waitForEvent<[IncomingMessage]>(
				(listener) => {
					client.once('response', listener)
					return () => client.off('response', listener)
				},
				'SSE response headers before the first event',
				{ budget: 2_000 },
			)
			expect(response.statusCode).toBe(200)
			expect(response.headers['content-type']).toContain('text/event-stream')
			response.resume()
		} finally {
			stream.end()
			client.destroy()
			await loopback.destroy()
		}
	})

	it('splits a multi-line comment into one comment line per line, so no line reads as a field', async () => {
		const stream = new Stream()
		stream.comment('keep-alive\n\ndata: forged\r\nevent: x\rid: 1')
		stream.end()
		const text = await new Response(stream.response.body).text()
		expect(text).toBe(': \n\n: keep-alive\n: \n: data: forged\n: event: x\n: id: 1\n\n')
		expect(createSSEParser().parse(text)).toEqual([])
	})

	it('throws on an open stream for a field the wire cannot carry and enqueues nothing', async () => {
		const stream = new Stream()
		expect(() => stream.write({ event: 'tick\ndata: injected', data: 'x' })).toThrow(ServerError)
		expect(() => stream.write({ id: '7\r', data: 'x' })).toThrow(ServerError)
		expect(() => stream.write({ retry: Number.NaN, data: 'x' })).toThrow(ServerError)
		stream.end()
		const text = await new Response(stream.response.body).text()
		expect(text).toBe(': \n\n')
	})

	it('returns false without throwing for a refused field once the stream is closed', () => {
		const stream = new Stream()
		stream.end()
		expect(stream.write({ event: 'tick\ndata: injected', data: 'x' })).toBe(false)
	})

	it('writes an ordinary event a conforming parser reads back unchanged', async () => {
		const stream = new Stream()
		stream.write({ event: 'token', id: '42', retry: 1_000, data: 'hello\nworld' })
		stream.end()
		const text = await new Response(stream.response.body).text()
		expect(createSSEParser().parse(text)).toEqual([
			{ event: 'token', id: '42', retry: 1_000, data: 'hello\nworld' },
		])
	})

	it('parks at the stream high-water mark and wakes on the next consumer pull', async () => {
		const stream = new Stream()
		expect(stream.write({ data: 'queued' })).toBe(false)
		const drained = new ServerObservation(false)
		const draining = stream.drain().then(() => {
			drained.value = true
		})
		await Promise.resolve()
		expect(drained.value).toBe(false)
		const body = stream.response.body
		expect(body).not.toBeNull()
		if (body === null) return
		const reader = body.getReader()
		const opening = await reader.read()
		expect(new TextDecoder().decode(opening.value)).toBe(': \n\n')
		const first = await reader.read()
		await draining
		expect(drained.value).toBe(true)
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

	it('implements exactly SSEStreamInterface', () => {
		const stream = new Stream()
		const check: SSEStreamInterface = stream
		expect(check).toBe(stream)
		stream.end()
	})
})
