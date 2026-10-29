import { ServerBinding } from '@src/server'
import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'

describe('ServerBinding', () => {
	it('records a real bound port after the listening subscription settles', async () => {
		const server = createServer()
		const listeners = server.listeners('listening')
		const errors = server.listeners('error')
		const binding = new ServerBinding()
		const controller = new AbortController()
		expect(binding.pending).toBeUndefined()
		expect(() => binding.port).toThrow(TypeError)
		const pending = binding.subscribe(server, controller.signal)
		expect(binding.pending).toBe(pending)
		try {
			server.listen(0, '127.0.0.1')
			await pending
			binding.record(server.address())
			expect(binding.port).toBeGreaterThan(0)
			expect(server.listeners('listening')).toEqual(listeners)
			expect(server.listeners('error')).toEqual(errors)
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()))
		}
	})

	it('retains a cancelled subscription for cleanup and removes its temporary listeners', async () => {
		const server = createServer()
		const listeners = server.listeners('listening')
		const errors = server.listeners('error')
		const binding = new ServerBinding()
		const controller = new AbortController()
		const pending = binding.subscribe(server, controller.signal)
		const reason = new Error('cancel bind')
		controller.abort(reason)
		await expect(pending).rejects.toMatchObject({ name: 'AbortError', cause: reason })
		expect(binding.pending).toBe(pending)
		expect(server.listeners('listening')).toEqual(listeners)
		expect(server.listeners('error')).toEqual(errors)
	})

	it('refuses an unresolved native address before a port can be published', () => {
		const binding = new ServerBinding()
		expect(() => binding.record(null)).toThrow(
			'server bound a listener with no resolvable AddressInfo',
		)
		expect(() => binding.record('socket')).toThrow(TypeError)
		expect(() => binding.port).toThrow(TypeError)
	})
})
