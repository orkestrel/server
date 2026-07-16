import net from 'node:net'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
	ConnectionInfo,
	MiddlewareContext,
	MiddlewareHandler,
	NextFunction,
} from '@src/server'
import { createDispatcher } from '@orkestrel/router'
import {
	appendCookie,
	clearCookie,
	clientRateKey,
	codingQuality,
	compose,
	computeBodyETag,
	ContentTooLargeError,
	decodeBase64Url,
	decodeCookieValue,
	decompressRequestBody,
	discoverPort,
	encodeBase64Url,
	HTTPError,
	isAddressInfo,
	isCompressibleType,
	isCookieAttribute,
	isCookieName,
	isDangerousKey,
	isValidRequestId,
	ipv6Network,
	languageQuality,
	matchesETag,
	matchMediaType,
	mergeVary,
	negotiateEncoding,
	normalizeSecret,
	openStream,
	parseAcceptHeader,
	parseCookies,
	parseRange,
	readBody,
	readSignedCookie,
	requestEncoding,
	resolveOrigin,
	resolveSecure,
	resolveSecurityHeader,
	scrubPrototype,
	serializeCookie,
	serializeEvent,
	signToken,
	unwrapETag,
	verifyToken,
	writeSignedCookie,
} from '@src/server'

function buildContext<TState>(state: TState): MiddlewareContext<TState> {
	return {
		url: new URL('http://localhost/'),
		method: 'GET',
		state,
		body: async () => undefined,
	}
}

async function gzip(text: string): Promise<Uint8Array<ArrayBuffer>> {
	const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text))
			controller.close()
		},
	})
	const compressed = source.pipeThrough(new CompressionStream('gzip'))
	const reader = compressed.getReader()
	const chunks: Uint8Array[] = []
	let size = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		chunks.push(value)
		size += value.byteLength
	}
	const merged = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		merged.set(chunk, offset)
		offset += chunk.byteLength
	}
	return merged
}

// ── compose (the middleware onion) ───────────────────────────────────────────

describe('compose', () => {
	it('runs middleware outermost-first around the terminal', async () => {
		const order: string[] = []
		const first: MiddlewareHandler<Record<string, never>> = async (request, context, next) => {
			order.push('first-before')
			const response = await next()
			order.push('first-after')
			return response
		}
		const second: MiddlewareHandler<Record<string, never>> = async (request, context, next) => {
			order.push('second-before')
			const response = await next()
			order.push('second-after')
			return response
		}
		const handle = compose([first, second], async () => {
			order.push('terminal')
			return new Response('ok')
		})
		await handle(new Request('http://localhost/'), buildContext({}))
		expect(order).toEqual([
			'first-before',
			'second-before',
			'terminal',
			'second-after',
			'first-after',
		])
	})

	it('rejects a second call to the same next()', async () => {
		const doubleNext: MiddlewareHandler<Record<string, never>> = async (request, context, next) => {
			await next()
			return next()
		}
		const handle = compose([doubleNext], async () => new Response('ok'))
		await expect(handle(new Request('http://localhost/'), buildContext({}))).rejects.toThrow(
			'next() was already called by this middleware',
		)
	})

	it('rejects the second of two CONCURRENT next() calls from the same middleware', async () => {
		const concurrentDoubleNext: MiddlewareHandler<Record<string, never>> = async (
			request,
			context,
			next,
		) => {
			const results = await Promise.allSettled([next(), next()])
			const rejected = results.find((result) => result.status === 'rejected')
			if (rejected === undefined || rejected.status !== 'rejected') {
				throw new Error('expected one of the concurrent next() calls to reject')
			}
			return new Response(rejected.reason instanceof Error ? rejected.reason.message : 'unknown')
		}
		const handle = compose([concurrentDoubleNext], async () => new Response('ok'))
		const response = await handle(new Request('http://localhost/'), buildContext({}))
		await expect(response.text()).resolves.toBe('next() was already called by this middleware')
	})

	it('short-circuits when a middleware never calls next', async () => {
		let terminalRan = false
		const shortCircuit: MiddlewareHandler<Record<string, never>> = async () =>
			new Response('blocked', { status: 403 })
		const handle = compose([shortCircuit], async () => {
			terminalRan = true
			return new Response('ok')
		})
		const response = await handle(new Request('http://localhost/'), buildContext({}))
		expect(response.status).toBe(403)
		expect(terminalRan).toBe(false)
	})

	it('substitutes the downstream request via next(newRequest)', async () => {
		let seenUrl = ''
		const substitute: MiddlewareHandler<Record<string, never>> = async (request, context, next) =>
			next(new Request('http://localhost/substituted'))
		const handle = compose([substitute], async (request) => {
			seenUrl = request.url
			return new Response('ok')
		})
		await handle(new Request('http://localhost/original'), buildContext({}))
		expect(seenUrl).toBe('http://localhost/substituted')
	})

	it('lets a middleware transform the response after next()', async () => {
		const addHeader: MiddlewareHandler<Record<string, never>> = async (request, context, next) => {
			const response = await next()
			response.headers.set('x-test', 'yes')
			return response
		}
		const handle = compose([addHeader], async () => new Response('ok'))
		const response = await handle(new Request('http://localhost/'), buildContext({}))
		expect(response.headers.get('x-test')).toBe('yes')
	})

	it('a short-circuit skips downstream but an outer middleware still post-processes the response', async () => {
		let terminalRan = false
		let downstreamRan = false
		const outer: MiddlewareHandler<Record<string, never>> = async (request, context, next) => {
			const response = await next()
			response.headers.set('x-outer', 'seen')
			return response
		}
		const shortCircuit: MiddlewareHandler<Record<string, never>> = async () => {
			downstreamRan = true
			return new Response('blocked', { status: 403 })
		}
		const handle = compose([outer, shortCircuit], async () => {
			terminalRan = true
			return new Response('ok')
		})
		const response = await handle(new Request('http://localhost/'), buildContext({}))
		expect(response.status).toBe(403)
		expect(response.headers.get('x-outer')).toBe('seen')
		expect(terminalRan).toBe(false)
		expect(downstreamRan).toBe(true)
	})

	it('threads state written by middleware through to a route handler behind a real Dispatcher', async () => {
		interface RequestState {
			userId?: string
		}
		const dispatcher = createDispatcher<RequestState>()
		dispatcher.add({
			method: 'GET',
			path: '/whoami/:id',
			handler: (_request, context) =>
				Response.json({ params: context.params, userId: context.state.userId }),
		})
		const stashUser: MiddlewareHandler<RequestState> = async (request, context, next) => {
			context.state.userId = 'user-42'
			return next(request)
		}
		const handle = compose([stashUser], (request, context) =>
			dispatcher.handle(request, context.state),
		)
		const state: RequestState = {}
		const request = new Request('http://localhost/whoami/7')
		const response = await handle(request, {
			url: new URL(request.url),
			method: request.method,
			state,
			body: async () => undefined,
		})
		const body = (await response.json()) as {
			readonly params: { readonly id: string }
			readonly userId?: string
		}
		expect(body.params).toEqual({ id: '7' })
		expect(body.userId).toBe('user-42')
	})
})

// ── Type-level: the middleware seam's generics ───────────────────────────────

describe('MiddlewareContext<TState> / NextFunction / MiddlewareHandler<TState> — type shape', () => {
	it('types context.state and context.url/method/body from TState', () => {
		interface AppState {
			readonly userId: string
		}
		const context: MiddlewareContext<AppState> = {
			url: new URL('http://localhost/'),
			method: 'GET',
			state: { userId: 'me' },
			body: async () => undefined,
		}
		expectTypeOf(context.state).toEqualTypeOf<AppState>()
		expectTypeOf(context.url).toEqualTypeOf<URL>()
		expectTypeOf(context.method).toEqualTypeOf<string>()
		expectTypeOf(context.body).returns.toEqualTypeOf<Promise<unknown>>()
	})

	it('types NextFunction as an optional-Request-in, Promise<Response>-out continuation', () => {
		expectTypeOf<NextFunction>().parameter(0).toEqualTypeOf<Request | undefined>()
		expectTypeOf<NextFunction>().returns.toEqualTypeOf<Promise<Response>>()
	})

	it('types MiddlewareHandler<TState> as (request, context, next) => Response | Promise<Response>', () => {
		interface AppState {
			readonly userId: string
		}
		expectTypeOf<MiddlewareHandler<AppState>>().parameter(0).toEqualTypeOf<Request>()
		expectTypeOf<MiddlewareHandler<AppState>>()
			.parameter(1)
			.toEqualTypeOf<MiddlewareContext<AppState>>()
		expectTypeOf<MiddlewareHandler<AppState>>().parameter(2).toEqualTypeOf<NextFunction>()
		expectTypeOf<MiddlewareHandler<AppState>>().returns.toEqualTypeOf<
			Response | Promise<Response>
		>()
	})
})

describe('ConnectionInfo — shape', () => {
	it('exposes an optional ip and a required encrypted boolean', () => {
		expectTypeOf<ConnectionInfo>().toHaveProperty('ip')
		expectTypeOf<ConnectionInfo['ip']>().toEqualTypeOf<string | undefined>()
		expectTypeOf<ConnectionInfo['encrypted']>().toEqualTypeOf<boolean>()
		const connection: ConnectionInfo = { encrypted: false }
		expectTypeOf(connection).toEqualTypeOf<ConnectionInfo>()
	})
})

// ── Cookies ───────────────────────────────────────────────────────────────────

describe('parseCookies', () => {
	it('parses a simple cookie header', () => {
		expect(parseCookies('session=abc; theme=dark')).toEqual({ session: 'abc', theme: 'dark' })
	})

	it('rejects a whitespace-padded protected cookie name (__Host- spoof)', () => {
		expect(parseCookies('  __Host-session=evil')).toEqual({})
	})

	it('is total on an absent header', () => {
		expect(parseCookies(undefined)).toEqual({})
	})

	it('URL-decodes values, skips malformed pairs', () => {
		expect(parseCookies('a=hello%20world; noeq; b=x')).toEqual({ a: 'hello world', b: 'x' })
	})

	it('a later duplicate name wins', () => {
		expect(parseCookies('a=1; a=2')).toEqual({ a: '2' })
	})
})

describe('isCookieName', () => {
	it('accepts a valid token', () => {
		expect(isCookieName('__Host-session')).toBe(true)
	})

	it('rejects whitespace anywhere', () => {
		expect(isCookieName(' session')).toBe(false)
		expect(isCookieName('session ')).toBe(false)
	})
})

describe('decodeCookieValue', () => {
	it('decodes percent-encoding', () => {
		expect(decodeCookieValue('a%20b')).toBe('a b')
	})

	it('falls back to raw text on malformed escapes', () => {
		expect(decodeCookieValue('%')).toBe('%')
	})
})

describe('serializeCookie / isCookieAttribute', () => {
	it('serializes with the canonical attribute order and defaults', () => {
		expect(serializeCookie('session', 'abc')).toBe('session=abc; Path=/; HttpOnly; SameSite=Lax')
	})

	it('throws on Domain injection', () => {
		expect(() => serializeCookie('a', 'b', { domain: 'evil.com; Secure' })).toThrow(HTTPError)
	})

	it('throws on Path injection', () => {
		expect(() => serializeCookie('a', 'b', { path: '/a\r\nSet-Cookie: x=y' })).toThrow(HTTPError)
	})

	it('forces Secure when SameSite=None regardless of the secure option', () => {
		const cookie = serializeCookie('a', 'b', { sameSite: 'None', secure: false })
		expect(cookie).toContain('Secure')
		expect(cookie).toContain('SameSite=None')
	})

	it('emits Max-Age=0 distinctly from an omitted maxAge', () => {
		expect(serializeCookie('a', 'b', { maxAge: 0 })).toContain('Max-Age=0')
		expect(serializeCookie('a', 'b')).not.toContain('Max-Age')
	})

	it('isCookieAttribute rejects control chars, commas, and semicolons', () => {
		expect(isCookieAttribute('example.com')).toBe(true)
		expect(isCookieAttribute('a;b')).toBe(false)
		expect(isCookieAttribute('a,b')).toBe(false)
		expect(isCookieAttribute('a\r\nb')).toBe(false)
	})
})

describe('resolveSecure', () => {
	it('honors explicit overrides', () => {
		expect(resolveSecure(true, false)).toBe(true)
		expect(resolveSecure(false, true)).toBe(false)
	})

	it('derives from the connection when omitted', () => {
		expect(resolveSecure(undefined, true)).toBe(true)
		expect(resolveSecure(undefined, false)).toBe(false)
	})
})

describe('appendCookie / clearCookie', () => {
	it('appends without clobbering a prior Set-Cookie', () => {
		const headers = new Headers()
		appendCookie(headers, serializeCookie('a', '1'))
		appendCookie(headers, serializeCookie('b', '2'))
		const value = headers.get('set-cookie') ?? ''
		expect(value).toContain('a=1')
		expect(value).toContain('b=2')
	})

	it('clearCookie writes a Max-Age=0 expiry', () => {
		const headers = new Headers()
		clearCookie(headers, 'session')
		expect(headers.get('set-cookie')).toContain('Max-Age=0')
	})
})

describe('writeSignedCookie / readSignedCookie', () => {
	it('round-trips a signed cookie value', async () => {
		const headers = new Headers()
		await writeSignedCookie(headers, 'session', 'user-1', 'shh')
		const cookieHeader = headers.get('set-cookie') ?? ''
		const nameValue = cookieHeader.split(';')[0]
		const request = new Request('http://localhost/', { headers: { cookie: nameValue } })
		await expect(readSignedCookie(request, 'session', 'shh')).resolves.toBe('user-1')
	})

	it('rejects a tampered signed cookie', async () => {
		const headers = new Headers()
		await writeSignedCookie(headers, 'session', 'user-1', 'shh')
		const cookieHeader = headers.get('set-cookie') ?? ''
		const [name, encoded] = (cookieHeader.split(';')[0] ?? '').split('=')
		const tampered = `${name}=${encoded}tampered`
		const request = new Request('http://localhost/', { headers: { cookie: tampered } })
		await expect(readSignedCookie(request, 'session', 'shh')).resolves.toBeUndefined()
	})

	it('an absent cookie reads as undefined', async () => {
		const request = new Request('http://localhost/')
		await expect(readSignedCookie(request, 'session', 'shh')).resolves.toBeUndefined()
	})

	it('emits the requested attributes onto the Set-Cookie header, not just the value round-trip', async () => {
		const headers = new Headers()
		await writeSignedCookie(headers, 'session', 'user-1', 'shh', {
			path: '/account',
			httpOnly: true,
			sameSite: 'Strict',
		})
		const cookieHeader = headers.get('set-cookie') ?? ''
		expect(cookieHeader).toContain('Path=/account')
		expect(cookieHeader).toContain('HttpOnly')
		expect(cookieHeader).toContain('SameSite=Strict')
	})
})

// ── Tokens (WebCrypto async) ──────────────────────────────────────────────────

describe('signToken / verifyToken', () => {
	it('round-trips a value', async () => {
		const token = await signToken('client', { secret: 'shh' })
		await expect(verifyToken(token, 'shh')).resolves.toBe('client')
	})

	it('is total: a malformed token yields undefined, never throws', async () => {
		await expect(verifyToken('not-a-token', 'shh')).resolves.toBeUndefined()
		await expect(verifyToken('', 'shh')).resolves.toBeUndefined()
		await expect(verifyToken('a.b.c', 'shh')).resolves.toBeUndefined()
	})

	it('rejects a tampered payload', async () => {
		const token = await signToken('client', { secret: 'shh' })
		const [payload, signature] = token.split('.')
		const tampered = `${payload}x.${signature}`
		await expect(verifyToken(tampered, 'shh')).resolves.toBeUndefined()
	})

	it('rejects a wrong secret', async () => {
		const token = await signToken('client', { secret: 'shh' })
		await expect(verifyToken(token, 'other')).resolves.toBeUndefined()
	})

	it('honors a ttl, rejecting an expired token', async () => {
		const token = await signToken('client', { secret: 'shh', ttl: -1 })
		await expect(verifyToken(token, 'shh')).resolves.toBeUndefined()
	})

	it('accepts a token signed under any secret in a rotation list', async () => {
		const token = await signToken('client', { secret: 'old' })
		await expect(verifyToken(token, ['new', 'old'])).resolves.toBe('client')
	})

	it('signs with the FIRST secret of a rotation list', async () => {
		const token = await signToken('client', { secret: ['current', 'previous'] })
		await expect(verifyToken(token, 'current')).resolves.toBe('client')
		await expect(verifyToken(token, 'previous')).resolves.toBeUndefined()
	})

	it('signToken throws on an empty secret (fail-closed)', async () => {
		await expect(signToken('client', { secret: '' })).rejects.toThrow(HTTPError)
	})

	it('verifyToken returns undefined on an empty rotation list', async () => {
		await expect(verifyToken('x.y', [])).resolves.toBeUndefined()
	})

	it('rejects a payload whose exp was tampered but re-signed with the ORIGINAL signature', async () => {
		const token = await signToken('client', { secret: 'shh', ttl: 1000 })
		const dot = token.lastIndexOf('.')
		const encoded = token.slice(0, dot)
		const signature = token.slice(dot + 1)
		const payloadText = new TextDecoder().decode(decodeBase64Url(encoded))
		const payload: unknown = JSON.parse(payloadText)
		const tamperedPayload = {
			...(typeof payload === 'object' && payload !== null ? payload : {}),
			exp: Date.now() + 1_000_000,
		}
		const tamperedEncoded = encodeBase64Url(
			new TextEncoder().encode(JSON.stringify(tamperedPayload)),
		)
		const tamperedToken = `${tamperedEncoded}.${signature}`
		await expect(verifyToken(tamperedToken, 'shh')).resolves.toBeUndefined()
	})
})

describe('normalizeSecret', () => {
	it('drops blank entries, keeps real ones in order', () => {
		expect(normalizeSecret(['new', '', '  ', 'old'])).toEqual(['new', 'old'])
	})

	it('wraps a single string', () => {
		expect(normalizeSecret('shh')).toEqual(['shh'])
	})
})

// ── Negotiation ────────────────────────────────────────────────────────────────

describe('parseAcceptHeader', () => {
	it('sorts entries by q descending, preserving order within a tie', () => {
		expect(parseAcceptHeader('br;q=1.0, gzip;q=0.8, identity;q=0')).toEqual([
			{ value: 'br', q: 1 },
			{ value: 'gzip', q: 0.8 },
			{ value: 'identity', q: 0 },
		])
	})

	it('defaults an absent q to 1', () => {
		expect(parseAcceptHeader('text/html')).toEqual([{ value: 'text/html', q: 1 }])
	})

	it('is linear-time on a long, adversarial header (ReDoS sanity)', () => {
		const header = `${'a;q=0.'.repeat(20_000)}1`
		const start = performance.now()
		parseAcceptHeader(header)
		expect(performance.now() - start).toBeLessThan(500)
	})

	it('is total on a malformed header', () => {
		expect(parseAcceptHeader('')).toEqual([])
		expect(parseAcceptHeader(',,,')).toEqual([])
	})
})

describe('codingQuality / negotiateEncoding', () => {
	it('scores an exact match over a wildcard', () => {
		const entries = parseAcceptHeader('gzip;q=0.5, *;q=0.1')
		expect(codingQuality(entries, 'gzip')).toBe(0.5)
		expect(codingQuality(entries, 'br')).toBe(0.1)
	})

	it('an explicit ;q=0 rejects even with a wildcard present', () => {
		const entries = parseAcceptHeader('gzip;q=0, *;q=1')
		expect(codingQuality(entries, 'gzip')).toBe(0)
	})

	it('negotiates in server preference order on a client tie', () => {
		expect(negotiateEncoding('gzip;q=1.0, deflate;q=1.0', ['deflate', 'gzip'])).toBe('deflate')
	})

	it('returns undefined when nothing acceptable is offered', () => {
		expect(negotiateEncoding('br;q=1.0', ['gzip', 'deflate'])).toBeUndefined()
	})
})

describe('matchMediaType', () => {
	it('exact match ranks 0 at q 1', () => {
		const entries = parseAcceptHeader('text/html')
		expect(matchMediaType(entries, 'text/html')).toEqual({ q: 1, rank: 0 })
	})

	it('subtype wildcard ranks 1', () => {
		const entries = parseAcceptHeader('text/*;q=0.8')
		expect(matchMediaType(entries, 'text/plain')).toEqual({ q: 0.8, rank: 1 })
	})

	it('any-range wildcard ranks 2', () => {
		const entries = parseAcceptHeader('*/*;q=0.5')
		expect(matchMediaType(entries, 'application/json')).toEqual({ q: 0.5, rank: 2 })
	})

	it('is undefined on a mismatch', () => {
		const entries = parseAcceptHeader('text/html')
		expect(matchMediaType(entries, 'application/json')).toBeUndefined()
	})

	it('an exact ;q=0 rejects outright', () => {
		const entries = parseAcceptHeader('text/html;q=0')
		expect(matchMediaType(entries, 'text/html')).toBeUndefined()
	})

	it('a wildcard ;q=0 only rejects the wildcard coverage, not a more-specific match', () => {
		const entries = parseAcceptHeader('*/*;q=0, text/html;q=0.5')
		expect(matchMediaType(entries, 'text/html')).toEqual({ q: 0.5, rank: 0 })
		expect(matchMediaType(entries, 'application/json')).toBeUndefined()
	})
})

describe('languageQuality', () => {
	it('exact match', () => {
		const entries = parseAcceptHeader('en-US, en;q=0.8')
		expect(languageQuality(entries, 'en-US')).toBe(1)
	})

	it('primary-tag prefix match', () => {
		const entries = parseAcceptHeader('en;q=0.8')
		expect(languageQuality(entries, 'en-US')).toBe(0.8)
	})

	it('wildcard match', () => {
		const entries = parseAcceptHeader('*;q=0.5')
		expect(languageQuality(entries, 'fr')).toBe(0.5)
	})

	it('is 0 on a ;q=0 rejection', () => {
		const entries = parseAcceptHeader('en;q=0')
		expect(languageQuality(entries, 'en')).toBe(0)
	})

	it('is 0 when nothing matches', () => {
		const entries = parseAcceptHeader('fr')
		expect(languageQuality(entries, 'en')).toBe(0)
	})
})

describe('requestEncoding', () => {
	it('recognizes gzip', () => {
		expect(requestEncoding('gzip')).toBe('gzip')
	})

	it('recognizes deflate', () => {
		expect(requestEncoding('deflate')).toBe('deflate')
	})

	it('is undefined for identity', () => {
		expect(requestEncoding('identity')).toBeUndefined()
	})

	it('is undefined for an unsupported coding (br)', () => {
		expect(requestEncoding('br')).toBeUndefined()
	})

	it('is undefined for an absent header', () => {
		expect(requestEncoding(null)).toBeUndefined()
	})
})

describe('isCompressibleType', () => {
	it('accepts text/* and structured suffixes', () => {
		expect(isCompressibleType('text/html; charset=utf-8')).toBe(true)
		expect(isCompressibleType('image/svg+xml')).toBe(true)
		expect(isCompressibleType('application/json')).toBe(true)
	})

	it('rejects already-compressed binaries and empty types', () => {
		expect(isCompressibleType('image/png')).toBe(false)
		expect(isCompressibleType('')).toBe(false)
	})
})

// ── Conditional requests (ETag / Range) ────────────────────────────────────────

describe('computeBodyETag / matchesETag / unwrapETag', () => {
	it('computes a stable weak ETag by default', async () => {
		const body = new TextEncoder().encode('hello')
		const etag = await computeBodyETag(body)
		expect(etag.startsWith('W/"')).toBe(true)
		expect(await computeBodyETag(body)).toBe(etag)
	})

	it('computes a strong ETag when weak is false', async () => {
		const etag = await computeBodyETag(new TextEncoder().encode('hello'), false)
		expect(etag.startsWith('W/')).toBe(false)
		expect(etag.startsWith('"')).toBe(true)
	})

	it('matches weak-vs-strong per RFC 7232 §2.3.2', () => {
		expect(matchesETag('"abc"', 'W/"abc"')).toBe(true)
		expect(matchesETag('W/"abc"', '"abc"')).toBe(true)
	})

	it('honors the * wildcard', () => {
		expect(matchesETag('*', 'W/"anything"')).toBe(true)
	})

	it('matches any member of a comma-list', () => {
		expect(matchesETag('"x", W/"y", "z"', 'W/"y"')).toBe(true)
		expect(matchesETag('"x", "z"', 'W/"y"')).toBe(false)
	})

	it('unwrapETag strips only the weak prefix', () => {
		expect(unwrapETag('W/"abc"')).toBe('"abc"')
		expect(unwrapETag('"abc"')).toBe('"abc"')
	})
})

describe('parseRange', () => {
	it('parses a closed range', () => {
		expect(parseRange('bytes=0-99', 1000)).toEqual({ satisfiable: true, start: 0, end: 99 })
	})

	it('parses an open range to the end', () => {
		expect(parseRange('bytes=500-', 1000)).toEqual({ satisfiable: true, start: 500, end: 999 })
	})

	it('parses a suffix range', () => {
		expect(parseRange('bytes=-100', 1000)).toEqual({ satisfiable: true, start: 900, end: 999 })
	})

	it('marks a wholly-past range unsatisfiable', () => {
		expect(parseRange('bytes=2000-3000', 1000)).toEqual({ satisfiable: false })
	})

	it('refuses a multi-range header (undefined ⇒ serve whole resource)', () => {
		expect(parseRange('bytes=0-1, 2-3', 1000)).toBeUndefined()
	})

	it('is total on an absent / malformed header', () => {
		expect(parseRange(undefined, 1000)).toBeUndefined()
		expect(parseRange('bytes=abc-def', 1000)).toBeUndefined()
		expect(parseRange('items=0-1', 1000)).toBeUndefined()
	})
})

// ── Security primitives ─────────────────────────────────────────────────────────

describe('resolveOrigin', () => {
	it('passes a wildcard or single-origin policy through', () => {
		expect(resolveOrigin('*', 'https://a.example')).toBe('*')
		expect(resolveOrigin('https://a.example', 'https://b.example')).toBe('https://a.example')
	})

	it('echoes a listed origin from an allow-list', () => {
		expect(resolveOrigin(['https://a.example', 'https://b.example'], 'https://b.example')).toBe(
			'https://b.example',
		)
	})

	it('never reflects the literal null origin, even if listed', () => {
		expect(resolveOrigin(['null'], 'null')).toBeUndefined()
	})

	it('returns undefined for an unlisted origin', () => {
		expect(resolveOrigin(['https://a.example'], 'https://evil.example')).toBeUndefined()
	})
})

describe('mergeVary', () => {
	it('adds a new value', () => {
		expect(mergeVary(undefined, 'Origin')).toBe('Origin')
		expect(mergeVary('Accept-Encoding', 'Origin')).toBe('Accept-Encoding, Origin')
	})

	it('does not duplicate an existing value, case-insensitively', () => {
		expect(mergeVary('Origin', 'origin')).toBe('Origin')
	})

	it('drops an empty existing member instead of leaving a leading empty entry', () => {
		expect(mergeVary('', 'Origin')).toBe('Origin')
	})
})

describe('resolveSecurityHeader', () => {
	it('uses the fallback when unset', () => {
		expect(resolveSecurityHeader(undefined, 'DENY')).toBe('DENY')
	})

	it('omits the header on false', () => {
		expect(resolveSecurityHeader(false, 'DENY')).toBeUndefined()
	})

	it('honors an explicit override', () => {
		expect(resolveSecurityHeader('SAMEORIGIN', 'DENY')).toBe('SAMEORIGIN')
	})
})

describe('isValidRequestId', () => {
	it('accepts the safe charset', () => {
		expect(isValidRequestId('req_abc-123')).toBe(true)
	})

	it('rejects CRLF / control chars', () => {
		expect(isValidRequestId('bad\r\nheader')).toBe(false)
		expect(isValidRequestId('bad\x00id')).toBe(false)
	})

	it('rejects an oversized id', () => {
		expect(isValidRequestId('a'.repeat(201))).toBe(false)
	})

	it('rejects an empty id', () => {
		expect(isValidRequestId('')).toBe(false)
	})
})

describe('ipv6Network / clientRateKey', () => {
	it('collapses a full IPv6 address to its /64 network', () => {
		expect(ipv6Network('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64')
		expect(ipv6Network('2001:db8:1:2:dead:beef:0:9')).toBe('2001:db8:1:2::/64')
	})

	it('strips a zone id before expanding', () => {
		expect(ipv6Network('fe80::1%eth0')).toBe('fe80:0:0:0::/64')
	})

	it('does not collapse an IPv4-mapped address', () => {
		expect(ipv6Network('::ffff:192.0.2.1')).toBeUndefined()
	})

	it('is undefined for a plain IPv4 address', () => {
		expect(ipv6Network('192.0.2.1')).toBeUndefined()
	})

	it('clientRateKey collapses IPv6 but leaves IPv4 unchanged', () => {
		expect(clientRateKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64')
		expect(clientRateKey('192.0.2.1')).toBe('192.0.2.1')
	})
})

// ── SSE ────────────────────────────────────────────────────────────────────────

describe('serializeEvent', () => {
	it('serializes a full message', () => {
		expect(serializeEvent({ event: 'token', data: 'hello', id: '1', retry: 500 })).toBe(
			'event: token\nid: 1\nretry: 500\ndata: hello\n\n',
		)
	})

	it('splits multi-line data into one data: line per segment', () => {
		expect(serializeEvent({ data: 'multi\nline' })).toBe('data: multi\ndata: line\n\n')
	})

	it('emits only the present fields', () => {
		expect(serializeEvent({ data: 'x' })).toBe('data: x\n\n')
	})

	it('splits CRLF-embedded data into two data: lines with no raw CR on the wire', () => {
		const wire = serializeEvent({ data: 'a\r\nb' })
		expect(wire).toBe('data: a\ndata: b\n\n')
		expect(wire).not.toContain('\r')
	})
})

describe('openStream', () => {
	it('opens a Response with the SSE headers', () => {
		const stream = openStream()
		expect(stream.response.headers.get('content-type')).toContain('text/event-stream')
		expect(stream.closed).toBe(false)
	})

	it('is a safe no-op once ended', async () => {
		const stream = openStream()
		stream.end()
		expect(stream.closed).toBe(true)
		expect(() => stream.write({ data: 'late' })).not.toThrow()
		expect(() => stream.comment('late')).not.toThrow()
		expect(() => stream.end()).not.toThrow()
	})

	it('round-trips written events onto the response body', async () => {
		const stream = openStream()
		stream.write({ event: 'token', data: 'hi' })
		stream.end()
		const text = await new Response(stream.response.body).text()
		expect(text).toBe('event: token\ndata: hi\n\n')
	})

	it('flips closed and becomes a safe no-op when the CONSUMER cancels the stream', async () => {
		const stream = openStream()
		const body = stream.response.body
		expect(body).not.toBeNull()
		if (body === null) return
		const reader = body.getReader()
		await reader.cancel()
		expect(stream.closed).toBe(true)
		expect(() => stream.write({ data: 'after-cancel' })).not.toThrow()
	})
})

// ── Prototype-pollution scrub ────────────────────────────────────────────────────

describe('isDangerousKey / scrubPrototype', () => {
	it('flags the three pollution vectors', () => {
		expect(isDangerousKey('__proto__')).toBe(true)
		expect(isDangerousKey('constructor')).toBe(true)
		expect(isDangerousKey('prototype')).toBe(true)
		expect(isDangerousKey('name')).toBe(false)
	})

	it('strips a dangerous key at the top level', () => {
		const value = scrubPrototype(JSON.parse('{"__proto__":{"polluted":true},"name":"ok"}'))
		expect(value).toEqual({ name: 'ok' })
	})

	it('strips a dangerous key at every depth, including array elements', () => {
		const value = scrubPrototype(
			JSON.parse('[{"a":{"constructor":{"x":1},"b":2}},{"prototype":{}}]'),
		)
		expect(value).toEqual([{ a: { b: 2 } }, {}])
	})

	it('leaves primitives and clean structures untouched', () => {
		expect(scrubPrototype(42)).toBe(42)
		expect(scrubPrototype(null)).toBeNull()
		expect(scrubPrototype({ a: 1, b: [1, 2] })).toEqual({ a: 1, b: [1, 2] })
	})
})

// ── Body pipeline (readBody) ───────────────────────────────────────────────────

describe('readBody', () => {
	it('decodes an empty body as undefined', async () => {
		const request = new Request('http://localhost/', { method: 'POST' })
		await expect(readBody(request)).resolves.toBeUndefined()
	})

	it('parses application/json and scrubs prototype-pollution keys', async () => {
		const request = new Request('http://localhost/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{"__proto__":{"polluted":true},"name":"ok"}',
		})
		await expect(readBody(request)).resolves.toEqual({ name: 'ok' })
	})

	it('decodes a non-JSON content type as raw text', async () => {
		const request = new Request('http://localhost/', {
			method: 'POST',
			headers: { 'content-type': 'text/plain' },
			body: 'hello world',
		})
		await expect(readBody(request)).resolves.toBe('hello world')
	})

	it('resolves malformed application/json to undefined instead of throwing', async () => {
		const request = new Request('http://localhost/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: 'not json',
		})
		await expect(readBody(request)).resolves.toBeUndefined()
	})

	it('rejects a wire body over the limit with a 413', async () => {
		const request = new Request('http://localhost/', { method: 'POST', body: 'x'.repeat(100) })
		await expect(readBody(request, { limit: 10 })).rejects.toThrow(ContentTooLargeError)
	})

	it('transparently decompresses a gzip body', async () => {
		const compressed = await gzip('{"greeting":"hi"}')
		const request = new Request('http://localhost/', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
			body: compressed,
		})
		await expect(readBody(request)).resolves.toEqual({ greeting: 'hi' })
	})

	it('zip-bomb: aborts before materializing when decompressed output exceeds the cap', async () => {
		const compressed = await gzip('x'.repeat(1_000_000))
		const request = new Request('http://localhost/', {
			method: 'POST',
			headers: { 'content-encoding': 'gzip' },
			body: compressed,
		})
		await expect(readBody(request, { limit: 2_000_000, decompression: 1000 })).rejects.toThrow(
			ContentTooLargeError,
		)
	})

	it('isolation case: a payload under the wire limit but over the decompression cap is a 413, not a pass', async () => {
		const compressed = await gzip('y'.repeat(500_000))
		expect(compressed.byteLength).toBeLessThan(50_000)
		const request = new Request('http://localhost/', {
			method: 'POST',
			headers: { 'content-encoding': 'gzip' },
			body: compressed,
		})
		await expect(readBody(request, { limit: 50_000, decompression: 10_000 })).rejects.toThrow(
			ContentTooLargeError,
		)
	})

	it('a corrupt compressed stream maps to a distinct 400, not a 413', async () => {
		const request = new Request('http://localhost/', {
			method: 'POST',
			headers: { 'content-encoding': 'gzip' },
			body: new Uint8Array([1, 2, 3, 4, 5]),
		})
		let caught: unknown
		try {
			await readBody(request, { limit: 1000, decompression: 1000 })
		} catch (error) {
			caught = error
		}
		expect(caught).toBeInstanceOf(HTTPError)
		expect(caught instanceof ContentTooLargeError).toBe(false)
		const status = caught instanceof HTTPError ? caught.status : undefined
		expect(status).toBe(400)
	})
})

describe('decompressRequestBody', () => {
	it('decompresses gzip bytes back to their original content', async () => {
		const compressed = await gzip('hello world')
		const bytes = await decompressRequestBody(compressed, 'gzip', 1_000_000)
		expect(new TextDecoder().decode(bytes)).toBe('hello world')
	})

	it('an uncapped (non-positive) cap allows a large decompressed output', async () => {
		const compressed = await gzip('z'.repeat(200_000))
		const bytes = await decompressRequestBody(compressed, 'gzip', 0)
		expect(bytes.byteLength).toBe(200_000)
	})
})

// ── Node-bound port helpers (real sockets, no mocks) ─────────────────────────

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
