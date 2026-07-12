import net from 'node:net'
import { describe, expect, it } from 'vitest'
import { discoverPort, isAddressInfo } from '@src/server'

// src/server/helpers.ts — the node-bound port helpers (real sockets, no mocks).

describe('isAddressInfo', () => {
	it('accepts an AddressInfo-shaped record with a numeric port', () => {
		expect(isAddressInfo({ address: '127.0.0.1', family: 'IPv4', port: 4000 })).toBe(true)
	})

	it('rejects null, a pipe string, and a record with a non-numeric port', () => {
		expect(isAddressInfo(null)).toBe(false)
		expect(isAddressInfo('/tmp/pipe')).toBe(false)
		expect(isAddressInfo({ port: '4000' })).toBe(false)
		expect(isAddressInfo(undefined)).toBe(false)
	})
})

describe('discoverPort', () => {
	it('resolves a free, non-zero ephemeral port with no preferred argument', async () => {
		const port = await discoverPort()
		expect(port).toBeGreaterThan(0)
	})

	it('returns the preferred port when it is free', async () => {
		const preferred = await discoverPort()
		const port = await discoverPort(preferred)
		expect(port).toBe(preferred)
	})

	it('falls back to an ephemeral port when the preferred one is taken', async () => {
		const preferred = await discoverPort()
		const holder = net.createServer()
		await new Promise<void>((resolve) => holder.listen(preferred, resolve))
		try {
			const fallback = await discoverPort(preferred)
			expect(fallback).toBeGreaterThan(0)
			expect(fallback).not.toBe(preferred)
		} finally {
			await new Promise<void>((resolve) => holder.close(() => resolve()))
		}
	})
})
