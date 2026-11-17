# Campaign: router, server, and middleware quality and performance

## Goal

Harden `@orkestrel/router`, `@orkestrel/server`, and `@orkestrel/middleware` to a total, measured contract on untrusted HTTP input, and close the four causes in § Rulings at their source: one `Request` per exchange, a pull-based body, one reading of each path, and a server-only middleware.

## Exit criterion

- Every unit in § Sequence is landed, reviewed under the stop rule, and merged.
- Each oracle in § Oracles landed red before its patches and holds green, and each one has its mutation controls.
- A scaffold-generated server application composes the three candidates through `swap.ts` pins and drives a login flow.
- Router 0.0.23, server 0.0.29, and middleware 0.0.35 are released in that layer order, then the mcp, browser, toolbox, and scaffold visits close.

## Repositories

| Repository                                                                        | URL                                                                      |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `@orkestrel/router`                                                               | https://github.com/orkestrel/router                                      |
| `@orkestrel/server`                                                               | https://github.com/orkestrel/server                                      |
| `@orkestrel/middleware`                                                           | https://github.com/orkestrel/middleware                                  |
| `@orkestrel/mcp`, `@orkestrel/browser`, `@orkestrel/toolbox`                      | visits after the releases                                                |
| `@orkestrel/scaffold`                                                             | ROADMAP items in § Deferred                                              |
| `@orkestrel/abort`                                                                | https://github.com/orkestrel/abort                                       |
| `@orkestrel/contract`                                                             | https://github.com/orkestrel/contract                                    |
| `@orkestrel/queue`, `@orkestrel/workflow`, `@orkestrel/agent`, `@orkestrel/study` | abort's other runtime dependents, re-released in layer order after abort |

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
| Error rendering                                | server `src/server` | One total renderer turns a throw into a `Response`. `Server` and middleware's `createBoundary` both call it, and both report only a non-`HTTPError`, with `(error, RequestLine)`; a fault on the inner phase's `400` path reports `(error)` with no `RequestLine`, because no `Request` exists there.                                                                                                                                                                                                                                                                                              |
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
- **Sessions:** a session is stored only after a handler writes to it or regenerates it. Eviction at capacity is constant-time and keeps no heap per read.
- **Admission:** every factory admits its option bag whole, and a refusal is a `ContractError` with its path.

### Caching, ranges, and forms

- **`If-Range`:** any `If-Range` serves the full `200`.
- **Multipart:** a boundary over 70 characters answers `400` (RFC 2046 § 5.1.1).
- **Coded validators:** behind compression, a strong tag on a coded `200` becomes `W/` (RFC 9110 § 8.8.1).
- **`304`:** the `304` that `createETag` answers carries `Content-Length` and `Vary: Accept-Encoding`, the headers of the `200` it stands for.

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
3. **The composed-stack matrix** (middleware `tests/src/server/integration.test.ts`, a real `Server`, a real dispatcher, and a proxy fixture). Its declared invariants hold in every order the guide permits, the guide's own fence order included:
   - no 5xx unless the handler threw a non-`HTTPError`, except a status a battery declares as its answer, such as the deadline's `503`;
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
2. **Server:** S2a, the exchange seam, pinned to R2's tarball; then S2b, the boundary and outcomes, which also interleaves the small and large batches of `measureServerGrowth` in `tests/setupServer.ts` so a burst of contention cannot skew a cost row; S3, timeouts and the server matrix; S5, measured throughput; S6, the signer.
3. **Middleware:** M0a, the one-entry collapse (middleware `13622f4`, `7521cb2`); then, after server's tarball, M0b, adopt the seam; M1, the composed oracle; M5, admission; M2, identity and scoping; M3, CSRF and sessions after S6; M4, the response batteries; M6, multipart and static.
4. The regular-expression census (2026-11-16) found one superlinear pattern outside server: middleware's `isReservedDeviceName` (`src/server/helpers.ts`, `/[. ]+$/`), reached by every `createStatic` GET, about 317 ms for a run of 16,000 dots. M6 replaces it with `/(?<![. ])[. ]+$/`, which agreed with the original on all 299,593 strings up to length 6 over space, dot, tab, U+00A0, U+3000, `a`, `¹`, and an astral character. The fix strips only U+002E and U+0020, strips a mixed trailing run whole, and trims a dots-and-spaces segment to empty. Router has none.
5. **Upstream fixes** (user ruling, 2026-11-16): a gap a consumer meets in an `@orkestrel` package is fixed in that package, not worked around in the consumer.
   - **abort:** `linkSignal` and `createAbort({ signal })` compose through `AbortSignal.any`, which on Node 22.18.0 and 22.23.5 retains 105–176 B per child while the source lives. Node 24.16.0 and Chromium keep none. The design consultation (2026-11-16) ruled:
     - one weak fan-out per source signal (`Cascade`): a `Set` of `WeakRef` controllers, one source listener, and a `FinalizationRegistry`, on every host with no version read;
     - `linkSignal` moves to `factories.ts` as `createLinkedSignal`;
     - no explicit release;
     - three pinned order properties.

     Unit A3 builds it against a per-host bar, then a review and abort 0.0.19. Router keeps `createAbort({ signal })`, and mcp, browser, and scaffold adopt at their visits, each needing the user's authorization to declare `@orkestrel/abort`.

   - **contract:** the needs list (2026-11-16) holds 20 rows. The most-shared are:
     - `preview` costs about 0.3 ms for a string longer than 62 UTF-16 units, which every refusal pays (11 packages);
     - no guard for a host error with a string `code` (8);
     - no optional that admits an explicit `undefined` (7);
     - no safe-integer guard (6);
     - no coded refusal for one argument against one guard (5);
     - a misspelled builder option fails open (5);
     - no once-read admission that keeps functions and instances (4);
     - no shape that admits a foreign implementation by its members (3);
     - no constraint across members (3);
     - a synchronous-only `attempt` (3).

     The user reopened contract `ROADMAP.md` items 3 and 4: every builder refuses an option key it does not read, and contract adds an admission that reads each member of a caller's bag once, keeps functions and instances by identity, and reports every fault in one refusal. The design consultation (2026-11-16) ruled the release:
     - **Build:**
       - `interfaceShape`, which admits an implementation by its declared members;
       - `undefinedShape`;
       - `over` and `under` exclusive bounds;
       - `settle`, the asynchronous `attempt`;
       - `isCodedError` and `isSafeInteger`;
       - `faults` on `ContractErrorContext`, with `refusalToError`;
       - `refuseValue`;
       - `contract.own`, which reads a caller's value once into a snapshot, holds implementations and functions by identity, and then admits the snapshot as `admitValue` does;
       - a linear `preview`;
       - builders and the four option functions that refuse an unread key;
       - the `isRecord` remark and a prose sweep.
     - **Refuse:** a predicate node and a stricter `rawShape`.
     - **Defer:** `parseEnum` memoization, prototype-key dropping in JSON reads, a time-zone shape, and construction-cost tuning, each with its trigger.
     - **Unchanged:** `admitValue`, `optionalShape`, `integerShape`, and `isInteger` keep their answers. A class-instance options bag refuses at an `objectShape` position.
     - **Units:** C-T (types) opens; lane H (C-H1 `preview`, C-H2 helpers) and lane D (C-D1 option refusal and bounds, C-D2 `undefined`, C-D3 interface, C-D4 `own`) follow; then C-X, a seeded differential against 0.0.24; then C-G1 (guide) and C-G2 (prose); then C-A, abort's adoption proof.
     - **The consumer census over 13 source trees:** no hand-built `ContractInterface` and no builder options passed as a non-literal. Database's `switch (shape.category)` at `src/core/helpers.ts:1326` stops compiling until its cascade visit adds the two categories.

   - Any other `@orkestrel` package a unit finds lacking joins this item.
6. **Release order and the execution lane** (user rulings, 2026-11-16):
   - Publishing comes as soon as quality and performance allow.
   - The HTTP wave releases on contract 0.0.24 in layer order: abort 0.0.19, router 0.0.23, server 0.0.29, then middleware 0.0.35.
   - Contract 0.0.25 is its own cascade wave after it.
   - Scaffold unit L1 gives the lane script light lanes on Linux, sampling process trees through `/proc`, so builds and tests share the host while `--solo` timing runs stay alone. It is rolled out after its review, once the queue allows.
7. The mcp, browser, toolbox, and scaffold visits; the integrated `orkestrel-falsify` round; a tree-wide `verifier` run; the consumer run; the releases in layer order.

## Deferred

| Item                                                                                                                                                                                                                                                                                                                                                             | Trigger                                          | Owner              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------ |
| Middleware's M5 checks each foreign implementation key with the `objectOf` combinator after `admitValue`; fold those keys into the compiled shape                                                                                                                                                                                                                | the contract release in § Sequence item 5        | middleware         |
| Two compression engines in one server-only package                                                                                                                                                                                                                                                                                                               | M4                                               | middleware         |
| Host-independent helpers that a `node:` module answers, such as `equalsConstantTime` against `timingSafeEqual`                                                                                                                                                                                                                                                   | a census after M0a                               | middleware         |
| Scaffold verbs cannot remove an environment from a workspace: `repair` keeps the removed environment's entries and configs                                                                                                                                                                                                                                       | M0a, 2026-11-16                                  | scaffold ROADMAP   |
| An online `scaffold repair` moves development ranges without the lockfile, so a clean install refuses the manifest; run `repair --offline` inside a unit                                                                                                                                                                                                         | M0a, 2026-11-16                                  | scaffold ROADMAP   |
| Stale `src/core` text in middleware's scaffold-owned copies after the collapse                                                                                                                                                                                                                                                                                   | the scaffold release that carries the item above | scaffold           |
| The core lint pattern matches only `@orkestrel/<package>/server`, and `application.md` reads "a package's bare export is its core API"                                                                                                                                                                                                                           | the scaffold visit                               | scaffold ROADMAP   |
| Scaffold ROADMAP 182 (derive `APP_SERVER_DEV_DEPENDENCIES` from the catalog), 43 (strike met clauses), 155 (the CORS rename)                                                                                                                                                                                                                                     | the scaffold visit                               | scaffold           |
| `HTTPError` without `code`; the `is*`, `parse*`, and `resolve*` name forms; pass-through factories; `ServerBinding` in the barrel; a frozen `state`; malformed JSON read as empty; invalid `q` values; `StreamOptions.signal`; CORS credentials and `max-age`; Fetch Metadata; `If-Modified-Since`; session write concurrency; the two LRU stores; a route index | a consumer need                                  | the owning package |

## State

- 2026-11-16: the evidence round and the design consultation closed, and § Rulings records them. M0a landed on middleware's working branch. S4, the untrusted substrate, merged into server's working branch as `d9f8fc4` after its third review passed. R1's and R2's reviews failed (§ Sequence item 1), and fix rounds R1b and R2b are running. M5 (middleware `fc3f323`) is under review. S2a, the abort evidence, and the contract list are running.
- 2026-11-16, later: server's working branch carries S2a, S2b, S3, and S6, merged through unit SI on router's R2b build (`b245633`), each step through the full gate chain. S2b's report limit is stated by the species-constructor steps `then` runs. The `MaxListenersExceededWarning` (11 `close` listeners per `ServerResponse`) came from router's R2 writer (`af49292`), which R2b replaced; it reads 0 on the R2b pin. M0b passed. M1's review failed: the guide's fence order drops `Vary: Origin` and the security headers on a thrown error, so its canonical-order cells land red with closer M4, which owns the onion order. An `is*` guard returns false for a value missing a declared member, so `isSessionControl` checks every member of `SessionControlInterface` (M3). R1d, M1-b, M2's review, M3, S5, C-D4, and the lane unit L1c (Fable's freeze-to-fixpoint kill) are running.
- 2026-11-17: router's working branch carries R4 to R6 and passed its gate chain at `5a3b7ef`; R6's review is running. Server's S7 (the disconnect latch and the abortable body read) is under an independent pass on router's `5a3b7ef` build. Middleware's falsify round failed claim 4 (the session store's live iterator kept about 82 B per read); unit MS replaced it with a tick ledger, and middleware's working branch carries MS at `815c948`.
- Next: release router 0.0.23, then server 0.0.29 and middleware 0.0.35, each after its gate chain on the final packs.
