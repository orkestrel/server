# @orkestrel/server

A typed HTTP server for the `@orkestrel` line — composes an `@orkestrel/router`
dispatcher behind a managed lifecycle (start/stop/drain/destroy) over a node
adapter seam, with a middleware onion, response observability, and a shared
substrate for cookies, tokens, content negotiation, and SSE. Built to sit
beside `@orkestrel/router` (routing, matching, and dispatch), `@orkestrel/contract`
(validation), `@orkestrel/emitter` (observable lifecycle), and `@orkestrel/abort`
(cancellation). Part of the `@orkestrel` line.

## Install

```sh
npm install @orkestrel/server
```

## Requirements

- Node.js >= 24
- ESM-only (no CommonJS build)

## Usage

```ts
import type { MiddlewareHandler } from '@orkestrel/server'
import { createServer } from '@orkestrel/server'
import { createDispatcher } from '@orkestrel/router'

interface State {
	readonly requestId: string
}

const dispatcher = createDispatcher<State>()
dispatcher.add({
	method: 'GET',
	path: '/users/:id',
	handler: (_request, context) =>
		Response.json({ id: context.params.id, requestId: context.state.requestId }),
})

const withRequestId: MiddlewareHandler<State> = async (_request, context, next) => {
	const response = await next()
	response.headers.set('X-Request-ID', context.state.requestId)
	return response
}

const server = createServer<State>({
	dispatcher,
	state: () => ({ requestId: crypto.randomUUID() }),
	middleware: [withRequestId],
})
const port = await server.start()
await server.stop()
```

A route handler reads `context.state` exactly as middleware wrote it — the
composed onion terminates in the dispatcher, so there is no second plumbing
layer between the middleware seam and the router. The package also exports
`HTTPError` and its subclasses, the `compose` middleware primitive,
cookie/token/body helpers, `Negotiator` for content negotiation, and
`openStream` for Server-Sent Events.

## Guide

For the full surface — the middleware seam, `HTTPError` vocabulary, shared
substrate (cookies, tokens, negotiation, ETag/Range, security headers, SSE,
body pipeline), and the `Server` lifecycle entity — see
[`guides/src/server.md`](guides/src/server.md).

## Package

Published as a single entry point per the `exports` field in `package.json`.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
