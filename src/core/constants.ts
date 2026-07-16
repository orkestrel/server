import type { Encoding } from './types.js'

// The substrate's tunable defaults (AGENTS §5 constants file) — only the
// constants with a real consumer inside THIS package (AGENTS §21: build
// against a concrete consumer, not speculatively). Frozen so a consumer can
// read but never mutate the shared default. Middleware-package-only defaults
// (rate limiting, CSRF, sessions, static serving, multipart — Appendix A of
// the proposal) stay OUT of this file; they belong to that package's own
// `constants.ts`.

/** Default graceful-stop deadline (ms) the server gives in-flight requests on `stop()`. */
export const DEFAULT_DRAIN_MS = 10_000

/**
 * The `Symbol.for`-keyed brand `HTTPError` carries so `isHTTPError` recognizes
 * an instance thrown by ANOTHER copy of this package (the dual-package
 * hazard — a version-skewed or workspace-linked duplicate install), where
 * `instanceof` alone fails because the two copies' `HTTPError` constructors
 * are distinct objects.
 *
 * @remarks
 * `Symbol.for` interns the symbol on the GLOBAL symbol registry, so every
 * copy of this package that evaluates this key resolves the SAME symbol
 * instance — unlike a locally-scoped `Symbol()`, which would mint a fresh,
 * unequal symbol per copy and defeat the whole point of a cross-copy brand.
 */
export const HTTP_ERROR_BRAND = Symbol.for('@orkestrel/server.HTTPError')

/** Default maximum request body size (bytes) `readBody` accepts before a 413. */
export const DEFAULT_BODY_LIMIT = 1_048_576

/**
 * Default maximum DECOMPRESSED request body size (bytes) — the zip-bomb cap
 * the body pipeline's byte-counting `TransformStream` enforces when
 * transparently decompressing a `Content-Encoding` request body.
 *
 * @remarks
 * A small compressed payload (under {@link DEFAULT_BODY_LIMIT} on the wire)
 * can inflate by many orders of magnitude — a classic decompression bomb.
 * Capping the decompressed byte count makes the pipe ABORT the moment the
 * output would exceed this, BEFORE the full bomb is materialized, so the
 * inflation can never exhaust memory. Defaults to `16 MiB` — a generous
 * ceiling for a legitimate compressed JSON / form body, far below an OOM. A
 * consumer raises it via {@link import('./types.js').BodyOptions}
 * `decompression` for a workload that genuinely ships larger decompressed
 * bodies.
 */
export const DEFAULT_DECOMPRESSED_LIMIT = 16_777_216

/**
 * The SSE response headers the `openStream` seam always sets.
 *
 * @remarks
 * `text/event-stream` is the media type browsers dispatch as SSE; `no-cache`
 * keeps a proxy from caching the stream; `keep-alive` holds the connection
 * open; `X-Accel-Buffering: no` opts a buffering reverse proxy (nginx) out so
 * events flush promptly rather than batching. Frozen so a consumer can read
 * but never mutate the shared default; `openStream` merges any
 * {@link import('./types.js').StreamOptions.headers} UNDER these.
 */
export const SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
	'Content-Type': 'text/event-stream; charset=utf-8',
	'Cache-Control': 'no-cache',
	Connection: 'keep-alive',
	'X-Accel-Buffering': 'no',
})

/**
 * The strict charset `isValidRequestId` requires an incoming `X-Request-ID`
 * to match — `^[A-Za-z0-9_-]{1,200}$` — so a CRLF / log-injection / oversized
 * / control-char-bearing incoming id is REJECTED (a fresh id is minted
 * instead) rather than ever riding into a response header or `context.state`
 * (AGENTS §14 totality). Frozen so a consumer can read but never mutate the
 * shared default.
 */
export const REQUEST_ID_PATTERN: Readonly<RegExp> = Object.freeze(/^[A-Za-z0-9_-]{1,200}$/)

/**
 * The set of bare `Content-Type`s `isCompressibleType` treats as
 * COMPRESSIBLE, beyond the `text/*` prefix + structured-suffix (`+json` /
 * `+xml`) rules that helper also applies.
 *
 * @remarks
 * The text-shaped application types worth compressing (JSON / JavaScript /
 * XML / SVG / WASM / a few document formats) — NOT already-compressed
 * binaries (`image/png`, `image/jpeg`, `video/*`, `application/zip`, a font's
 * `woff2`), which gzip/deflate would only bloat. Frozen so a consumer reads
 * but never mutates the shared default.
 */
export const COMPRESSIBLE_TYPES: ReadonlySet<string> = new Set([
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
])

/**
 * The default {@link Encoding} content-codings the substrate offers, in
 * PREFERENCE order — `gzip` / `deflate`.
 *
 * @remarks
 * `identity` (no compression) is always implicitly acceptable and is NOT
 * listed here — it is the fall-through when a client accepts none of these.
 * Brotli is omitted per the core's `CompressionStream`-only decision (see
 * {@link Encoding}). Frozen so a consumer can read but never mutate the
 * shared default.
 */
export const DEFAULT_ENCODINGS: readonly Encoding[] = Object.freeze(['gzip', 'deflate'])
