import { describe, expect, expectTypeOf, it } from 'vitest'
import type { NegotiatorInterface } from '../../../src/core/types.js'
import { createNegotiator } from '../../../src/core/factories.js'
import { Negotiator } from '../../../src/core/Negotiator.js'

// §16 mirror of `src/core/factories.ts` — `createNegotiator` round-trip
// (instance satisfies the interface) plus its return-type assertion.

describe('createNegotiator — round-trip', () => {
	it('returns a Negotiator instance implementing NegotiatorInterface', () => {
		const negotiator = createNegotiator()
		expect(negotiator).toBeInstanceOf(Negotiator)
		const check: NegotiatorInterface = negotiator
		expect(check).toBe(negotiator)
	})

	it('is independently usable — negotiate/encoding/language/format all work', async () => {
		const negotiator = createNegotiator()
		expect(negotiator.negotiate('text/html', ['text/html'])).toBe('text/html')
		expect(negotiator.encoding('gzip', ['gzip'])).toBe('gzip')
		expect(negotiator.language('en', ['en'])).toBe('en')
		const response = await negotiator.format(
			new Request('http://localhost/', { headers: { accept: 'text/plain' } }),
			{
				url: new URL('http://localhost/'),
				method: 'GET',
				state: undefined,
				body: async () => undefined,
			},
			{ 'text/plain': () => new Response('ok') },
		)
		await expect(response.text()).resolves.toBe('ok')
	})

	it('returns NegotiatorInterface — a factory return type assertion', () => {
		expectTypeOf(createNegotiator()).toEqualTypeOf<NegotiatorInterface>()
	})
})
