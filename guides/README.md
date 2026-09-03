# Guides

A dual-axis index into this repository's guides — by concept, and by
directory.

## By concept

| Concept | Spec                     | Source                        | Tests                                     |
| ------- | ------------------------ | ----------------------------- | ----------------------------------------- |
| Server  | [`server.md`](server.md) | [`src/server`](../src/server) | [`tests/src/server`](../tests/src/server) |

## By directory

| Directory    | Guide                    |
| ------------ | ------------------------ |
| `src/server` | [`server.md`](server.md) |

## Dependency reference

[`contract.md`](contract.md) is a byte-identical mirror of the guide for
`@orkestrel/contract` — one of this package's runtime dependencies. It documents
**that package's** surface (guards, combinators, parsers, and the shape DSL), not
anything sourced in this repo; it is kept here so a reader of this package can see
the primitives it is built from without leaving this guide set.

[`emitter.md`](emitter.md) is a byte-identical mirror of the guide for
`@orkestrel/emitter` — one of this package's runtime dependencies. It documents
**that package's** surface (the `Emitter` class, `EmitterInterface`, and the
listener-isolation contract), not anything sourced in this repo; it is kept here
so a reader of this package can see the primitives it is built from without
leaving this guide set.

[`abort.md`](abort.md) is a byte-identical mirror of the guide for
`@orkestrel/abort` — one of this package's runtime dependencies. It documents
**that package's** surface (the `Abort` class, `AbortInterface`, and the
parent-linking / cascading-cancellation contract), not anything sourced in
this repo; it is kept here so a reader of this package can see the primitives
it is built from without leaving this guide set.

[`router.md`](router.md) is a byte-identical mirror of the guide for
`@orkestrel/router` — one of this package's runtime dependencies. It documents
**that package's** surface (the `Dispatcher`, route registration, and the
core/browser/server face split), not anything sourced in this repo; it is
kept here so a reader of this package can see the primitives it is built
from without leaving this guide set.

[`timeout.md`](timeout.md) is a byte-identical mirror of the guide for
`@orkestrel/timeout` — one of this package's runtime dependencies. It documents
**that package's** surface (the `Timeout` class, `TimeoutInterface`, and the
start/clear deadline lifecycle), not anything sourced in this repo; it is
kept here so a reader of this package can see the primitives it is built
from without leaving this guide set.

[`codec.md`](codec.md) is a byte-identical mirror of the guide for
`@orkestrel/codec` — one of this package's runtime dependencies. It documents
**that package's** surface (the byte-to-text codings — Base64, base64url, hex,
and the UTF-8, ISO-8859-1, Windows-1252, and UTF-16LE charsets — as
`encode*` / `decode*` / `is*` triples, beside the `measure*` size helpers), not
anything sourced in this repo; it is kept here so a reader of this package can
see the primitives it is built from without leaving this guide set.

[`guide.md`](guide.md) is a byte-identical mirror of the guide for
`@orkestrel/guide` — the devDependency powering this repo's guides-parity test
suite (`tests/guides.test.ts`). It documents **that package's**
surface (`Guide` / `Source`, the manifest and comparison helpers), not anything
sourced in this repo; it is kept here so a reader of the parity suite can see
the primitives it is built from without leaving this guide set.

The remaining mirrors cover the rest of this package's toolchain, on the same
terms — each documents that package's surface rather than anything sourced
here. [`probe.md`](probe.md) mirrors `@orkestrel/probe`, the claim prover that
runs a proposed edit and its negative control through resident TypeScript,
Oxlint, and Vitest engines. [`scaffold.md`](scaffold.md) mirrors
`@orkestrel/scaffold`, which compiles a workspace specification into an ordered
file list, compares it against a real directory, and writes the difference.
[`test.md`](test.md) mirrors `@orkestrel/test`, the shared test helpers for what
a test records, what it waits for, and what it owns.

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules, including the documentation contract this index satisfies.
