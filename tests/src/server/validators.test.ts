import { describe, expect, it } from 'vitest'
import { isAddressInfo } from '@src/server'

// Mirror of `src/server/validators.ts` — the module's total guards, driven
// with the exact shapes `node:net`'s `server.address()` can return.

describe('isAddressInfo', () => {
	it('accepts an AddressInfo-shaped record with a numeric port', () => {
		expect(isAddressInfo({ address: '127.0.0.1', family: 'IPv4', port: 4000 })).toBe(true)
	})

	it('rejects a record containing only a numeric port', () => {
		expect(isAddressInfo({ port: 4000 })).toBe(false)
	})

	it('rejects a record missing its numeric port', () => {
		expect(isAddressInfo({ address: '127.0.0.1', family: 'IPv4' })).toBe(false)
	})

	it('rejects a record with a non-string family', () => {
		expect(isAddressInfo({ address: '127.0.0.1', family: 4, port: 4000 })).toBe(false)
	})

	it('rejects null, a pipe string, and a record with a non-numeric port', () => {
		expect(isAddressInfo(null)).toBe(false)
		expect(isAddressInfo('/tmp/pipe')).toBe(false)
		expect(isAddressInfo({ port: '4000' })).toBe(false)
		expect(isAddressInfo(undefined)).toBe(false)
	})
})
