# Guides

A dual-axis index into this repository's guides — by concept, and by
directory (AGENTS §22).

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
`@orkestrel/emitter` — this package's other runtime dependency. It documents
**that package's** surface (the `Emitter` class, `EmitterInterface`, and the
listener-isolation contract), not anything sourced in this repo; it is kept here
so a reader of this package can see the primitives it is built from without
leaving this guide set.

[`abort.md`](abort.md) is a byte-identical mirror of the guide for
`@orkestrel/abort` — this package's third runtime dependency. It documents
**that package's** surface (the `Abort` class, `AbortInterface`, and the
parent-linking / cascading-cancellation contract), not anything sourced in
this repo; it is kept here so a reader of this package can see the primitives
it is built from without leaving this guide set.

[`router.md`](router.md) is a byte-identical mirror of the guide for
`@orkestrel/router` — this package's fourth runtime dependency. It documents
**that package's** surface (the `Dispatcher`, route registration, and the
core/browser/server face split), not anything sourced in this repo; it is
kept here so a reader of this package can see the primitives it is built
from without leaving this guide set.

[`guide.md`](guide.md) is a byte-identical mirror of the guide for
`@orkestrel/guide` — the devDependency powering this repo's guides-parity test
suite (`tests/guides.test.ts`). It documents **that package's**
surface (`Guide` / `Source`, the manifest and comparison helpers), not anything
sourced in this repo; it is kept here so a reader of the parity suite can see
the primitives it is built from without leaving this guide set.

[`timeout.md`](timeout.md) is a byte-identical mirror of the guide for
`@orkestrel/timeout` — this package's fifth runtime dependency. It documents
**that package's** surface (the `Timeout` class, `TimeoutInterface`, and the
start/clear deadline lifecycle), not anything sourced in this repo; it is
kept here so a reader of this package can see the primitives it is built
from without leaving this guide set.

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules; §22 documentation-as-contracts.
