# PROPOSAL — `@orkestrel/server`

A typed, enterprise-grade HTTP server that **consumes** `@orkestrel/router`: an
environment-agnostic core (the middleware seam, the shared request/response
substrate, the error vocabulary) and a deliberately node-bound server face (the
lifecycle, the listener, the upgrade seam). The middleware architecture is
designed here, now, so the future `@orkestrel/middleware` package drops onto a
frozen seam with nothing to retrofit.

> **Status: awaiting approval.** `old/` (the author's original server and its
> design doc) is reference material for this proposal and is deleted when the
> rebuild lands. Nothing in `old/` ships.

---

## 1. What the old server got right — and why it still must be rebuilt

The old implementation (`old/http.md` + sources + 4,200 lines of behavioral
tests) is *good*: a correct lifecycle state machine with an event-driven drain,
a disciplined Koa onion, and a security posture that is genuinely rare —
session-bound CSRF, cookie-injection guards, zip-bomb-capped decompression,
sniff-authoritative uploads, IPv6 `/64` rate keys, reserved-device-name
traversal defense, constant-time token verification. Those behaviors are the
crown jewels and this proposal preserves every one (§8).

It must be rebuilt anyway, for one structural reason: **it is welded to
`node:http`'s mutable vocabulary.** Handlers write into a `ServerResponse`
through context responders; compression exists only via a `writeHead/write/end`
monkey-patch; cookies race "must land before send"; and the route registry
duplicates what `@orkestrel/router` now owns. In the new world handlers
**return fetch `Response`s** — and on that single inversion, most of the old
plumbing evaporates:

| Old machinery | Fate under fetch vocabulary |
| --- | --- |
| `RouteManager`/`Route`/`RouteGroup`, auto-HEAD/OPTIONS/405 | **Dies** — `@orkestrel/router`'s `Dispatcher` owns all of it |
| `RouteHandlerContext` + `json/text/empty/error` responders | **Dies** — handlers return `Response`; params/url come from `RouteContext` |
| `bufferResponse` monkey-patch + its 6-helper entourage | **Dies** — a returned `Response` is directly readable |
| "Set-Cookie must write before send" transport gymnastics | **Dies** — a returned `Response` is always post-processable |
| Old `parseURL`/`requestMethod`/`sendJSON…`/adapter | **Dies** — the router's `buildRequest`/`sendResponse`/`parseMethod` own it |
| Server's own last-resort 500 duplicating the adapter's | **Dies** — exactly one transport last-resort (the adapter's), one app boundary (§5.3) |
| Lifecycle, drain, upgrade fan-out, close semantics | **Survives** — correctly node-bound (§4) |
| Every pure security/protocol helper | **Survives verbatim** — into core (§3) |

## 2. Design philosophy

- **The server consumes the router.** Routing, matching, dispatch, auto-HEAD/
  OPTIONS/405 live in `@orkestrel/router`. This package never re-implements a
  matcher, a route registry, or a dispatch outcome — the reincarnation of the
  old "framework hiding in a router" failure is a named kill-list item.
- **Core-first, honestly audited.** The core-eligibility question was researched
  subsystem-by-subsystem (§3/§4). The verdict vindicates the push: once the
  vocabulary is fetch-standard, almost all middleware *logic* is
  environment-agnostic. The server face keeps only what is physically
  node-bound — and §4 states the pushback case for each item kept there.
- **Middleware is a seam here, batteries elsewhere.** This package ships the
  middleware *contract* (types + composition + the shared substrate helpers)
  and zero policy middleware. The batteries — CORS, compression, sessions,
  CSRF, tokens, rate limiting, security headers, ETag, static, multipart — are
  the future `@orkestrel/middleware` package's charter, fully rostered in
  Appendix A so nothing is unaccounted for.
- **Contract is the backbone.** `@orkestrel/contract` guards every construction
  boundary and every untrusted input: option bags validated at `createServer`
  (guards over function-bearing members, `recordOf`-style shapes where data-only),
  `parseJSON` + prototype scrub on bodies, total `is*` narrowing on every
  header/cookie/token read. Hot paths stay guard-free per the line convention.
- **Siblings everywhere they honestly fit.** `emitter` (§13 lifecycle events),
  `abort` (stop signal, composed per-request), `timeout` (the drain deadline —
  its first natural consumer), `router` (everything routing). `budget` belongs
  to the middleware package's rate limiter, not here.

### Non-goals

Templating; ORM/DB; DI containers; validation DSLs (contract exists);
file-based routing; WebSocket protocol (RFC 6455 stays a consumer of the
upgrade seam); sessions/auth/CORS/compression/static/multipart as *shipped
middleware* (they are the middleware package's, per Appendix A); health
endpoints (an app route — the server exposes the drain/readiness *state* an
app reads); a second error-policy channel.

## 3. Architecture and the core-eligibility split

```
src/core/    middleware seam (types + compose), error vocabulary, and the
             shared substrate: cookies, tokens (WebCrypto), negotiation,
             SSE, body reading (limits + decompression + scrub), security
             primitives, Negotiator — all fetch/string-pure
src/server/  the node face: Server lifecycle entity, node:http binding via
             the router's adapter helpers, upgrade seam, connection-fact
             injection, discoverPort
```

The browser face is **trimmed** (configs, vite project, `setupBrowser.ts`, the
`./browser` export): a browser cannot host an HTTP server, and no honest
browser surface exists. Config ground truth follows the router precedent:
core inherits node types, so `Request`/`Response`/`Headers`/`ReadableStream`/
`CompressionStream`/`crypto.subtle` are all typed in core (this is also the
recorded exception to AGENTS §17.7's stricter prose — the configs and the
router precedent govern).

**Core-eligible (the vindicated list).** Middleware composition; CORS origin
resolution + `Vary` merging; content negotiation (`parseAcceptHeader` family +
`Negotiator`); cookie parse/serialize/signed machinery; token sign/verify;
ETag compute/compare; `Range` parsing; security-header resolution +
request-id validation; rate-window math + `ipv6Network`/`clientRateKey`
collapse; session lifecycle logic (the machinery, not the shipped middleware);
SSE serialization + the `Response`-returning stream helper; body collection
with byte limits, transparent request decompression, and the zip-bomb cap;
`HTTPError` vocabulary. All fetch/string-pure, all future-middleware substrate.

**Three honest costs of core-first, accepted:**

1. **WebCrypto is async.** `signToken`/`verifyToken` move from sync
   `node:crypto` HMAC to `crypto.subtle` — so they, the signed-cookie
   read/write, and any session transport become async. The middleware chain is
   already async and absorbs it; `subtle.verify` is constant-time internally,
   so the old `safeCompare` is *retired*, not ported. (The salvage reviewer
   argued for keeping sync `node:crypto`; overruled — the author's core-first
   mandate wins, and the async cost lands only on construction-adjacent paths.)
2. **`CompressionStream` has no brotli.** gzip/deflate are web-standard;
   `br` parity is the middleware package's decision (a `node:zlib` variant in
   its node entry, or wait for the pending Node `CompressionStream` brotli).
   Recorded here so the substrate choice is deliberate.
3. **No `maxOutputLength` on `DecompressionStream`.** The zip-bomb cap is
   re-expressed as a byte-counting `TransformStream` that aborts the pipe the
   moment output exceeds the cap — same fail-before-materialize property the
   old `node:zlib` cap had; the old bomb tests pin it.

## 4. The server face — the pushback case, item by item

The author asked for rigor before conceding anything to the server face. What
stays, and why it genuinely cannot move:

- **The listener + lifecycle.** `node:http.createServer`, `listen`,
  `closeIdleConnections`/`closeAllConnections`, ephemeral-port resolution —
  no fetch-standard equivalent exists. The `Server` entity (§5.3) is the one
  irreducibly node-bound orchestrator. (On fetch-native runtimes — Bun/Deno/
  workers — consumers skip this face entirely: `compose(middleware, dispatcher)`
  from core IS the fetch handler. That is the proof the split is honest.)
- **The upgrade seam.** A protocol upgrade hands over a raw `Duplex` socket —
  it escapes the `Request → Response` model by definition. Fan-out semantics
  survive verbatim (first-claimer-wins, throw = decline + `error` event,
  unclaimed = destroy).
- **Connection facts.** Peer IP (rate keys) and the TLS flag (auto-`Secure`
  cookies) exist only on the socket. They are injected once, at the adapter
  boundary, into typed per-request state (§5.2) — so the *middleware* that
  consume them stay core-pure.
- **Static files and multipart staging** are `node:fs`-bound forever — but they
  are batteries, so they live in the middleware package's node entry
  (Appendix A), not here. The server face stays three concerns big.

## 5. Public API

### 5.1 The middleware seam (core — the frozen contract)

```ts
// The composition context — plain data, one per request, shared by every
// middleware AND (as `state`) by the route handlers behind the dispatcher.
interface MiddlewareContext<TState> {
	readonly url: URL
	readonly method: string          // the raw verb (the Dispatcher narrows)
	readonly state: TState           // THE shared bag — also dispatcher.handle's state
	body(): Promise<unknown>         // lazy, cached, limit+decompression+scrub (§5.4)
}

type NextFunction = (request?: Request) => Promise<Response>
	// call → downstream runs (optionally with a substituted Request);
	// don't call → short-circuit with your own Response;
	// second call → rejects (the double-next guard, preserved)

type MiddlewareHandler<TState> = (
	request: Request,
	context: MiddlewareContext<TState>,
	next: NextFunction,
) => Response | Promise<Response>

function compose<TState>(
	middleware: readonly MiddlewareHandler<TState>[],
	terminal: (request: Request, context: MiddlewareContext<TState>) => Promise<Response>,
): (request: Request, context: MiddlewareContext<TState>) => Promise<Response>
```

Decisions embedded here, with rationale:

- **Returning onion** (`next(): Promise<Response>`) — the shape that composes
  as pure functions when `Response` is the currency (h3 v2 precedent). A
  middleware transforms the request (via `next(newRequest)` or `state`), the
  response (after `await next()`), or short-circuits (rate-limit 429, CORS
  preflight 204) — no mutable framework object anywhere.
- **One `TState`, not per-middleware type accumulation.** Hono-style
  `<SIn, SOut>` accumulation was evaluated and rejected: it demands deep
  generic gymnastics, and the router's `Dispatcher.handle(request, state)` is
  already a single-`TState` seam. Instead, each middleware package battery
  publishes a **state-slice interface** (`TokenState`, `SessionState`,
  `RequestIdState`…) and the consumer intersects the slices they mount into
  their `TState`. Typed, honest, zero magic — and the ordering idioms
  (token guard stashes → rate limiter keys off it) work exactly as before,
  now type-visibly.
- **The bag IS the router's state.** `compose`'s terminal is
  `(request, context) => dispatcher.handle(request, context.state)` — so route
  handlers read the same object middleware wrote, as `RouteContext.state`,
  with no second plumbing.
- **What a separate middleware package peer-depends on** is exactly:
  `MiddlewareHandler`, `NextFunction`, `MiddlewareContext`, the state-slice
  convention, the error vocabulary (§5.5), and the substrate helpers (§5.4).
  Nothing node-typed is reachable from any of them.

### 5.2 Connection facts (the adapter-injected slice)

```ts
interface ConnectionInfo {
	readonly ip?: string        // socket peer address (spoof-proof rate keys)
	readonly encrypted: boolean // TLS flag (auto-Secure cookies)
}
```

The server face builds each request's `TState` via the consumer's
`state: (connection: ConnectionInfo) => TState` option — so `X-Forwarded-For`
is *never* implicitly trusted (a deployment behind a trusted proxy derives its
own client key in its `state` function or middleware; the old suite's
XFF-ignored test is preserved).

### 5.3 The `Server` entity (server face)

```ts
type ServerStatus = 'idle' | 'starting' | 'listening' | 'stopping' | 'stopped'

type ServerEventMap = {
	readonly start: readonly [port: number]
	readonly request: readonly [method: string, pathname: string]
	readonly upgrade: readonly [request: IncomingMessage, handled: boolean]
	readonly error: readonly [error: unknown]
	readonly stop: readonly []
	readonly drain: readonly [pending: number]
}

interface ServerOptions<TState> {
	readonly dispatcher: DispatcherInterface<TState>   // bring the router; the seam
	readonly state: (connection: ConnectionInfo) => TState
	readonly middleware?: readonly MiddlewareHandler<TState>[]
	readonly host?: string
	readonly port?: number            // omitted/0 ⇒ ephemeral (the default)
	readonly drain?: number           // graceful-stop deadline ms (via @orkestrel/timeout)
	readonly limit?: number           // default body-read byte cap (§5.4)
	readonly expose?: boolean         // boundary: leak non-HTTPError messages? default false
	readonly report?: (error: unknown) => void   // boundary sink; its throw is swallowed
	readonly timeouts?: { readonly request?: number; readonly headers?: number; readonly keepalive?: number }
	readonly on?: EmitterHooks<ServerEventMap>
	readonly error?: EmitterErrorHandler
}

interface ServerInterface<TState> {
	readonly id: string
	readonly status: ServerStatus
	readonly port: number | undefined
	readonly dispatcher: DispatcherInterface<TState>   // readonly introspection
	readonly emitter: EmitterInterface<ServerEventMap>
	use(middleware: MiddlewareHandler<TState>): void
	use(middleware: readonly MiddlewareHandler<TState>[]): void
	upgrade(handler: UpgradeHandler): void
	start(): Promise<number>
	stop(): Promise<void>
	destroy(): Promise<void>
}
```

Semantics (old lifecycle preserved, re-based):

- **Status machine + restart** exactly as the old `Server.ts`: fresh stop-`Abort`
  per run (a restarted server is not born aborted); `start` from `listening`
  rejects; `stop`/`destroy` idempotent; `EADDRINUSE` rejects with no silent
  ephemeral fallback.
- **Per request**: track in-flight (finish on response completion or close) →
  build `Request` via the router's `buildRequest` (client disconnect already
  aborts `request.signal`; the server *additionally* links its stop signal in
  via `@orkestrel/abort`'s `linkSignal`, closing the old design's latent gap
  where handlers could not observe `stop()`) → run the composed onion →
  terminal `dispatcher.handle(request, state)` → `sendResponse`. The router's
  adapter helpers are consumed, never duplicated.
- **The built-in boundary is lifecycle machinery, not policy**: the Server
  wraps the composed chain once — a thrown `HTTPError` renders as its status +
  message; any other throw renders 500 (message hidden unless `expose`),
  `report` invoked, `error` emitted. Exactly one app-error seam; the adapter's
  bare-500 remains the transport last resort beneath it. The middleware
  package may still ship a richer boundary that short-circuits earlier.
- **Graceful drain**: on `stop()`, refuse new connections, fire the stop abort,
  arm `createTimeout({ ms: drain })` from `@orkestrel/timeout`, wake-park on
  the in-flight counter, emit `drain` with the pending count, force-close only
  if the deadline fired (else close gracefully, always dropping idle
  keep-alive sockets so close never hangs).
- **Enterprise knobs**: `timeouts.request/headers/keepalive` map onto
  `node:http`'s `requestTimeout`/`headersTimeout`/`keepAliveTimeout`
  (headers > keepalive guarded at construction — the Slowloris footgun).
- **Upgrade seam**: verbatim old semantics, node face only.
- `discoverPort` survives as a server-face helper.

### 5.4 The shared substrate (core helpers — future-middleware fuel)

All pure, all exported, all guarded total (§14), all salvaged with their
security properties intact: cookie machinery (`parseCookies`,
`serializeCookie`, `isCookieName`, `isCookieAttribute`, `decodeCookieValue`,
signed read/write, `clearCookie` re-expressed over `Headers`), token machinery
(`signToken`/`verifyToken`/`normalizeSecret` — WebCrypto async, rotation +
HMAC-covered expiry preserved), negotiation (`parseAcceptHeader`,
`negotiateEncoding`, `codingQuality`, `isCompressibleType`, the `Negotiator`
entity with `format` returning a `Response`), conditional-request helpers
(`computeBodyETag` — WebCrypto digest, `matchesETag`, `unwrapETag`,
`parseRange`), security primitives (`resolveSecurityHeader`,
`isValidRequestId`, `resolveOrigin`, `mergeVary`, `clientRateKey`,
`ipv6Network`, `resolveSecure`), SSE (`serializeEvent` + an `openStream`-style
helper returning `{ response, write, comment, end, closed }` over a
`ReadableStream` `Response`), and the body pipeline: `readBody(request,
{ limit, decompression })` — collect capped, transparently decompress
(gzip/deflate via `DecompressionStream` behind the byte-cap TransformStream),
decode by content type, `scrubPrototype`/`isDangerousKey` on JSON — surfaced
to middleware and handlers as the context's cached `body()` so the stream is
read exactly once (the old clause-4 guarantee, kept).

### 5.5 Errors (core)

`HTTPError` (status + optional context), `ContentTooLargeError` (413),
`isHTTPError` — verbatim salvage, zero node coupling. (`MultipartError`
migrates to the middleware package with its owner.)

## 6. Sibling integration

| Package | Where |
| --- | --- |
| `@orkestrel/router` | The dispatcher option + `buildRequest`/`sendResponse`/`parseMethod` reuse; route handlers are router handlers, untouched |
| `@orkestrel/contract` | Construction guards on every option bag (functions via `isFunction`, numbers via `isFiniteNumber`/bounds, strings via `isString`); `parseJSON` inside `readBody`; total narrows on every untrusted read — the mandated backbone |
| `@orkestrel/emitter` | The `Server`'s §13 emitter (`ServerEventMap`); hooks + listener-error option |
| `@orkestrel/abort` | The stop signal; `linkSignal(requestSignal, stopSignal)` per request |
| `@orkestrel/timeout` | The drain deadline (`createTimeout({ ms })`) — first sibling consumer |
| `@orkestrel/budget` | NOT a dependency here — documented as the middleware package's rate-limit tally |
| `@orkestrel/guide` | Parity: one `server.md` concept row spanning `src/core` + `src/server` |

## 7. What `@orkestrel/middleware` will find waiting (the accounting)

The frozen seam (§5.1), the state-slice convention, the substrate (§5.4), the
error vocabulary (§5.5), `ConnectionInfo` in state (§5.2) — plus Appendix A's
complete roster mapping every old battery to its layer, its state slice, its
salvage source, and the invariants it must preserve. The middleware package
peer-depends on `@orkestrel/server` for types and substrate, ships
`options => MiddlewareHandler<TState>` factories, and splits pure batteries
from node-bound ones (static/multipart) via its own exports.

## 8. Security invariants preserved (the crown jewels)

Every one of these survives with a pinned test (source: the old security
suite): CORS `Vary: Origin` on the reflect path + literal `Origin: null` never
reflected; cookie-name token validation (no whitespace-padded `__Host-`
spoofing) + `Domain`/`Path` injection throws + `SameSite=None` forces
`Secure` + auto-`Secure` from the TLS connection fact; token verification
total (malformed/tampered/expired/empty-rotation → `undefined`) + HMAC-covered
expiry + rotation lists + constant-time comparison (via `subtle.verify`);
zip-bomb abort-before-materialize incl. the between-cap-and-limit isolation
case; prototype-pollution scrub on every parsed body; request-id strict
charset (CRLF/log-injection/oversize rejected, UUID fallback); IPv6 `/64`
collapse; XFF never implicitly trusted; ReDoS-linear Accept/Range/Cookie
parsers; upgrade-handler throw isolation (no process crash, no socket leak);
`expose: false` leaks nothing, `HTTPError` messages always surface. The
middleware-owned jewels (CSRF session-binding, traversal + reserved-device
containment, sniff-authoritative uploads, absoluteTtl, regenerate
anti-fixation) are recorded in Appendix A as that package's acceptance bar.

## 9. Testing strategy

- **Lifecycle acceptance (ported from the old `Server.test`)**: the status
  matrix, restart-fresh-abort, EADDRINUSE honesty, host/port binds, ephemeral
  default, `discoverPort`, graceful-vs-forced drain (slow finishes; hung
  force-closes at deadline), 20-parallel-none-dropped, emit-safety, and the
  full upgrade matrix — real sockets, no mocks.
- **Seam tests**: compose ordering (outer-first), double-next rejection,
  short-circuit, request substitution, response transformation, state
  threading through to a route handler via `dispatcher.handle`, boundary
  mapping (HTTPError/other/expose/report), stop-signal observability inside a
  handler.
- **Substrate tests**: port every surviving pure-helper pin 1:1 from the old
  helpers/security suites (cookie injection matrix, token totality + rotation
  + expiry tamper, zip bomb, scrub, negotiation q-matrix, ETag RFC 7232
  matrix, Range totality, request-id charset, `ipv6Network`) — plus WebCrypto
  async signatures and `expectTypeOf` suites for the middleware generics.
- **One thin integration capstone**: `buildRequest → onion → dispatcher.handle
  → sendResponse` round-trip over a real socket (routing outcomes themselves
  are the router's tests — not re-pinned here).
- **Guides parity**: `server.md` spanning both faces, standard drop-in suite.

## 10. Implementation plan

| Unit | Owns | Content |
| --- | --- | --- |
| U0 | `package.json`, configs trim | add `@orkestrel/timeout`; remove browser face (configs/vite project/`setupBrowser.ts`/`./browser` export); lockfile |
| U1 | `src/core/types.ts`, `constants.ts`, `errors.ts` | full seam + substrate type surface; HTTPError vocabulary |
| U2 | `src/core/helpers.ts` | the substrate: cookies, tokens (WebCrypto), negotiation, ETag/Range, security primitives, SSE, `readBody` + zip-bomb TransformStream, scrub |
| U3 | `src/core/Negotiator.ts`, `compose` (helpers or own module), `factories.ts`, `index.ts` | entity + composition + barrel |
| U4 | `src/server/**` | `Server` entity over the router adapter, upgrade seam, `ConnectionInfo` injection, `discoverPort`, tuning knobs |
| U5 | `tests/**` | the four suites of §9 (lifecycle/seam/substrate/capstone) |
| U6 | `guides/**`, parity | `server.md` (one guide, kind-organized tables per the router precedent), manifest row, parity green |
| U7 | — | delete `old/`; verifier sweep; checker + opus reviewers; push |

Serial U0→U1→U2→U3→U4; U5 ∥ U6 after U4; U7 last. Same disjoint-ownership,
deviation-report, independent-verification discipline as the router build.

## 11. Open decisions (approval requested)

1. **The middleware seam shape** (§5.1) — returning onion, single-`TState`
   with published state slices, the bag doubling as the router's state.
   This freezes the `@orkestrel/middleware` contract; approve deliberately.
2. **Batteries all move to the middleware package** — this server ships zero
   policy middleware (built-in boundary is lifecycle machinery, not
   middleware). Alternative: bundle 2-3 starters (CORS, security headers)
   here. Recommendation: as proposed — clean charters.
3. **WebCrypto-async tokens** (accepting the async ripple; retiring
   `safeCompare`). Alternative: sync `node:crypto` in the server face,
   sacrificing core-first for tokens. Recommendation: as proposed.
4. **`dispatcher` as a required option** (bring-your-own router) vs the server
   constructing one from `routes`. Recommendation: required option — the
   composition seam stays explicit, and the dispatcher remains independently
   testable/introspectable.
5. **`old/` deletion** in U7, per your standing instruction.

---

## Appendix A — the `@orkestrel/middleware` roster (accounted for, not built)

| Battery | Layer | State slice | Salvage source / invariants to preserve |
| --- | --- | --- | --- |
| `createBoundary` (richer than built-in) | pure | — | old `createErrorBoundary`; expose/report semantics |
| `createCors` | pure | — | `resolveOrigin`/`mergeVary`; **Vary on reflect, `null` never reflected**; must claim preflights BEFORE the dispatcher's auto-OPTIONS (ordering is load-bearing) |
| `createSecurity` | pure | `RequestIdState` | hardened CSP defaults, COOP/CORP, opt-in COEP/HSTS; request-id charset |
| `createCompression` | pure (gzip/deflate) + node entry (`br`) | — | negotiation via substrate; streaming/SSE bypass; skip HEAD/204/304/already-encoded |
| `createETag` | pure | — | RFC 7232 weak comparison; GET+200 only; inner-of-compression composition |
| `createTokenGuard` | pure | `TokenState` | 401 mapping; stash for the rate-limit key idiom |
| `createRateLimiter` | pure | reads `TokenState`/`ConnectionInfo` | `@orkestrel/budget` per key; check-before-consume; clock seam; capacity LRU; IPv6 `/64`; 429 + Retry-After short-circuit |
| `createSession` / `createCookieSession` | pure | `SessionState` | store seam (memory store ships; DB store deferred — no database sibling), transport seam (async reads — WebCrypto), control handle, **absoluteTtl**, regenerate anti-fixation |
| `createCSRFGuard` | pure | reads `SessionState` | **session-bound double-submit**; sessionless fallback documented weaker |
| `createBodyParser` | pure | — | drives the substrate `readBody` eagerly with its limit; 413/400 mapping |
| `createStatic` | node | — | traversal guard verbatim (decode → strip → resolve-under-root), reserved device names (CVE-2025-27210), dotfiles policy, SPA segment-boundary fallback, Range/206/416, weak file ETags |
| `createMultipart` | node | — | streams `request.body` (NEVER `formData()` — it defeats the mid-stream DoS defense); random temp names; fail-closed cleanup on `request.signal`; sniff-authoritative magic bytes; `MultipartError` moves here |

Ordering idioms to document in that package: boundary outermost → security →
CORS (claims preflights) → compression → ETag (inner of compression) → token
guard → rate limiter → body parser → sessions → CSRF.
