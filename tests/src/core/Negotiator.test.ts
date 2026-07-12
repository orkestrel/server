import { describe, expect, it } from 'vitest'
import type { MiddlewareContext } from '../../../src/core/types.js'
import { Negotiator } from '../../../src/core/Negotiator.js'
import { HTTPError } from '../../../src/core/errors.js'

// §16 mirror of `src/core/Negotiator.ts` — the content-negotiation matrix
// (media-type precedence, wildcard, q-ties broken by server order, `406`
// path, `format` dispatch).

function buildContext<TState>(state: TState): MiddlewareContext<TState> {
	return {
		url: new URL('http://localhost/'),
		method: 'GET',
		state,
		body: async () => undefined,
	}
}

describe('Negotiator#negotiate', () => {
	it('picks an exact match over a subtype wildcard and an any-range', () => {
		const negotiator = new Negotiator()
		const header = '*/*;q=0.1, text/*;q=0.5, text/html;q=0.9'
		expect(negotiator.negotiate(header, ['application/json', 'text/html'])).toBe('text/html')
	})

	it('matches a subtype wildcard when no exact entry is offered', () => {
		const negotiator = new Negotiator()
		expect(negotiator.negotiate('text/*;q=1', ['text/html', 'application/json'])).toBe('text/html')
	})

	it('matches the any-range to the first offered value', () => {
		const negotiator = new Negotiator()
		expect(negotiator.negotiate('*/*', ['application/json', 'text/html'])).toBe('application/json')
	})

	it('breaks a q-tie by SERVER (available) order, not header order', () => {
		const negotiator = new Negotiator()
		const header = 'text/html;q=0.8, application/json;q=0.8'
		expect(negotiator.negotiate(header, ['application/json', 'text/html'])).toBe('application/json')
	})

	it('never matches an explicitly rejected (`;q=0`) exact value', () => {
		const negotiator = new Negotiator()
		const header = 'text/html;q=0, */*;q=1'
		expect(negotiator.negotiate(header, ['text/html', 'application/json'])).toBe('application/json')
	})

	it('a wildcard `;q=0` only rejects the wildcard coverage, not a later exact match', () => {
		const negotiator = new Negotiator()
		const header = 'text/*;q=0, text/html;q=1'
		expect(negotiator.negotiate(header, ['text/html'])).toBe('text/html')
	})

	it('returns undefined when nothing offered is acceptable', () => {
		const negotiator = new Negotiator()
		expect(
			negotiator.negotiate('application/xml', ['application/json', 'text/html']),
		).toBeUndefined()
	})

	it('returns undefined when no available values are offered', () => {
		const negotiator = new Negotiator()
		expect(negotiator.negotiate('*/*', [])).toBeUndefined()
	})

	it('treats an empty/unparseable header as the any-range (first offered)', () => {
		const negotiator = new Negotiator()
		expect(negotiator.negotiate('', ['application/json', 'text/html'])).toBe('application/json')
	})
})

describe('Negotiator#encoding', () => {
	it('delegates to the shared negotiateEncoding helper', () => {
		const negotiator = new Negotiator()
		expect(negotiator.encoding('gzip;q=1.0, deflate;q=0.8', ['gzip', 'deflate'])).toBe('gzip')
	})

	it('honors the `*` wildcard as the first offered coding', () => {
		const negotiator = new Negotiator()
		expect(negotiator.encoding('*;q=0.5', ['gzip', 'deflate'])).toBe('gzip')
	})

	it('returns undefined when no offered coding is acceptable', () => {
		const negotiator = new Negotiator()
		expect(negotiator.encoding('br', ['gzip', 'deflate'])).toBeUndefined()
	})
})

describe('Negotiator#language', () => {
	it('matches a primary-tag prefix (`en` accepts `en-US`)', () => {
		const negotiator = new Negotiator()
		expect(negotiator.language('en-US, fr;q=0.5', ['en', 'fr'])).toBe('en')
	})

	it('prefers an exact match over a prefix match', () => {
		const negotiator = new Negotiator()
		expect(negotiator.language('en-US;q=0.9, en;q=0.5', ['en', 'en-US'])).toBe('en-US')
	})

	it('honors the `*` wildcard', () => {
		const negotiator = new Negotiator()
		expect(negotiator.language('*;q=0.3', ['en', 'fr'])).toBe('en')
	})

	it('never matches an explicitly rejected language', () => {
		const negotiator = new Negotiator()
		expect(negotiator.language('en;q=0, fr;q=0.5', ['en', 'fr'])).toBe('fr')
	})

	it('returns undefined when nothing offered is acceptable', () => {
		const negotiator = new Negotiator()
		expect(negotiator.language('de', ['en', 'fr'])).toBeUndefined()
	})
})

describe('Negotiator#format', () => {
	it('dispatches to the winning handler and returns its Response', async () => {
		const negotiator = new Negotiator()
		const request = new Request('http://localhost/', { headers: { accept: 'application/json' } })
		const response = await negotiator.format(request, buildContext(undefined), {
			'application/json': () => Response.json({ ok: true }),
			'text/html': () => new Response('<p>ok</p>', { headers: { 'content-type': 'text/html' } }),
		})
		expect(response.status).toBe(200)
		await expect(response.json()).resolves.toEqual({ ok: true })
	})

	it('treats an absent Accept header as the any-range (first handler key)', async () => {
		const negotiator = new Negotiator()
		const request = new Request('http://localhost/')
		const response = await negotiator.format(request, buildContext(undefined), {
			'text/plain': () => new Response('first'),
			'application/json': () => Response.json({ ok: true }),
		})
		await expect(response.text()).resolves.toBe('first')
	})

	it('answers 406 when nothing offered is acceptable', async () => {
		const negotiator = new Negotiator()
		const request = new Request('http://localhost/', { headers: { accept: 'application/xml' } })
		const response = await negotiator.format(request, buildContext(undefined), {
			'application/json': () => Response.json({ ok: true }),
		})
		expect(response.status).toBe(406)
	})

	it('invokes the negotiated handler with the request and context', async () => {
		const negotiator = new Negotiator()
		const request = new Request('http://localhost/', { headers: { accept: 'application/json' } })
		const context = buildContext({ userId: 'me' })
		const response = await negotiator.format(request, context, {
			'application/json': (req, ctx) => Response.json({ userId: ctx.state.userId, url: req.url }),
		})
		await expect(response.json()).resolves.toEqual({ userId: 'me', url: 'http://localhost/' })
	})

	it('propagates an HTTPError thrown by the negotiated handler unmodified', async () => {
		const negotiator = new Negotiator()
		const request = new Request('http://localhost/', { headers: { accept: 'application/json' } })
		const teapotError = new HTTPError(418, "I'm a teapot")
		await expect(
			negotiator.format(request, buildContext(undefined), {
				'application/json': () => {
					throw teapotError
				},
			}),
		).rejects.toBe(teapotError)
	})

	it('propagates a plain TypeError thrown by the negotiated handler unmodified', async () => {
		const negotiator = new Negotiator()
		const request = new Request('http://localhost/', { headers: { accept: 'application/json' } })
		const bugError = new TypeError('handler bug')
		await expect(
			negotiator.format(request, buildContext(undefined), {
				'application/json': () => {
					throw bugError
				},
			}),
		).rejects.toBe(bugError)
	})
})
