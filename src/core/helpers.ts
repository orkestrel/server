import type {
	AcceptEntry,
	BodyOptions,
	CookieOptions,
	Encoding,
	MiddlewareContext,
	MiddlewareHandler,
	NextFunction,
	RangeSpec,
	SSEMessage,
	StreamInterface,
	StreamOptions,
	TokenOptions,
	TokenSecret,
} from './types.js'
import { isRecord, isString, parseJSON } from '@orkestrel/contract'
import {
	COMPRESSIBLE_TYPES,
	DEFAULT_BODY_LIMIT,
	DEFAULT_DECOMPRESSED_LIMIT,
	REQUEST_ID_PATTERN,
	SSE_HEADERS,
} from './constants.js'
import { ContentTooLargeError, HTTPError } from './errors.js'

// The middleware seam's composition engine (AGENTS §5 — a pure function, not a
// class: `compose` has no instance state, so it lives here rather than as an
// entity). The RETURNING onion (§5.1 of the proposal): each middleware may
// transform the request (`next(newRequest)`), transform the response (`await
// next()` then mutate the result), or short-circuit (return without calling
// `next`) — no mutable framework object anywhere. The double-`next` guard
// (calling `next` twice within one middleware invocation) rejects, preserving
// the old spine's crown-jewel invariant that each link runs the chain at most
// once.

/**
 * Compose an ordered chain of {@link MiddlewareHandler}s around a `terminal`
 * handler into one request handler — the frozen middleware seam (§5.1).
 *
 * @remarks
 * `middleware[0]` runs OUTERMOST: it is invoked first, and its call to `next`
 * runs `middleware[1]`, and so on until the LAST middleware's `next` invokes
 * `terminal`. Each middleware's `next` may be called with a substituted
 * `Request` (the downstream chain then sees that request instead of the
 * original), called with no argument (the original request continues
 * downstream), or NOT called at all (a short-circuit — the middleware's own
 * returned `Response` is sent, and everything downstream never runs). A
 * SECOND call to the same `next` within one middleware invocation REJECTS —
 * each link runs the chain at most once, so a middleware cannot fork the
 * request into two divergent downstream runs.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param middleware - The ordered chain, outermost first
 * @param terminal - The innermost handler the chain ultimately reaches
 * @returns A single `(request, context) => Promise<Response>` handler running the whole onion
 *
 * @example
 * ```ts
 * const withHeader: MiddlewareHandler<{}> = async (request, context, next) => {
 * 	const response = await next()
 * 	response.headers.set('X-Powered-By', 'orkestrel')
 * 	return response
 * }
 *
 * const handle = compose([withHeader], async () => new Response('ok'))
 * ```
 */
export function compose<TState>(
	middleware: readonly MiddlewareHandler<TState>[],
	terminal: (request: Request, context: MiddlewareContext<TState>) => Promise<Response>,
): (request: Request, context: MiddlewareContext<TState>) => Promise<Response> {
	return async (request: Request, context: MiddlewareContext<TState>): Promise<Response> => {
		const dispatch = (index: number, currentRequest: Request): Promise<Response> => {
			const layer = middleware[index]
			if (layer === undefined) return terminal(currentRequest, context)
			let called = false
			const next: NextFunction = (nextRequest?: Request): Promise<Response> => {
				if (called) return Promise.reject(new Error('next() was already called by this middleware'))
				called = true
				return dispatch(index + 1, nextRequest ?? currentRequest)
			}
			return Promise.resolve(layer(currentRequest, context, next))
		}
		return dispatch(0, request)
	}
}

// The cookie machinery (AGENTS §4.3 module-scope helpers) — `parseCookies`
// decodes a raw `Cookie:` header into a name→value lookup; `serializeCookie`
// builds a spec-shaped `Set-Cookie` value with its attributes. The SIGNED
// pair reuses the shipped HMAC token primitives rather than a second HMAC
// scheme: `writeSignedCookie` is `serializeCookie(name, await signToken(value,
// { secret }))` appended to a `Headers`, and `readSignedCookie` is `await
// verifyToken(parseCookies(...)[name], secret)` — so a cookie is just a
// `signToken` value in a `Set-Cookie`, with the SAME secret rotation + tamper
// rejection. Every reader narrows untrusted request input with `typeof`,
// never `as` (§14), and total on hostile input.

/**
 * Parse a raw `Cookie:` request header into a `name → value` lookup.
 *
 * @remarks
 * Splits on `;`; the FIRST segment keeps any leading whitespace (a genuine
 * cookie-pair separator never precedes it), while every later segment has its
 * inter-pair separator (ASCII space/tab) stripped before parsing — so a
 * whitespace-PADDED name (`'  __Host-x=evil'`) is rejected by
 * {@link isCookieName} rather than silently reconciling into a
 * prefix-protected `__Host-` name. A pair without `=`, or with an invalid
 * name, is skipped; a later duplicate name wins. TOTAL — an absent/empty/
 * malformed header yields an empty record, never throws (AGENTS §14).
 *
 * @param header - The raw `Cookie` header value (possibly `undefined`)
 * @returns A record of every parsed cookie, `name → decoded value`
 *
 * @example
 * ```ts
 * parseCookies('session=abc; theme=dark') // { session: 'abc', theme: 'dark' }
 * ```
 */
export function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {}
	if (header === undefined) return out
	const segments = header.split(';')
	for (let index = 0; index < segments.length; index += 1) {
		const raw = segments[index] ?? ''
		const segment = index === 0 ? raw : raw.replace(/^[ \t]+/, '')
		const eq = segment.indexOf('=')
		if (eq < 0) continue
		const name = segment.slice(0, eq)
		if (!isCookieName(name)) continue
		out[name] = decodeCookieValue(segment.slice(eq + 1).trim())
	}
	return out
}

/**
 * Whether a string is a valid RFC 6265 cookie NAME — a non-empty run of
 * cookie-token chars with NO surrounding (or interior) whitespace.
 *
 * @remarks
 * A cookie name is an RFC 7230 `token`: `^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$` —
 * which excludes every whitespace char (ASCII and Unicode) plus controls,
 * separators, and `=`. The {@link parseCookies} hardening that stops a
 * `'  __Host-x'` from reconciling into `__Host-x`. Total — never throws.
 *
 * @param value - The candidate cookie name
 * @returns `true` when `value` is a valid, whitespace-free cookie token
 *
 * @example
 * ```ts
 * isCookieName('__Host-session') // true
 * isCookieName(' __Host-session') // false — whitespace-padded
 * ```
 */
export function isCookieName(value: string): boolean {
	return /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/.test(value)
}

/**
 * Decode a cookie value with `decodeURIComponent`, falling back to the raw
 * text when the value is not valid percent-encoding.
 *
 * @param raw - The raw (trimmed) cookie value
 * @returns The URL-decoded value, or the raw value when decoding would throw
 *
 * @example
 * ```ts
 * decodeCookieValue('a%20b') // 'a b'
 * decodeCookieValue('%') // '%' — malformed escape stays literal
 * ```
 */
export function decodeCookieValue(raw: string): string {
	try {
		return decodeURIComponent(raw)
	} catch {
		return raw
	}
}

/**
 * Whether a string is safe to interpolate as a `Set-Cookie` attribute VALUE
 * (a `Domain` / `Path`) — the guard {@link serializeCookie} screens those two
 * attributes with before emitting them.
 *
 * @remarks
 * Rejects a value carrying a `;` (splits attributes), a `,` (can split a
 * folded header), ASCII/Unicode whitespace, or a C0/DEL control char
 * (`< 0x20` or `0x7f`) — the chars that could inject another `Set-Cookie`
 * directive. Total — never throws (a bad value returns `false`).
 *
 * @param value - The candidate attribute value (a `Domain` or `Path`)
 * @returns `true` when `value` carries no separator / whitespace / control char
 *
 * @example
 * ```ts
 * isCookieAttribute('/app') // true
 * isCookieAttribute('/a\r\nSet-Cookie: x=y') // false
 * ```
 */
export function isCookieAttribute(value: string): boolean {
	for (const char of value) {
		if (char === ';' || char === ',' || /\s/.test(char)) return false
		const code = char.codePointAt(0)
		if (code !== undefined && (code < 0x20 || code === 0x7f)) return false
	}
	return true
}

/**
 * Serialize a cookie into a `Set-Cookie` header value — `name=value` plus its attributes.
 *
 * @remarks
 * URL-encodes the value (the inverse of {@link parseCookies}'s decode) and
 * appends the present {@link CookieOptions} attributes in canonical order:
 * `Domain`, `Path` (default `/`), `Max-Age`, `HttpOnly` (default ON), `Secure`
 * (default OFF), `SameSite` (default `Lax`). `Domain` / `Path` are validated
 * with {@link isCookieAttribute} and THROW an {@link HTTPError} on an
 * injection attempt (a programmer misconfiguration, AGENTS §12 — never a
 * silent drop). A `sameSite: 'None'` cookie is ALWAYS `Secure` regardless of
 * the `secure` option (the spec requires it); an un-resolved `undefined`
 * `secure` here falls to OFF — request-aware callers resolve it first via
 * {@link resolveSecure}.
 *
 * @param name - The cookie name
 * @param value - The cookie value (URL-encoded into the output)
 * @param options - The {@link CookieOptions} attributes; see its fields for defaults
 * @returns The `Set-Cookie` header value
 * @throws {HTTPError} When `domain` or `path` carries an injection char
 *
 * @example
 * ```ts
 * serializeCookie('session', 'abc') // 'session=abc; Path=/; HttpOnly; SameSite=Lax'
 * ```
 */
export function serializeCookie(name: string, value: string, options?: CookieOptions): string {
	const sameSite = options?.sameSite ?? 'Lax'
	const domain = options?.domain
	if (domain !== undefined && !isCookieAttribute(domain))
		throw new HTTPError(500, `invalid cookie Domain: ${JSON.stringify(domain)}`)
	const path = options?.path ?? '/'
	if (!isCookieAttribute(path))
		throw new HTTPError(500, `invalid cookie Path: ${JSON.stringify(path)}`)
	const secure = sameSite === 'None' || options?.secure === true
	const parts = [`${name}=${encodeURIComponent(value)}`]
	if (domain !== undefined) parts.push(`Domain=${domain}`)
	parts.push(`Path=${path}`)
	if (options?.maxAge !== undefined) parts.push(`Max-Age=${Math.trunc(options.maxAge)}`)
	if (options?.httpOnly !== false) parts.push('HttpOnly')
	if (secure) parts.push('Secure')
	parts.push(`SameSite=${sameSite}`)
	return parts.join('; ')
}

/**
 * Resolve a cookie's effective `Secure` flag from its {@link CookieOptions}
 * `secure` setting and whether the request arrived over TLS.
 *
 * @remarks
 * `true` / `false` are explicit overrides. `undefined` (the secure default —
 * the option omitted) resolves to `encrypted` — `Secure` on a TLS
 * connection, off over plaintext HTTP — so a production HTTPS deployment
 * gets `Secure` automatically while local-dev HTTP still works.
 *
 * @param secure - The {@link CookieOptions} `secure` setting
 * @param encrypted - The connection's TLS flag ({@link import('./types.js').ConnectionInfo.encrypted})
 * @returns The concrete `Secure` flag to emit
 *
 * @example
 * ```ts
 * resolveSecure(undefined, true) // true
 * resolveSecure(undefined, false) // false
 * resolveSecure(false, true) // false — explicit override wins
 * ```
 */
export function resolveSecure(secure: boolean | undefined, encrypted: boolean): boolean {
	if (secure === true || secure === false) return secure
	return encrypted
}

/**
 * Append a `Set-Cookie` header onto a fetch-standard `Headers` WITHOUT
 * clobbering a prior one.
 *
 * @remarks
 * `Headers.append` already accumulates repeated headers (unlike node's
 * `setHeader`), so this is a thin, self-documenting wrapper naming the
 * cookie-append intent — the primitive {@link writeSignedCookie} /
 * {@link clearCookie} use.
 *
 * @param headers - The response `Headers` to write into
 * @param cookie - The fully-serialized `Set-Cookie` value (from {@link serializeCookie})
 *
 * @example
 * ```ts
 * const headers = new Headers()
 * appendCookie(headers, serializeCookie('a', '1'))
 * appendCookie(headers, serializeCookie('b', '2'))
 * headers.get('set-cookie') // 'a=1; Path=/; HttpOnly; SameSite=Lax, b=2; …'
 * ```
 */
export function appendCookie(headers: Headers, cookie: string): void {
	headers.append('set-cookie', cookie)
}

/**
 * Write a SIGNED cookie — HMAC-sign `value` with {@link signToken} and append
 * it as a `Set-Cookie` (the inverse of {@link readSignedCookie}).
 *
 * @remarks
 * The cookie value is `await signToken(value, { secret })`
 * (`<payload>.<signature>`), so a signed cookie is a stateless token in a
 * cookie — the same secret rotation and tamper rejection, no second HMAC
 * scheme. Appends (never clobbers) via {@link appendCookie}. Async — WebCrypto
 * signing is asynchronous (§3 of the proposal).
 *
 * @param headers - The response `Headers` to write into
 * @param name - The cookie name
 * @param value - The opaque value to sign into the cookie
 * @param secret - The {@link TokenSecret} to sign with (the first secret signs)
 * @param options - The {@link CookieOptions} attributes for the `Set-Cookie`
 *
 * @example
 * ```ts
 * const headers = new Headers()
 * await writeSignedCookie(headers, 'session', 'user-1', 'secret')
 * ```
 */
export async function writeSignedCookie(
	headers: Headers,
	name: string,
	value: string,
	secret: TokenSecret,
	options?: CookieOptions,
): Promise<void> {
	appendCookie(headers, serializeCookie(name, await signToken(value, { secret }), options))
}

/**
 * Read + verify a SIGNED cookie off a request — TOTAL, returning the
 * embedded value or `undefined` (the inverse of {@link writeSignedCookie}).
 *
 * @remarks
 * Parses the `Cookie` header ({@link parseCookies}), takes the named cookie,
 * and verifies it with {@link verifyToken} against `secret` (a rotation list
 * accepts a cookie signed by any of its secrets). ANY failure — an absent
 * cookie, a tampered value, a wrong secret — yields `undefined`, never throws.
 *
 * @param request - The `Request` to read the `Cookie` header from
 * @param name - The cookie name to read
 * @param secret - The {@link TokenSecret} (or rotation list) to verify against
 * @returns The embedded value when the cookie is present + valid, else `undefined`
 *
 * @example
 * ```ts
 * const value = await readSignedCookie(request, 'session', 'secret')
 * ```
 */
export async function readSignedCookie(
	request: Request,
	name: string,
	secret: TokenSecret,
): Promise<string | undefined> {
	const cookie = parseCookies(request.headers.get('cookie') ?? undefined)[name]
	return cookie === undefined ? undefined : verifyToken(cookie, secret)
}

/**
 * Clear a cookie — append a `Set-Cookie` that expires it immediately (`Max-Age=0`).
 *
 * @remarks
 * Writes an empty-valued cookie of the same `name` with `Max-Age=0` plus the
 * same `path`/`domain`/`sameSite`/`secure` attributes (the browser only drops
 * a cookie when those MATCH the one it set).
 *
 * @param headers - The response `Headers` to write into
 * @param name - The cookie name to clear
 * @param options - The {@link CookieOptions} that must match the original cookie
 *
 * @example
 * ```ts
 * const headers = new Headers()
 * clearCookie(headers, 'session')
 * ```
 */
export function clearCookie(headers: Headers, name: string, options?: CookieOptions): void {
	appendCookie(headers, serializeCookie(name, '', { ...options, maxAge: 0 }))
}

// The stateless signed-token primitives over WebCrypto (AGENTS §4.3 module-
// scope helpers, §3 of the proposal). A token is `<payload>.<signature>`: the
// payload a base64url JSON `{ value, exp? }`, the signature an HMAC-SHA256 of
// the payload under the secret. Signing always uses the FIRST secret (a
// rotation list's current head); verifying accepts ANY secret in the list,
// via `crypto.subtle.verify` — constant-time internally, so the old
// `safeCompare` is RETIRED, never ported. `verifyToken` is TOTAL (never
// throws — adversarial input returns `undefined`, AGENTS §14); only
// `signToken` throws, and only on a misconfigured (empty) secret.

/**
 * Base64url-encode a byte sequence — the payload encoding {@link signToken} /
 * {@link verifyToken} use, and the signature encoding for the HMAC.
 *
 * @param bytes - The bytes to encode
 * @returns The base64url string (no padding)
 *
 * @example
 * ```ts
 * encodeBase64Url(new TextEncoder().encode('hi')) // 'aGk'
 * ```
 */
export function encodeBase64Url(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Decode a base64url string back into its bytes — the inverse of
 * {@link encodeBase64Url}.
 *
 * @remarks
 * Restores the standard base64 alphabet + padding before decoding with
 * `atob`. THROWS `DOMException` on a malformed input — callers on the
 * untrusted-token path (`verifyToken`) catch it to stay total (AGENTS §14).
 *
 * @param value - The base64url string to decode
 * @returns The decoded bytes
 * @throws {DOMException} When `value` is not valid base64url
 *
 * @example
 * ```ts
 * new TextDecoder().decode(decodeBase64Url('aGk')) // 'hi'
 * ```
 */
export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
	const restored = value.replace(/-/g, '+').replace(/_/g, '/')
	const padding = restored.length % 4 === 0 ? '' : '='.repeat(4 - (restored.length % 4))
	const binary = atob(restored + padding)
	const bytes = new Uint8Array(binary.length)
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
	return bytes
}

/**
 * Sign a value into a stateless, HMAC-SHA256 token — `<payload>.<signature>`.
 *
 * @remarks
 * The payload is a base64url-encoded JSON `{ value, exp }` (`exp` is the
 * absolute expiry instant `Date.now() + ttl` when `options.ttl` is set, so
 * the expiry is HMAC-COVERED — a client cannot extend it without invalidating
 * the signature), signed via `crypto.subtle.sign('HMAC', …)` under the FIRST
 * {@link TokenSecret} (the current secret, or the head of a rotation list).
 * Blank/whitespace-only secrets are IGNORED ({@link normalizeSecret}); a
 * misconfigured secret with no usable entry THROWS an {@link HTTPError}
 * (`500`) — fail-closed, a programmer error (AGENTS §12). Verify with
 * {@link verifyToken}. Omitting `ttl` mints a token that never expires.
 *
 * @param value - The opaque value to embed (a session id, a deployment marker)
 * @param options - The signing `secret` and optional `ttl` (ms); see {@link TokenOptions}
 * @returns The signed `<payload>.<signature>` token string
 * @throws {HTTPError} When `options.secret` has no usable (non-blank) entry
 *
 * @example
 * ```ts
 * const token = await signToken('client', { secret: 'shh', ttl: 60_000 })
 * await verifyToken(token, 'shh') // 'client' (within 60s), else undefined
 * ```
 */
export async function signToken(value: string, options: TokenOptions): Promise<string> {
	const secrets = normalizeSecret(options.secret)
	const secret = secrets[0]
	if (secret === undefined) throw new HTTPError(500, 'signToken requires at least one secret')
	const exp = options.ttl !== undefined ? Date.now() + options.ttl : undefined
	const encoded = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ value, exp })))
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encoded))
	return `${encoded}.${encodeBase64Url(new Uint8Array(signature))}`
}

/**
 * Verify a stateless token and return its embedded value — TOTAL, never throws.
 *
 * @remarks
 * The inverse of {@link signToken}: splits the token on its LAST `.` (so a
 * value containing dots survives), and checks the payload's HMAC-SHA256
 * signature against EACH {@link TokenSecret} candidate via
 * `crypto.subtle.verify` (constant-time internally — the old `safeCompare` is
 * retired, §3 of the proposal), accepting the token on the first match (the
 * rotation path). It then decodes + narrows the payload (`isRecord` +
 * `typeof`, never `as` — AGENTS §14) and, when an expiry was bound in,
 * rejects an expired token. ANY failure — a malformed token, a bad signature,
 * a hostile/non-JSON payload, an empty secret list, or an elapsed expiry —
 * yields `undefined` rather than throwing.
 *
 * @param token - The candidate token string (from a request header/cookie)
 * @param secret - The {@link TokenSecret} (or rotation list) to verify against
 * @returns The embedded value when the token is valid + unexpired, else `undefined`
 *
 * @example
 * ```ts
 * await verifyToken('bad.token', 'shh') // undefined — never throws
 * ```
 */
export async function verifyToken(token: string, secret: TokenSecret): Promise<string | undefined> {
	const secrets = normalizeSecret(secret)
	if (secrets.length === 0) return undefined
	const dot = token.lastIndexOf('.')
	if (dot < 0) return undefined
	const encoded = token.slice(0, dot)
	const signatureText = token.slice(dot + 1)
	try {
		const signature = decodeBase64Url(signatureText)
		const data = new TextEncoder().encode(encoded)
		for (const candidate of secrets) {
			const key = await crypto.subtle.importKey(
				'raw',
				new TextEncoder().encode(candidate),
				{ name: 'HMAC', hash: 'SHA-256' },
				false,
				['verify'],
			)
			const matched = await crypto.subtle.verify('HMAC', key, signature, data)
			if (matched) return decodeTokenPayload(encoded)
		}
		return undefined
	} catch {
		// A malformed base64url signature/payload is just an invalid token — stay total.
		return undefined
	}
}

/**
 * Decode + narrow a signed token's base64url JSON payload, honoring its
 * expiry — the shared decode step {@link verifyToken} applies after a
 * signature match.
 *
 * @remarks
 * Decodes the base64url payload to UTF-8 JSON, narrows it to a record with a
 * string `value` (AGENTS §14 — never `as`), and rejects an expired `exp`.
 * TOTAL — any decode/shape/expiry failure yields `undefined`.
 *
 * @param encoded - The base64url-encoded payload segment (before the last `.`)
 * @returns The embedded value when the payload is well-shaped + unexpired, else `undefined`
 */
export function decodeTokenPayload(encoded: string): string | undefined {
	try {
		const text = new TextDecoder().decode(decodeBase64Url(encoded))
		const payload: unknown = JSON.parse(text)
		if (!isRecord(payload)) return undefined
		if (typeof payload.value !== 'string') return undefined
		if (payload.exp !== undefined && typeof payload.exp !== 'number') return undefined
		if (payload.exp !== undefined && Date.now() >= payload.exp) return undefined
		return payload.value
	} catch {
		return undefined
	}
}

/**
 * Normalize a {@link TokenSecret} to a concrete list of USABLE secrets —
 * backs both {@link signToken} and {@link verifyToken}.
 *
 * @remarks
 * A single string becomes a one-element list; a rotation list is copied. Any
 * blank/whitespace-only entry is DROPPED (`.trim()` is used only for that
 * emptiness test; each kept secret is stored VERBATIM). The first kept
 * element is the signing secret; all kept are accepted on verify.
 *
 * @param secret - The {@link TokenSecret} (a single string, or a rotation list)
 * @returns The kept (non-blank) secrets, in order — empty when none is usable
 *
 * @example
 * ```ts
 * normalizeSecret(['new', '', '  ', 'old']) // ['new', 'old']
 * ```
 */
export function normalizeSecret(secret: TokenSecret): readonly string[] {
	const list = typeof secret === 'string' ? [secret] : [...secret]
	return list.filter((entry) => entry.trim().length > 0)
}

// The content-negotiation helpers (AGENTS §4.3 module-scope, §5) — the ONE
// shared q-value parser behind the `Negotiator` (U3) and any future
// compression middleware's `Accept-Encoding` pick.

/**
 * Parse a weighted `Accept` / `Accept-Encoding` / `Accept-Language` header
 * into its q-sorted entries.
 *
 * @remarks
 * Splits on `,`; for each part takes the token before the first `;`
 * (lower-cased + trimmed) as `value`, and reads a `;q=<n>` parameter as the
 * quality (default `1`, clamped to `[0, 1]`; a non-finite/malformed `q` falls
 * back to `1`). A `;q=0` entry is KEPT (an explicit rejection a caller must
 * honor). The result is sorted by `q` DESCENDING, a STABLE sort preserving
 * the header's own order within a tie — a single pass with no backtracking,
 * so parsing stays linear in the header length (ReDoS-safe). TOTAL — an
 * empty/malformed header yields `[]`/best-effort entries, never throws.
 *
 * @param header - The raw weighted header value
 * @returns The parsed {@link AcceptEntry} list, sorted by `q` descending
 *
 * @example
 * ```ts
 * parseAcceptHeader('br;q=1.0, gzip;q=0.8, identity;q=0')
 * // [{ value: 'br', q: 1 }, { value: 'gzip', q: 0.8 }, { value: 'identity', q: 0 }]
 * ```
 */
export function parseAcceptHeader(header: string): readonly AcceptEntry[] {
	const entries: AcceptEntry[] = []
	for (const part of header.split(',')) {
		const trimmed = part.trim()
		if (trimmed.length === 0) continue
		const semicolon = trimmed.indexOf(';')
		const value = (semicolon === -1 ? trimmed : trimmed.slice(0, semicolon)).trim().toLowerCase()
		if (value.length === 0) continue
		let q = 1
		if (semicolon !== -1) {
			const match = /;\s*q=(-?[0-9.]+)/i.exec(trimmed.slice(semicolon))
			if (match !== null) {
				const parsed = Number(match[1])
				if (Number.isFinite(parsed)) q = Math.min(1, Math.max(0, parsed))
			}
		}
		entries.push({ value, q })
	}
	return entries
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) => b.entry.q - a.entry.q || a.index - b.index)
		.map((ranked) => ranked.entry)
}

/**
 * The client's quality (q) for one content-coding from the parsed
 * `Accept-Encoding` entries — backs {@link negotiateEncoding}'s
 * server-preference selection.
 *
 * @remarks
 * Prefers an EXACT named match (including an explicit `;q=0` rejection);
 * failing that, a bare `*` wildcard's q applies. A coding that is neither
 * named nor covered by `*` scores `0` (not acceptable). A named `;q=0` wins
 * over a `*` (a specific rejection beats the wildcard), so it scores `0`.
 *
 * @param entries - The parsed {@link AcceptEntry} list
 * @param coding - The candidate coding to score
 * @returns The client's quality for `coding` in `[0, 1]` (`0` ⇒ not acceptable)
 *
 * @example
 * ```ts
 * codingQuality(parseAcceptHeader('gzip;q=0.5, *;q=0.1'), 'gzip') // 0.5
 * codingQuality(parseAcceptHeader('gzip;q=0.5, *;q=0.1'), 'br') // 0.1
 * ```
 */
export function codingQuality(entries: readonly AcceptEntry[], coding: string): number {
	const named = entries.find((entry) => entry.value === coding)
	if (named !== undefined) return named.q
	const wildcard = entries.find((entry) => entry.value === '*')
	return wildcard?.q ?? 0
}

/**
 * Select the best content-coding for an `Accept-Encoding` header from the
 * codings the server offers.
 *
 * @remarks
 * Parses the header ({@link parseAcceptHeader}) and scores each `available`
 * coding in the SERVER's preference order ({@link codingQuality}), keeping
 * the highest-scoring one (a strict `>` keeps the earlier-offered coding on a
 * client-side tie). Returns `undefined` when the client accepts none of
 * `available` (identity — no compression). TOTAL on hostile input.
 *
 * @typeParam T - The coding string type (so a `readonly Encoding[]` returns an `Encoding`)
 * @param header - The raw `Accept-Encoding` header value
 * @param available - The codings the server offers, in preference (tie-break) order
 * @returns The negotiated coding, or `undefined` when none of `available` is acceptable
 *
 * @example
 * ```ts
 * negotiateEncoding('gzip;q=1.0, deflate;q=0.8', ['gzip', 'deflate']) // 'gzip'
 * ```
 */
export function negotiateEncoding<T extends string>(
	header: string,
	available: readonly T[],
): T | undefined {
	if (available.length === 0) return undefined
	const entries = parseAcceptHeader(header)
	let best: T | undefined
	let bestQuality = 0
	for (const coding of available) {
		const quality = codingQuality(entries, coding)
		if (quality > bestQuality) {
			best = coding
			bestQuality = quality
		}
	}
	return best
}

/**
 * Rank + quality of one `candidate` media type against the parsed `Accept`
 * entries — the generic media-type primitive the `Negotiator`'s `negotiate`
 * uses to score each `available` candidate.
 *
 * @remarks
 * An exact match ranks `0`, a subtype wildcard (`type/*`) ranks `1`, the
 * any-range (`* / *`) ranks `2`; `undefined` when nothing matches. An exact
 * `;q=0` entry explicitly rejects the candidate outright (returns
 * `undefined` immediately); a wildcard `;q=0` only rejects the wildcard's own
 * (less specific) coverage, so a later more-specific match can still allow
 * it. Among multiple matching entries, the lowest `rank` wins, and among a
 * rank tie the highest `q` wins.
 *
 * @param entries - The parsed {@link AcceptEntry} list
 * @param candidate - The candidate media type to score (e.g. `'text/html'`)
 * @returns The `{ q, rank }` of the best matching entry, or `undefined` when nothing matches
 *
 * @example
 * ```ts
 * matchMediaType(parseAcceptHeader('text/html, application/json;q=0.9'), 'text/html')
 * // { q: 1, rank: 0 }
 * matchMediaType(parseAcceptHeader('text/*;q=0.8'), 'text/plain') // { q: 0.8, rank: 1 }
 * matchMediaType(parseAcceptHeader('text/html;q=0'), 'text/html') // undefined
 * ```
 */
export function matchMediaType(
	entries: readonly AcceptEntry[],
	candidate: string,
): { readonly q: number; readonly rank: number } | undefined {
	const slash = candidate.indexOf('/')
	const type = slash === -1 ? candidate : candidate.slice(0, slash)
	let best: { readonly q: number; readonly rank: number } | undefined
	for (const entry of entries) {
		let rank: number | undefined
		if (entry.value === candidate) rank = 0
		else if (entry.value === `${type}/*`) rank = 1
		else if (entry.value === '*/*') rank = 2
		if (rank === undefined) continue
		if (entry.q === 0) {
			// An exact `;q=0` explicitly rejects this candidate outright; a
			// wildcard `;q=0` only rejects the wildcard's own (less specific)
			// coverage, so a later more-specific match can still allow it.
			if (rank === 0) return undefined
			continue
		}
		if (best === undefined || rank < best.rank || (rank === best.rank && entry.q > best.q)) {
			best = { q: entry.q, rank }
		}
	}
	return best
}

/**
 * The client's quality for one `candidate` language from the parsed
 * `Accept-Language` entries — backs the `Negotiator`'s `language` axis.
 *
 * @remarks
 * Prefers an exact match, then a primary-tag prefix match (`en` accepts
 * `en-US`), then the `*` wildcard; `0` when nothing matches (a `;q=0` entry
 * is an explicit rejection).
 *
 * @param entries - The parsed {@link AcceptEntry} list
 * @param candidate - The candidate language tag to score (e.g. `'en-US'`)
 * @returns The client's quality for `candidate` in `[0, 1]` (`0` ⇒ not acceptable)
 *
 * @example
 * ```ts
 * languageQuality(parseAcceptHeader('en-US, en;q=0.8'), 'en-US') // 1
 * languageQuality(parseAcceptHeader('en;q=0.8'), 'en-US') // 0.8 — primary-tag prefix
 * languageQuality(parseAcceptHeader('*;q=0.5'), 'fr') // 0.5 — wildcard
 * ```
 */
export function languageQuality(entries: readonly AcceptEntry[], candidate: string): number {
	const lower = candidate.toLowerCase()
	const primary = lower.split('-')[0]
	let named: number | undefined
	let prefixed: number | undefined
	let wildcard: number | undefined
	for (const entry of entries) {
		const entryPrimary = entry.value.split('-')[0]
		if (entry.value === lower) named = entry.q
		else if (entryPrimary === primary) {
			if (prefixed === undefined) prefixed = entry.q
		} else if (entry.value === '*') wildcard = entry.q
	}
	if (named !== undefined) return named
	if (prefixed !== undefined) return prefixed
	return wildcard ?? 0
}

/**
 * Whether a `Content-Type` is worth compressing.
 *
 * @remarks
 * Strips any `; charset=…` parameter (lower-cased), then accepts a `text/*`
 * type, a `+json`/`+xml` structured suffix, or one of the explicit
 * {@link import('./constants.js').COMPRESSIBLE_TYPES}. An already-compressed
 * binary (`image/png`, `application/zip`) is NOT compressible. An
 * absent/empty type is not compressible. TOTAL.
 *
 * @param type - The response `Content-Type` header value (with or without parameters)
 * @returns `true` when the type is text-shaped and worth compressing
 *
 * @example
 * ```ts
 * isCompressibleType('application/json; charset=utf-8') // true
 * isCompressibleType('image/png') // false
 * ```
 */
export function isCompressibleType(type: string): boolean {
	const semicolon = type.indexOf(';')
	const bare = (semicolon === -1 ? type : type.slice(0, semicolon)).trim().toLowerCase()
	if (bare.length === 0) return false
	if (bare.startsWith('text/')) return true
	if (bare.endsWith('+json') || bare.endsWith('+xml')) return true
	return COMPRESSIBLE_TYPES.has(bare)
}

// The conditional-request helpers (AGENTS §4.3 module-scope, §5) — ETag
// compute/compare (RFC 7232 §2.3.2 WEAK comparison) and the TOTAL `Range`
// parser.

/**
 * Compute a CONTENT `ETag` over a fully-buffered response body via WebCrypto.
 *
 * @remarks
 * Hashes `body` with SHA-256 (`crypto.subtle.digest`) and wraps the hex
 * digest as a WEAK validator (`W/"<hash>"`) when `weak` is `true` — the
 * default, encoding-AGNOSTIC, so the tag survives a downstream content
 * re-encoding (gzip) and still matches on revalidation — or a STRONG one
 * (`"<hash>"`, byte-identity) when `weak` is `false`.
 *
 * @param body - The full (uncompressed) response body to hash
 * @param weak - `true` for a weak `W/"…"` validator (the default), `false` for a strong `"…"` one
 * @returns The `ETag` header value
 *
 * @example
 * ```ts
 * await computeBodyETag(new TextEncoder().encode('hello')) // 'W/"…sha256-hex…"'
 * ```
 */
export async function computeBodyETag(body: Uint8Array<ArrayBuffer>, weak = true): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', body)
	const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
		'',
	)
	return weak ? `W/"${hex}"` : `"${hex}"`
}

/**
 * Strip the WEAK indicator (`W/`) from an entity-tag, returning its opaque
 * comparison body — the reduction {@link matchesETag} applies to both sides
 * before the RFC 7232 §2.3.2 weak comparison.
 *
 * @param tag - One entity-tag (`W/"<body>"` or `"<body>"`)
 * @returns The tag with any leading `W/` removed (the quotes preserved)
 *
 * @example
 * ```ts
 * unwrapETag('W/"abc"') // '"abc"'
 * ```
 */
export function unwrapETag(tag: string): string {
	const trimmed = tag.trim()
	return trimmed.startsWith('W/') ? trimmed.slice(2) : trimmed
}

/**
 * Whether a request's `If-None-Match` header matches a resource's current
 * `ETag` — the RFC 7232 §2.3.2 WEAK comparison.
 *
 * @remarks
 * `If-None-Match` is a COMMA-separated LIST of entity-tags (matches if ANY
 * listed tag matches), or the `*` wildcard (matches ANY current
 * representation — only a list of exactly `*` is the wildcard). Comparison is
 * WEAK: `W/"abc"` and `"abc"` are equal (both sides' weak prefix is stripped
 * via {@link unwrapETag} before comparing the opaque body). TOTAL — a
 * malformed/empty header matches nothing, never throws.
 *
 * @param header - The raw `If-None-Match` header value
 * @param etag - The resource's current `ETag`
 * @returns `true` when the conditional matches (the caller answers `304`)
 *
 * @example
 * ```ts
 * matchesETag('"abc", W/"def"', 'W/"abc"') // true — weak comparison
 * matchesETag('*', 'W/"anything"') // true — wildcard
 * ```
 */
export function matchesETag(header: string, etag: string): boolean {
	const trimmed = header.trim()
	if (trimmed === '*') return true
	const target = unwrapETag(etag)
	for (const member of trimmed.split(',')) {
		const candidate = member.trim()
		if (candidate.length === 0) continue
		if (unwrapETag(candidate) === target) return true
	}
	return false
}

/**
 * Parse an HTTP `Range` request header against a known resource `size` —
 * TOTAL, returning a {@link RangeSpec} or `undefined`.
 *
 * @remarks
 * Handles the three single-range `bytes=` forms — closed (`start-end`), open
 * (`start-`), and suffix (`-suffixLength`) — clamping the window to
 * `[0, size - 1]` (the HTTP INCLUSIVE-end convention). Returns
 * `{ satisfiable: true, start, end }` for an overlapping range,
 * `{ satisfiable: false }` for a range wholly past the resource, and
 * `undefined` for the "serve the whole resource" case: an ABSENT header, a
 * non-`bytes` unit, a MULTI-range header (`a-b, c-d` — refused outright, not
 * supported), or any malformed/non-finite bound. NEVER throws on a hostile
 * header.
 *
 * @param header - The raw `Range` header value
 * @param size - The resource's total byte length
 * @returns The {@link RangeSpec}, or `undefined` to serve the whole resource
 *
 * @example
 * ```ts
 * parseRange('bytes=0-99', 1000) // { satisfiable: true, start: 0, end: 99 }
 * parseRange('bytes=0-1, 2-3', 1000) // undefined — multi-range refused
 * ```
 */
export function parseRange(header: string | undefined, size: number): RangeSpec | undefined {
	if (header === undefined) return undefined
	const match = /^bytes=(.*)$/.exec(header.trim())
	if (match === null) return undefined
	const spec = match[1].trim()
	if (spec.includes(',')) return undefined
	const dash = spec.indexOf('-')
	if (dash < 0) return undefined
	const startText = spec.slice(0, dash).trim()
	const endText = spec.slice(dash + 1).trim()
	if (startText === '') {
		const suffix = Number(endText)
		if (endText === '' || !Number.isInteger(suffix) || suffix <= 0) return undefined
		if (size === 0) return { satisfiable: false }
		const start = Math.max(0, size - suffix)
		return { satisfiable: true, start, end: size - 1 }
	}
	const start = Number(startText)
	if (!Number.isInteger(start) || start < 0) return undefined
	if (start >= size) return { satisfiable: false }
	if (endText === '') return { satisfiable: true, start, end: size - 1 }
	const end = Number(endText)
	if (!Number.isInteger(end) || end < start) return undefined
	return { satisfiable: true, start, end: Math.min(end, size - 1) }
}

// The security primitives (AGENTS §4.3 module-scope, §5) — CORS origin
// resolution, `Vary` merging, security-header resolution, request-id
// validation, and the IPv6 `/64` rate-key collapse.

/**
 * Resolve the `Access-Control-Allow-Origin` value for a request.
 *
 * @remarks
 * `'*'` and a single origin string pass straight through. An allow-list
 * echoes the request's `Origin` only when it is present in the list, else
 * `undefined` (no header set). SECURITY: the literal `'null'` origin — sent
 * by a sandboxed iframe, a `file://` document, an opaque-origin redirect — is
 * NEVER reflected even if `'null'` were listed, closing the hostile-context
 * cross-origin-access hole.
 *
 * @param origin - The configured origin policy — `'*'`, a single origin, or an allow-list
 * @param requestOrigin - The request's `Origin` header value, if present
 * @returns The allow-origin value to send, or `undefined` to set no header
 *
 * @example
 * ```ts
 * resolveOrigin(['https://app.example'], 'https://app.example') // 'https://app.example'
 * resolveOrigin(['https://app.example'], 'null') // undefined — never reflected
 * ```
 */
export function resolveOrigin(
	origin: string | readonly string[],
	requestOrigin: string | undefined,
): string | undefined {
	if (isString(origin)) return origin
	if (!isString(requestOrigin)) return undefined
	if (requestOrigin === 'null') return undefined
	return origin.includes(requestOrigin) ? requestOrigin : undefined
}

/**
 * Merge a `Vary` value into an existing `Vary` header without duplication.
 *
 * @remarks
 * Splits `existing` on `,`, trims each member, and appends `value` only when
 * no existing member already matches it case-insensitively (`Vary` header
 * names are case-insensitive). Preserves the existing members' order and
 * appends the new one last.
 *
 * @param existing - The current `Vary` header value, if any
 * @param value - The header name to ensure is listed
 * @returns The merged `Vary` value
 *
 * @example
 * ```ts
 * mergeVary(undefined, 'Origin') // 'Origin'
 * mergeVary('Origin', 'origin') // 'Origin' — no duplicate (case-insensitive)
 * mergeVary('Accept-Encoding', 'Origin') // 'Accept-Encoding, Origin'
 * ```
 */
export function mergeVary(existing: string | undefined, value: string): string {
	const members =
		existing === undefined
			? []
			: existing
					.split(',')
					.map((member) => member.trim())
					.filter((member) => member.length > 0)
	const present = members.some((member) => member.toLowerCase() === value.toLowerCase())
	return present ? members.join(', ') : [...members, value].join(', ')
}

/**
 * Resolve one opt-out, value-bearing security header.
 *
 * @remarks
 * The shared "a `string` value, or `false` to omit, or a default when unset"
 * resolution (AGENTS §4.4 — a value-or-off union, not a behavioral toggle):
 * `false` ⇒ `undefined` (omit the header), an explicit `string` ⇒ that
 * override, `undefined` (unset) ⇒ `fallback` (the secure default).
 *
 * @param value - The option value — a `string` override, `false` to omit, or `undefined` for the default
 * @param fallback - The secure-default value used when `value` is unset
 * @returns The header value to set, or `undefined` to omit the header
 *
 * @example
 * ```ts
 * resolveSecurityHeader(undefined, 'DENY') // 'DENY'
 * resolveSecurityHeader(false, 'DENY') // undefined — omitted
 * resolveSecurityHeader('SAMEORIGIN', 'DENY') // 'SAMEORIGIN' — override
 * ```
 */
export function resolveSecurityHeader(
	value: string | false | undefined,
	fallback: string,
): string | undefined {
	if (value === false) return undefined
	return value ?? fallback
}

/**
 * Whether a client-supplied `X-Request-ID` is SAFE to echo into a response
 * header + `context.state`.
 *
 * @remarks
 * A request id is echoed RAW into a response header and log lines, so an
 * untrusted one is a header-injection + log-injection + DoS vector. This
 * refuses anything off {@link import('./constants.js').REQUEST_ID_PATTERN}
 * (`^[A-Za-z0-9_-]{1,200}$` — no whitespace, no control chars, no CR/LF).
 * TOTAL — never throws.
 *
 * @param value - The candidate incoming request id
 * @returns `true` when `value` is a safe, bounded, charset-clean correlation id
 *
 * @example
 * ```ts
 * isValidRequestId('req_abc-123') // true
 * isValidRequestId('bad\r\nheader') // false
 * ```
 */
export function isValidRequestId(value: string): boolean {
	return REQUEST_ID_PATTERN.test(value)
}

/**
 * Compute the `/64` network of a full IPv6 address, or `undefined` when the
 * input is not a plain IPv6 address to collapse.
 *
 * @remarks
 * Returns `undefined` for an IPv4-mapped `::ffff:a.b.c.d` (the embedded IPv4
 * is the identity) or any string that does not expand to exactly eight
 * hextets. Expands a single `::` into the missing zero hextets, takes the
 * first FOUR (the `/64` prefix), normalizes each (lower-case, no leading
 * zeros), and joins with a trailing `::/64`. A zone id (`%eth0`) is stripped
 * first. Total — a malformed address returns `undefined`.
 *
 * @param address - The candidate IPv6 address
 * @returns The `/64` network string, or `undefined` when not a plain IPv6 address
 *
 * @example
 * ```ts
 * ipv6Network('2001:db8:1:2::1') // '2001:db8:1:2::/64'
 * ipv6Network('192.0.2.1') // undefined — IPv4, not collapsed
 * ```
 */
export function ipv6Network(address: string): string | undefined {
	if (/^::ffff:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(address)) return undefined
	const percent = address.indexOf('%')
	const bare = percent === -1 ? address : address.slice(0, percent)
	const halves = bare.split('::')
	if (halves.length > 2) return undefined
	const head = halves[0] === '' ? [] : halves[0].split(':')
	const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : []
	let groups: string[]
	if (halves.length === 2) {
		const missing = 8 - head.length - tail.length
		if (missing < 0) return undefined
		groups = [...head, ...Array.from({ length: missing }, () => '0'), ...tail]
	} else {
		groups = head
	}
	if (groups.length !== 8) return undefined
	const prefix: string[] = []
	for (const group of groups.slice(0, 4)) {
		if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined
		prefix.push(Number.parseInt(group, 16).toString(16))
	}
	return `${prefix.join(':')}::/64`
}

/**
 * Collapse a client IP into its rate-limit BUCKET key — an IPv6 address to
 * its `/64` network, an IPv4 (or IPv4-mapped) address unchanged.
 *
 * @remarks
 * A residential/mobile IPv6 user is routinely handed a WHOLE `/64`, so a
 * per-`/128` rate limit is trivially bypassed by rotating host bits — the
 * real identity is the `/64` network. Delegates the IPv6 collapse to
 * {@link ipv6Network}; anything it returns `undefined` for (an IPv4 address,
 * a malformed string) is kept unchanged.
 *
 * @param address - The raw connection peer address ({@link import('./types.js').ConnectionInfo.ip})
 * @returns The bucket key — the `/64` network for an IPv6 address, else the address unchanged
 *
 * @example
 * ```ts
 * clientRateKey('2001:db8:1:2:dead:beef:0:9') // '2001:db8:1:2::/64'
 * clientRateKey('192.0.2.1') // '192.0.2.1'
 * ```
 */
export function clientRateKey(address: string): string {
	return ipv6Network(address) ?? address
}

// The Server-Sent-Events seam (AGENTS §4.3 module-scope, §5.4 of the
// proposal) — `serializeEvent` is the wire encoder (the exact inverse of a
// consuming SSE parser); `openStream` is the generic `Response`-returning
// stream handle any streaming route (SSE today, a future producer tomorrow)
// opens over a `ReadableStream`.

/**
 * Serialize one {@link SSEMessage} to the SSE wire.
 *
 * @remarks
 * Emits an `event:`/`id:`/`retry:` line for each present field, then ONE
 * `data:` line per CRLF-aware-split (`\r\n` / `\r` / `\n`) segment of `data`
 * (so a consuming parser's multi-`data` concat reproduces the original
 * `data` exactly, and no raw `\r` or `\n` can ever ride onto the wire inside
 * a `data:` line), then the terminating blank line.
 *
 * @param message - The event to serialize
 * @returns The SSE wire text for the event (terminated by a blank line)
 *
 * @example
 * ```ts
 * serializeEvent({ event: 'token', data: 'hello' }) // 'event: token\ndata: hello\n\n'
 * serializeEvent({ data: 'multi\nline' }) // 'data: multi\ndata: line\n\n'
 * ```
 */
export function serializeEvent(message: SSEMessage): string {
	const lines: string[] = []
	if (message.event !== undefined) lines.push(`event: ${message.event}`)
	if (message.id !== undefined) lines.push(`id: ${message.id}`)
	if (message.retry !== undefined) lines.push(`retry: ${message.retry}`)
	for (const segment of message.data.split(/\r\n|\r|\n/)) lines.push(`data: ${segment}`)
	return `${lines.join('\n')}\n\n`
}

/**
 * Open a generic Server-Sent-Events stream — a fetch-standard `Response`
 * whose body is a `ReadableStream` a caller writes {@link SSEMessage}s into.
 *
 * @remarks
 * Builds the `Response` immediately with {@link import('./constants.js').SSE_HEADERS}
 * merged under any `options.headers` (a seam-owned key is never overridden),
 * at `options.status` (default `200`). The returned {@link StreamInterface}'s
 * `write` serializes one message ({@link serializeEvent}) and enqueues it;
 * `comment` writes a `: text` keep-alive line a conforming parser ignores;
 * `end` closes the stream. Every method is a SAFE NO-OP once `closed` (ended
 * by `end()`, or the consumer cancelled the stream), so a late write never
 * throws.
 *
 * @param options - Optional `status` + extra `headers`; see {@link StreamOptions}
 * @returns The {@link StreamInterface} handle
 *
 * @example
 * ```ts
 * const stream = openStream()
 * stream.write({ event: 'token', data: 'hello' })
 * stream.end()
 * // return stream.response from the route handler
 * ```
 */
export function openStream(options?: StreamOptions): StreamInterface {
	const encoder = new TextEncoder()
	let closed = false
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined
	const body = new ReadableStream<Uint8Array>({
		start(streamController) {
			controller = streamController
		},
		cancel() {
			closed = true
		},
	})
	const headers = new Headers({ ...SSE_HEADERS, ...options?.headers })
	const response = new Response(body, { status: options?.status ?? 200, headers })
	const enqueue = (text: string): void => {
		if (closed || controller === undefined) return
		controller.enqueue(encoder.encode(text))
	}
	return {
		response,
		get closed(): boolean {
			return closed
		},
		write(message: SSEMessage): void {
			enqueue(serializeEvent(message))
		},
		comment(text: string): void {
			enqueue(`: ${text}\n\n`)
		},
		end(): void {
			if (closed) return
			closed = true
			controller?.close()
		},
	}
}

// The body pipeline (AGENTS §4.3 module-scope, §5.4 of the proposal) —
// `readBody` collects a request body capped at `limit` bytes (413 over),
// transparently decompresses a `gzip`/`deflate` `Content-Encoding` body
// through a byte-counting `TransformStream` that ABORTS the instant
// decompressed output exceeds `decompression` (the zip-bomb defense — fail
// BEFORE materializing the bomb, since `DecompressionStream` has no
// `maxOutputLength` knob), then decodes by content type. `scrubPrototype` /
// `isDangerousKey` are the prototype-pollution scrub `readBody` applies to a
// parsed JSON body, ported verbatim (pure value-walking logic, unaffected by
// the fetch-vocabulary migration).

/**
 * Whether a key is a PROTOTYPE-POLLUTION vector — `__proto__`, `constructor`,
 * or `prototype` — the three keys that, assigned onto a normal object, can
 * reach and mutate `Object.prototype`.
 *
 * @param key - The candidate object key
 * @returns `true` when `key` is one of the three prototype-pollution keys
 *
 * @example
 * ```ts
 * isDangerousKey('__proto__') // true
 * isDangerousKey('name') // false
 * ```
 */
export function isDangerousKey(key: string): boolean {
	return key === '__proto__' || key === 'constructor' || key === 'prototype'
}

/**
 * Recursively STRIP the prototype-pollution keys from a parsed value IN
 * PLACE.
 *
 * @remarks
 * `JSON.parse('{"__proto__":{…}}')` is benign on its own — it produces an OWN,
 * enumerable `__proto__` DATA property — but that own key becomes a
 * pollution gadget the moment a downstream deep-merge copies it onto a live
 * object. This walks the value and `delete`s any own {@link isDangerousKey}
 * key at every depth, recursing into nested objects + array elements.
 * Primitives/`null` pass through untouched. Total — never throws. Mutates the
 * freshly-parsed value (which nothing else holds yet).
 *
 * @param value - The freshly `JSON.parse`d value to scrub (mutated in place)
 * @returns The same `value`, with every dangerous key removed at every depth
 *
 * @example
 * ```ts
 * scrubPrototype(JSON.parse('{"__proto__":{"polluted":true},"name":"ok"}'))
 * // { name: 'ok' } — the __proto__ key is gone
 * ```
 */
export function scrubPrototype(value: unknown): unknown {
	if (Array.isArray(value)) {
		for (const item of value) scrubPrototype(item)
		return value
	}
	if (isRecord(value)) {
		for (const key of Object.keys(value)) {
			if (isDangerousKey(key)) {
				Reflect.deleteProperty(value, key)
				continue
			}
			scrubPrototype(value[key])
		}
		return value
	}
	return value
}

/**
 * Collect a `Request` body into a single `Uint8Array`, enforcing a size limit.
 *
 * @remarks
 * Reads `request.body` (a `ReadableStream<Uint8Array>`) chunk by chunk,
 * throwing a {@link ContentTooLargeError} (413) the instant the running total
 * exceeds `limit` — BEFORE the rest of the stream is buffered — rather than
 * collecting an unbounded body. A bodyless request (`request.body === null`)
 * resolves an empty array. A non-positive `limit` means unbounded.
 *
 * @param request - The `Request` to drain
 * @param limit - The maximum total bytes before a 413; a non-positive value means unbounded
 * @returns The full request body as one `Uint8Array`
 * @throws {ContentTooLargeError} When the body exceeds `limit`
 *
 * @example
 * ```ts
 * const bytes = await collectRequestBody(request, 1_048_576)
 * ```
 */
export async function collectRequestBody(
	request: Request,
	limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
	if (request.body === null) return new Uint8Array(0)
	const reader = request.body.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		total += value.byteLength
		if (limit > 0 && total > limit) {
			await reader.cancel()
			throw new ContentTooLargeError(limit)
		}
		chunks.push(value)
	}
	const merged = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		merged.set(chunk, offset)
		offset += chunk.byteLength
	}
	return merged
}

/**
 * Narrow a raw `Content-Encoding` header value to a decompressible
 * {@link Encoding} — the boundary guard {@link readBody} uses to decide
 * whether a request body needs transparent decompression.
 *
 * @remarks
 * Lower-cases + trims and returns the matching {@link Encoding} ONLY for
 * `gzip` / `deflate` (the two `DecompressionStream`-supported codings, §3 of
 * the proposal). An absent header, `identity`, an unknown value, or a
 * comma-joined multi-coding all yield `undefined` (the body is read as-is).
 * TOTAL — never asserts the loose `string | null` header.
 *
 * @param header - The raw `Content-Encoding` header value
 * @returns The single decompressible {@link Encoding}, or `undefined` when none applies
 *
 * @example
 * ```ts
 * requestEncoding('gzip') // 'gzip'
 * requestEncoding('br') // undefined — unsupported by DecompressionStream
 * ```
 */
export function requestEncoding(header: string | null): Exclude<Encoding, 'identity'> | undefined {
	if (!isString(header)) return undefined
	const value = header.trim().toLowerCase()
	return value === 'gzip' || value === 'deflate' ? value : undefined
}

/**
 * Transparently decompress an already-collected, `gzip`/`deflate`-encoded
 * byte sequence via `DecompressionStream`, capping the DECOMPRESSED output —
 * the zip-bomb defense.
 *
 * @remarks
 * Pipes `bytes` through `DecompressionStream(encoding)` and a byte-counting
 * `TransformStream` that ABORTS the pipe the INSTANT the running decompressed
 * total exceeds `cap` — fail-before-materialize, since `DecompressionStream`
 * has no `maxOutputLength` knob (§3 of the proposal). A cap breach surfaces
 * as a {@link ContentTooLargeError} (413); a genuinely corrupt/truncated
 * compressed stream surfaces as a distinct `400`-mappable {@link HTTPError}
 * (never conflated with the cap). A non-positive `cap` means uncapped.
 *
 * @param bytes - The compressed bytes to decompress
 * @param encoding - The {@link Encoding} the bytes are compressed with
 * @param cap - The maximum decompressed byte count; a non-positive value means uncapped
 * @returns The decompressed bytes
 * @throws {ContentTooLargeError} When decompressed output would exceed `cap`
 * @throws {HTTPError} When the compressed stream is corrupt/truncated (400)
 */
export async function decompressRequestBody(
	bytes: Uint8Array<ArrayBuffer>,
	encoding: Exclude<Encoding, 'identity'>,
	cap: number,
): Promise<Uint8Array<ArrayBuffer>> {
	let total = 0
	const capStream = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			total += chunk.byteLength
			if (cap > 0 && total > cap) {
				controller.error(new ContentTooLargeError(cap))
				return
			}
			controller.enqueue(chunk)
		},
	})
	const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
		start(controller) {
			controller.enqueue(bytes)
			controller.close()
		},
	})
	const decompressed = source.pipeThrough(new DecompressionStream(encoding)).pipeThrough(capStream)
	const reader = decompressed.getReader()
	const chunks: Uint8Array[] = []
	let size = 0
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			chunks.push(value)
			size += value.byteLength
		}
	} catch (error) {
		if (error instanceof ContentTooLargeError) throw error
		throw new HTTPError(400, 'malformed compressed request body')
	}
	const merged = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		merged.set(chunk, offset)
		offset += chunk.byteLength
	}
	return merged
}

/**
 * Collect + decode a `Request` body — the shared body-collection pipeline
 * surfaced to middleware and handlers as the middleware context's cached
 * `body()`.
 *
 * @remarks
 * Collects the wire body capped at `options.limit` bytes ({@link
 * import('./constants.js').DEFAULT_BODY_LIMIT} by default — a 413 over),
 * transparently decompresses a `gzip`/`deflate` `Content-Encoding` body
 * through the zip-bomb-capped pipe ({@link decompressRequestBody}, capped at
 * `options.decompression`, default {@link
 * import('./constants.js').DEFAULT_DECOMPRESSED_LIMIT}), then decodes by
 * content type: `application/json` is parsed via `@orkestrel/contract`'s
 * `parseJSON` and scrubbed of prototype-pollution keys ({@link
 * scrubPrototype}); any other type decodes as UTF-8 text; an empty body
 * decodes to `undefined`.
 *
 * @param request - The `Request` to read the body from
 * @param options - The {@link BodyOptions} `limit` + `decompression` caps
 * @returns The parsed JSON value, the raw text, or `undefined` for an empty body
 * @throws {ContentTooLargeError} When the wire body or decompressed output exceeds its cap
 * @throws {HTTPError} When the compressed body is corrupt (400)
 *
 * @example
 * ```ts
 * const body = await readBody(request, { limit: 1_048_576 })
 * ```
 */
export async function readBody(request: Request, options?: BodyOptions): Promise<unknown> {
	const limit = options?.limit ?? DEFAULT_BODY_LIMIT
	const decompression = options?.decompression ?? DEFAULT_DECOMPRESSED_LIMIT
	const wire = await collectRequestBody(request, limit)
	const encoding = requestEncoding(request.headers.get('content-encoding'))
	const bytes =
		encoding === undefined ? wire : await decompressRequestBody(wire, encoding, decompression)
	if (bytes.length === 0) return undefined
	const contentType = request.headers.get('content-type')
	const semicolon = contentType === null ? -1 : contentType.indexOf(';')
	const bareType =
		contentType === null
			? ''
			: (semicolon === -1 ? contentType : contentType.slice(0, semicolon)).trim().toLowerCase()
	const text = new TextDecoder().decode(bytes)
	if (bareType === 'application/json') return scrubPrototype(parseJSON(text))
	return text
}
