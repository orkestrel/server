import type { Encoding } from './types.js'

// The substrate's tunable defaults — only the constants with a real consumer
// inside THIS package: a capability arrives with its first real consumer,
// never speculatively. Each is frozen or declared
// readonly, so a consumer reads but never mutates the shared default. The
// defaults only `@orkestrel/middleware` needs (rate limiting, CSRF, sessions,
// static serving, multipart) stay OUT of this file; they belong to that
// package's own `constants.ts`.

/**
 * Names the default graceful-stop deadline `stop()` gives in-flight requests and
 * claimed upgraded sockets, `10_000` ms.
 */
export const DEFAULT_DRAIN_MS = 10_000

/**
 * Names the `Symbol.for`-interned brand `HTTPError` carries,
 * `@orkestrel/server.HTTPError`, so `isHTTPError` recognizes an instance across
 * package copies. A consumer never sets it by hand.
 *
 * @remarks
 * The brand exists for the dual-package hazard — a version-skewed or
 * workspace-linked duplicate install — where `instanceof` alone fails because
 * each copy's `HTTPError` constructor is a distinct object.
 * `Symbol.for` interns the symbol on the global symbol registry, so every
 * copy of this package that evaluates this key resolves the same symbol
 * instance — unlike a locally-scoped `Symbol()`, which would mint a fresh,
 * unequal symbol per copy and defeat the whole point of a cross-copy brand.
 */
export const HTTP_ERROR_BRAND = Symbol.for('@orkestrel/server.HTTPError')

/**
 * Names the default maximum request body size `readBody` accepts before a 413,
 * `1_048_576` bytes.
 */
export const DEFAULT_BODY_LIMIT = 1_048_576

/**
 * Names the default maximum decompressed request body size, `16_777_216` bytes — the
 * zip-bomb cap the body pipeline's byte-counting `TransformStream` enforces when
 * it transparently decompresses a `Content-Encoding` request body.
 *
 * @remarks
 * A small compressed payload (under {@link DEFAULT_BODY_LIMIT} on the wire)
 * can inflate by many orders of magnitude — a classic decompression bomb.
 * Capping the decompressed byte count makes the pipe abort the moment the
 * output would exceed this, before the full bomb is materialized, so the
 * inflation can never exhaust memory. Defaults to `16 MiB` — a generous
 * ceiling for a legitimate compressed JSON / form body, far below an OOM. A
 * consumer raises it through {@link import('./types.js').BodyOptions}
 * `decompression` for a workload that genuinely ships larger decompressed
 * bodies.
 */
export const DEFAULT_DECOMPRESSED_LIMIT = 16_777_216

/**
 * Holds the SSE response headers a `Stream` sets on its response, merged under any
 * caller `headers` so a caller repeating one of these keys replaces its value.
 *
 * @remarks
 * `text/event-stream` is the media type browsers dispatch as SSE; `no-cache`
 * keeps a proxy from caching the stream; `keep-alive` holds the connection
 * open; `X-Accel-Buffering: no` opts a buffering reverse proxy (nginx) out so
 * events flush promptly rather than batching. Frozen so a consumer can read
 * but never mutate the shared default; the merged keys are
 * {@link import('./types.js').StreamOptions.headers}.
 */
export const SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
	'Content-Type': 'text/event-stream; charset=utf-8',
	'Cache-Control': 'no-cache',
	Connection: 'keep-alive',
	'X-Accel-Buffering': 'no',
})

/**
 * Defines the strict charset `isValidRequestId` requires an incoming `X-Request-ID`
 * to match, `^[A-Za-z0-9_-]{1,200}$`.
 *
 * @remarks
 * An incoming id carrying CRLF, a log-injection payload, a control character,
 * or more characters than the pattern admits fails the match and is rejected —
 * a fresh id is minted instead — so it never rides into a response header or
 * `context.state`. Frozen so a consumer can read but never mutate the shared
 * default.
 */
export const REQUEST_ID_PATTERN: Readonly<RegExp> = Object.freeze(/^[A-Za-z0-9_-]{1,200}$/)

/**
 * Holds the bare `Content-Type` values `isCompressibleType` treats as compressible,
 * beyond the `text/*` prefix and structured-suffix (`+json`, `+xml`) rules that
 * helper also applies.
 *
 * @remarks
 * The text-shaped application types worth compressing (JSON / JavaScript /
 * XML / SVG / WASM / a few document formats) — never already-compressed
 * binaries (`image/png`, `image/jpeg`, `video/*`, `application/zip`, a font's
 * `woff2`), which gzip/deflate would only bloat. The declared `ReadonlySet`
 * withholds `add` / `delete` / `clear` from the shared default, so a consumer
 * reads it without reaching a mutator.
 */
export const COMPRESSIBLE_TYPES: ReadonlySet<string> = Object.freeze(
	new Set([
		'application/json',
		'application/javascript',
		'application/xml',
		'application/xhtml+xml',
		'application/rss+xml',
		'application/atom+xml',
		'application/ld+json',
		'application/manifest+json',
		'application/vnd.api+json',
		'application/wasm',
		'image/svg+xml',
		'application/pdf',
	]),
)

/**
 * Lists the default {@link Encoding} content-codings the substrate offers, in
 * preference order — `gzip` then `deflate`.
 *
 * @remarks
 * `identity` (no compression) is always implicitly acceptable and is not
 * listed here — it is the fall-through when a client accepts none of these.
 * Brotli is omitted per the core's `CompressionStream`-only decision (see
 * {@link Encoding}). Frozen so a consumer can read but never mutate the
 * shared default.
 */
export const DEFAULT_ENCODINGS: readonly Encoding[] = Object.freeze(['gzip', 'deflate'])
