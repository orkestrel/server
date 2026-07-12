import type { AddressInfo } from 'node:net'
import http from 'node:http'
import { fileURLToPath, URL } from 'node:url'

// ── Server-only setup (AGENTS §16.1 / §17.6) ─────────────────────────────────
//
// Loaded after `setup.ts` for the `src:server` test project. Holds `node:*`
// helpers for the server face's real-socket tests (§8/§16: no mocks — a real
// `node:http` server on an ephemeral port, closed by every caller).

/** The workspace root, anchored from this setup file's own location. */
export const WORKSPACE_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** A running test server bound to an ephemeral port, with its base `url` and a `close` teardown. */
export interface TestServerInterface {
	readonly url: string
	readonly port: number
	close(): Promise<void>
}

/**
 * Determine whether a `net.Server#address()` result is the `AddressInfo`
 * shape (rather than a pipe-name `string` or `null`) — the total narrow
 * {@link startServer} uses to read the bound ephemeral port.
 *
 * @param value - The raw `server.address()` return value
 * @returns `true` when `value` is a non-null `AddressInfo` object
 *
 * @example
 * ```ts
 * import { isAddressInfo } from '../setupServer.js'
 *
 * isAddressInfo({ address: '127.0.0.1', family: 'IPv4', port: 4000 }) // true
 * isAddressInfo(null) // false
 * ```
 */
export function isAddressInfo(value: string | AddressInfo | null): value is AddressInfo {
	return typeof value === 'object' && value !== null
}

/**
 * Start a real `node:http` server on an ephemeral port for a test.
 *
 * @remarks
 * Binds `listener` to `127.0.0.1:0` (OS-assigned free port) and resolves
 * once listening, with `url`/`port` derived from the bound address and a
 * `close()` that tears the server down. Every caller MUST call `close()`
 * (typically in the test itself or an `afterEach`) to avoid leaking sockets
 * across tests.
 *
 * @param listener - The `node:http` request listener to serve
 * @returns A {@link TestServerInterface} bound and ready to receive requests
 *
 * @example
 * ```ts
 * import { startServer } from '../setupServer.js'
 *
 * const server = await startServer((_request, response) => response.end('ok'))
 * const response = await fetch(server.url)
 * await server.close()
 * ```
 */
export function startServer(listener: http.RequestListener): Promise<TestServerInterface> {
	return new Promise((resolve, reject) => {
		const server = http.createServer(listener)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			if (!isAddressInfo(address)) {
				reject(new Error('test server failed to bind to an ephemeral port'))
				return
			}
			const port = address.port
			resolve({
				url: `http://127.0.0.1:${port}`,
				port,
				close: () =>
					new Promise<void>((res) => {
						server.close(() => res())
					}),
			})
		})
	})
}
