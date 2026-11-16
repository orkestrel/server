# Campaign: router, server, and middleware quality and performance

## Goal

Harden `@orkestrel/router`, `@orkestrel/server`, and `@orkestrel/middleware` to a total, measured contract on untrusted HTTP input, and close the four causes in § Rulings at their source: one `Request` per exchange, a pull-based body, one reading of each path, and a server-only middleware.

## Exit criterion

- Every unit in § Sequence is landed, reviewed under the stop rule, and merged.
- Each oracle in § Oracles landed red before its patches and holds green, and each one has its mutation controls.
- A scaffold-generated server application composes the three candidates through `swap.ts` pins and drives a login flow.
- Router 0.0.23, server 0.0.29, and middleware 0.0.35 are released in that layer order, then the mcp, browser, toolbox, and scaffold visits close.

## Repositories

| Repository                                                   | URL                                     |
| ------------------------------------------------------------ | --------------------------------------- |
| `@orkestrel/router`                                          | https://github.com/orkestrel/router     |
| `@orkestrel/server`                                          | https://github.com/orkestrel/server     |
| `@orkestrel/middleware`                                      | https://github.com/orkestrel/middleware |
| `@orkestrel/mcp`, `@orkestrel/browser`, `@orkestrel/toolbox` | visits after the releases               |
| `@orkestrel/scaffold`                                        | ROADMAP items in § Deferred             |

## Governing skills

- `orkestrel-harden` for each package unit.
- `orkestrel-align` for the seam between the three packages and the consumer run.
- `orkestrel-falsify` for each review the size gate names.
- `orkestrel-publish` for the releases and the tarball pins.

## Rulings

### Four causes

1. **The signal is fixed inside the `Request`.** A layer that needs cancellation rebuilds the `Request`: server's `Server.#accept` and middleware's `createDeadline`. The rebuild takes the body (`ReadableStream is locked` behind `createDeadline`), leaves the context describing another request, and costs a second header copy per request.
2. **Router's node adapter hand-writes both stream pumps** in `src/server/helpers.ts`. They buffer an unread body without bound, end a failed response as complete, and leave an idle stream open after a disconnect.
3. **One path is read by more than one matcher.** `new URL(target, origin)` reads `//host/path` as an authority, a raw literal is compared with an encoded pathname, and middleware's `only` matches exactly where the router folds a slash.
4. **Middleware files Node-bound batteries under a host-independent `src/core`.** Closed by unit M0a.

### Ownership

| Subject                                        | Owner               | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node:http` to fetch conversion                | router `src/server` | One `IncomingMessage` yields one `Request`. `RequestOptions.signal` exists. The request signal aborts on a peer disconnect or on that signal, and on nothing else.                                                                                                                                                                                                                                                                                                             |
| Request body stream                            | router `src/server` | Pull-based. An unread body holds no more than the high-water mark. A cancel discards the remainder, leaves the connection reusable, and never reports a disconnect.                                                                                                                                                                                                                                                                                                            |
| URL, `Host`, and target form                   | router `src/server` | An origin-form target is appended to the origin; an absolute form takes its own authority, for `http:` and `https:` only; every other form is refused. `Host` is one field line holding a host with an optional port, checked whenever it is present, for every target form (RFC 9112 § 3.2); `options.origin` overrides only the URL's authority. A refusal throws, and `Server` maps it to 400. No per-request signal links to a run-lived signal through `AbortSignal.any`. |
| Response write                                 | router `src/server` | `sendResponse` rejects after destroying the target when the body source fails or Node refuses a header. It resolves when the target finished or the peer closed.                                                                                                                                                                                                                                                                                                               |
| Body decode, limit, and cache                  | server `src/server` | One read per exchange, byte-limited and decompressed. JSON and `application/x-www-form-urlencoded` decode to a scrubbed record; other types decode to text.                                                                                                                                                                                                                                                                                                                    |
| Exchange seam (`MiddlewareContext`, `compose`) | server `src/server` | § The exchange seam.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Error rendering                                | server `src/server` | One total renderer turns a throw into a `Response`. `Server` and middleware's `createBoundary` both call it, and both report only a non-`HTTPError`, with `(error, RequestLine)`.                                                                                                                                                                                                                                                                                              |
| HMAC key                                       | server `src/server` | A signer entity imports each key once and holds it in a `#` field, gated on a measurement (S6).                                                                                                                                                                                                                                                                                                                                                                                |
| Path matching                                  | router `src/core`   | § Paths.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Paths

- Router core compares one canonical text, produced by `encodePath` from router's own table of the URL Standard's path percent-encode set, `^` included. It runs on a pattern at registration and on the request text inside `Router.match`, `Router.entries`, and `matchPath`, so every door passes it, the Navigator's included. It keeps every escape and a lone `%` as written, and never decodes.
- `compilePath` refuses U+005C, U+0009, U+000A, and U+000D with code `pattern`, and encodes every other member of the set.
- `sensitive: false` folds ASCII letters only, so `/CAFÉ` misses `/café`.
- A batch `add` admits whole before it registers any entry.
- `/us%65rs` stays a miss. A decoded capture is opaque text; the guide states that a consumer who maps a capture to a file path must contain it.
- `compilePath` refuses a final `*name` with a suffix, a parameter named for a prototype key, and a duplicate parameter name.
- Precedence is total: tier, then literal length within the segment; a remaining tie goes to the earlier registration.
- A 405's `Allow` carries `OPTIONS`, and the automatic `HEAD` cancels the `GET` body.
- The router keeps its linear scan; a radix tree, a regular expression, and `URLPattern` are refused until a consumer's table reads outside the identical-sides spread of its round trip.

### The exchange seam

- `MiddlewareContext` describes the accepted exchange and never changes. It gains `connection` and `abort(reason)`.
- `NextFunction` takes no argument; a call with one rejects with a `ServerError` of code `'NEXT'`.
- `Server` keeps in-flight exchanges in a `#` registry of abort handles, and `stop()` aborts each one. The `#pending` counter goes.
- `compose` gives each layer a mutable-header response in place of an immutable-header one.
- Header receipt, whole-request receipt, and idle keep-alive are delegated to `node:http` as `createServer` options; Node's `headersTimeout ≤ requestTimeout` relation replaces the `headers ≤ keepalive` check. `createDeadline` owns a response deadline through `context.abort`.
- A handler may throw any status `Response` admits. A null-body status renders with no body; any other invalid status renders 500 and is reported. A reporter that throws or rejects is contained. After the headers, a body failure destroys the connection and reaches `error` and `report`. `response` fires only for a response that finished, and a peer disconnect is no fault.
- `serializeEvent` refuses a line break in `event` or `id` and a non-finite `retry`; a comment splits per line; `Stream` opens with one comment line.

### The security contract of middleware

- **Forwarded IP:** `proxies` takes index `length − proxies`, and `trusted` starts from the socket peer. The `Forwarded` claim is dropped.
- **CSRF:** the token is `random.HMAC(key, label + sessionId + random)`, a signed double submit that carries no session id; with no session, it is a signed double submit over the battery's own nonce cookie. The token is read from a JSON or urlencoded body; a multipart form sends it in the header. On rotation, `state.csrf` holds the arrived session's token, and a rotating handler answers with a redirect.
- **CORS:** in list mode every response and preflight carries `Vary: Origin`; a disallowed origin's preflight carries no CORS headers. `createCors` and `CorsOptions` become `createCORS` and `CORSOptions`.
- **Scoping:** `only` and `except` match through router core's `compilePath` and `matchPath`, and middleware peers on router.
- **Sessions:** a session is stored only after a handler writes to it or regenerates it. Eviction at capacity is constant-time.
- **Admission:** every factory admits its option bag whole, and a refusal is a `ContractError` with its path.

### Performance

The realistic load is one Node process serving a scaffolded application's JSON routes over keep-alive: tens of headers, bodies of a few KB, tens of routes, the full security onion, handlers that spend milliseconds in I/O, and long runs between restarts.

| Cost                                                                 | Ruling                | Bar                                                                                                                   |
| -------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Heap growth per request                                              | Repair                | A test proves nothing per request stays attached to a run-lived object, after the carrier is attributed.              |
| Unread-body buffering                                                | Repair                | `socket.bytesRead` is equal at two upload sizes.                                                                      |
| The server's unattributed CPU gap against a bare `node:http` control | Measure first (S5)    | A CPU profile with ablation after S2a, read interleaved with an identical-sides arm and a bar written before the run. |
| HMAC key import per verification                                     | Build the signer (S6) | Read interleaved inside the composed onion.                                                                           |
| Multipart field accounting                                           | Repair                | A linear step count at the field limit.                                                                               |
| Superlinear regular expressions on untrusted input                   | Repair, by census     | A cost row per fixed function: the time at 4n against n, bounded from a noise reading.                                |
| Core compression                                                     | Guide only            | The onion fence mounts `createNodeCompression`.                                                                       |

### Oracles

Each one lands red before its patches, and each patch has a mutation control.

1. **The router path matrix** (router `tests/src/core/integration.test.ts`): a reference matcher written from the declared grammar, an order-permutation property, and a seeded differential against 0.0.22.
2. **The HTTP conformance matrix** (router and server `tests/src/server/integration.test.ts`): a bare `node:http` control fed the same bytes, a declared host table, the raw client's own framing parse, and the fixture's knowledge of the disconnect.
3. **The composed-stack matrix** (middleware `tests/src/server/integration.test.ts`, a real `Server`, a real dispatcher, and a proxy fixture). Its declared invariants:
   - no 5xx unless the handler threw a non-`HTTPError`;
   - the credentialed and uncredentialed arms agree;
   - the resolved IP is the peer or a hop the fixture appended;
   - no script-readable value holds the session id;
   - `Vary: Origin` is present in list mode;
   - every earlier token of the session passes;
   - security headers sit on redirects and errors;
   - no 206 is content-coded;
   - a cookie-less request that writes nothing leaves the store unchanged;
   - the body is byte-equal in every order.
4. **Parser tables** for `parseRange` and cookie names, each with a seeded differential against an independent recognizer, and an SSE round trip through `@orkestrel/sse`.

### Stop rule

One review pass on numbered claims, by a reviewer that did not write the unit. A failed claim gets one repair, one re-audit, and a mutation probe. A recurring defect class is fixed by a census across its packages, never one instance at a time; a remedy that adds a mechanism returns as a design question.

### User rulings (2026-11-16)

- Remove `next(request)`.
- Delete router's `createListener`, with `handleListenerRequest`, `ListenerFunction`, and `StateFunction`.
- Server keeps one entry and adds no subpath: scaffold already marks a server-only package by its physical shape.
- Accept every security behavior change: session persistence on write, the CSRF token format, the `proxies` hop, unlinking staged files, and a rotating handler answering with a redirect.
- Middleware peers on `@orkestrel/router`; server gains a development dependency on `@orkestrel/sse`; router and server raise `engines.node` to `>=22.18.0`.
- Rename `createCors` and `CorsOptions` to `createCORS` and `CORSOptions` in middleware 0.0.35.
- Middleware becomes server-only with one entry: `src/core` merges into `src/server`, published as `.`, and the `./server` subpath goes with no alias. Nothing in middleware is needed in a browser.

## Sequence

1. **Router:**
   - R2, the node adapter contract (router `af49292` on `unit/r2`). Its review failed: the oracle's framing parse misreads null-body responses, two `Host` lines and an invalid `Host` beside an absolute form are accepted, and a run-lived `RequestOptions.signal` retains about 186 B per request through `AbortSignal.any` on Node 22. Fix round R2b closes each, and makes `sendResponse` cancel the body for HEAD, 1xx, 204, and 304, because an endless body to HEAD blocks the event loop on 0.0.22 too.
   - R1, the path contract (router `60418cd` on `unit/r1`). Its review failed because the host `URL` parser served as the path grammar. Fix round R1b builds § Paths from the path-grammar consultation and closes the Navigator's `fallback`, hash, and `match` doors in `src/core`.
   - Then R4, the navigator: W8, the veto, re-entrancy, `#current`, and two sites that compare raw text with an encoded location (`resolveLocationPath` against `base`, and `navigate` against `location.hash`). Before R4's brief, a script lists every site in router, server, and middleware that compares, prefixes, splits, or keys path text.
2. **Server:** S4, the untrusted substrate (server `dbbc6b8` and `c90ecec` on `unit/s4`, fix round S4c open for a quadratic `parseRange` strip); S2a, the exchange seam, pinned to R2's tarball; then S2b, the boundary and outcomes; S3, timeouts and the server matrix; S5, measured throughput; S6, the signer.
3. **Middleware:** M0a, the one-entry collapse (middleware `13622f4`, `7521cb2`); then, after server's tarball, M0b, adopt the seam; M1, the composed oracle; M5, admission; M2, identity and scoping; M3, CSRF and sessions after S6; M4, the response batteries; M6, multipart and static.
4. The regular-expression census (2026-11-16) found one superlinear pattern outside server: middleware's `isReservedDeviceName` (`src/server/helpers.ts`, `/[. ]+$/`), reached by every `createStatic` GET, about 317 ms for a run of 16,000 dots. M6 replaces it with `/(?<![. ])[. ]+$/`, which agreed with the original on all 299,593 strings up to length 6 over space, dot, tab, U+00A0, U+3000, `a`, `¹`, and an astral character. The fix strips only U+002E and U+0020, strips a mixed trailing run whole, and trims a dots-and-spaces segment to empty. Router has none.
5. The mcp, browser, toolbox, and scaffold visits; the integrated `orkestrel-falsify` round; a tree-wide `verifier` run; the consumer run; the releases in layer order.

## Deferred

| Item                                                                                                                                                                                                                                                                                                                                                             | Trigger                                          | Owner                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------- |
| `@orkestrel/abort` 0.0.18's `linkSignal` and `createAbort({ signal })` compose through `AbortSignal.any`, which on Node 22.23.5 retains about 130 B per call while the source signal lives; link through a listener disposed at the child's end                                                                                                                  | the next `@orkestrel/abort` release              | abort, then its dependents |
| `@orkestrel/contract` 0.0.24 has no shape that wraps a guard and no optional that admits an explicit `undefined`, so middleware's M5 checks each foreign implementation key with the `objectOf` combinator after `admitValue`; fold those keys into the compiled shape                                                                                           | the next `@orkestrel/contract` release           | contract, then middleware  |
| Two compression engines in one server-only package                                                                                                                                                                                                                                                                                                               | M4                                               | middleware                 |
| Host-independent helpers that a `node:` module answers, such as `equalsConstantTime` against `timingSafeEqual`                                                                                                                                                                                                                                                   | a census after M0a                               | middleware                 |
| Scaffold verbs cannot remove an environment from a workspace: `repair` keeps the removed environment's entries and configs                                                                                                                                                                                                                                       | M0a, 2026-11-16                                  | scaffold ROADMAP           |
| An online `scaffold repair` moves development ranges without the lockfile, so a clean install refuses the manifest; run `repair --offline` inside a unit                                                                                                                                                                                                         | M0a, 2026-11-16                                  | scaffold ROADMAP           |
| Stale `src/core` text in middleware's scaffold-owned copies after the collapse                                                                                                                                                                                                                                                                                   | the scaffold release that carries the item above | scaffold                   |
| The core lint pattern matches only `@orkestrel/<package>/server`, and `application.md` reads "a package's bare export is its core API"                                                                                                                                                                                                                           | the scaffold visit                               | scaffold ROADMAP           |
| Scaffold ROADMAP 182 (derive `APP_SERVER_DEV_DEPENDENCIES` from the catalog), 43 (strike met clauses), 155 (the CORS rename)                                                                                                                                                                                                                                     | the scaffold visit                               | scaffold                   |
| `HTTPError` without `code`; the `is*`, `parse*`, and `resolve*` name forms; pass-through factories; `ServerBinding` in the barrel; a frozen `state`; malformed JSON read as empty; invalid `q` values; `StreamOptions.signal`; CORS credentials and `max-age`; Fetch Metadata; `If-Modified-Since`; session write concurrency; the two LRU stores; a route index | a consumer need                                  | the owning package         |

## State

- 2026-11-16: the evidence round and the design consultation closed, and § Rulings records them. M0a landed on middleware's working branch. R1's and R2's reviews failed (§ Sequence item 1), and fix rounds R1b and R2b are running. S4c (server `2f7244d`) is under its confirming review. S2a and M5 are running.
- Next: rule each confirming review, and merge each passing unit into its repository's working branch through the gate chain.
