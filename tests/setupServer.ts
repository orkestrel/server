import { once } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { resolveRoot } from '@orkestrel/test'

// ── Server-only setup ────────────────────────────────────────────────────────
//
// Loaded after `setup.ts` for the `src:server` test project. Holds `node:*`
// helpers for the server face's real-socket tests (no mocks — a real
// `node:http` server on an ephemeral port, closed by every caller).

/** The workspace root, anchored from this setup file's own location. */
export const WORKSPACE_ROOT = fileURLToPath(resolveRoot(import.meta))

/** The outcome of a raw `upgradeRequest` probe: whether a handler claimed the socket. */
export interface UpgradeOutcomeInterface {
	readonly claimed: boolean
	readonly status: number
}

/**
 * Send a raw, hand-written HTTP request over a bare `node:net` socket and
 * resolve with whatever bytes come back — the real-socket probe for
 * malformed-request vectors (a bad `Host` header) that `fetch` would refuse
 * to send (no mocks, a genuinely raw wire payload).
 *
 * @param port - The target server's bound port (assumed `127.0.0.1`)
 * @param raw - The complete raw HTTP request text (including the trailing
 *   `\r\n\r\n`)
 * @returns The raw response bytes received, decoded as UTF-8
 *
 * @example
 * ```ts
 * import { rawRequest } from '../setupServer.js'
 *
 * const response = await rawRequest(port, 'GET / HTTP/1.1\r\nHost: foo bar\r\n\r\n')
 * ```
 */
export function rawRequest(port: number, raw: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
			socket.write(raw)
		})
		let data = ''
		socket.on('data', (chunk: Buffer) => {
			data += chunk.toString('utf8')
			socket.end()
		})
		socket.on('close', () => resolve(data))
		socket.on('error', reject)
	})
}

/** A real HTTP response socket whose readable side starts paused. */
export interface PausedResponseInterface {
	/** Resolves when the peer closes the response connection. */
	readonly closed: Promise<void>
	/** Raw response bytes delivered to userland after the socket is resumed. */
	readonly bytes: number
	/** Resume reading response bytes from the TCP socket. */
	resume(): void
	/** Tear down the socket, including while it is still paused. */
	destroy(): void
}

/**
 * Open a real HTTP request over TCP while parking the response reader.
 *
 * @remarks
 * Connects to `127.0.0.1`, pauses the socket's readable side before sending
 * the request, and asks the server to close the connection after the response.
 * This creates a protocol-faithful slow consumer without replacing either the
 * project server or Node's socket behavior. Call `resume()` to release the
 * receive pressure and `destroy()` during cleanup.
 *
 * @param port - The target server's bound port
 * @param path - The request path, defaulting to `/`
 * @returns The paused response handle
 */
export async function openPausedResponse(
	port: number,
	path = '/',
): Promise<PausedResponseInterface> {
	const socket = net.createConnection({ port, host: '127.0.0.1' })
	const closed = Promise.withResolvers<void>()
	let bytes = 0
	socket.on('data', (chunk: Buffer) => {
		bytes += chunk.byteLength
	})
	socket.once('close', () => closed.resolve())
	socket.once('error', (error) => closed.reject(error))
	await once(socket, 'connect')
	socket.pause()
	socket.write(
		`GET ${path} HTTP/1.1\r\nHost: localhost\r\nAccept: text/event-stream\r\nConnection: close\r\n\r\n`,
	)
	return {
		closed: closed.promise,
		get bytes(): number {
			return bytes
		},
		resume(): void {
			socket.resume()
		},
		destroy(): void {
			socket.destroy()
		},
	}
}

/**
 * Probe whether a real TCP connection is dropped before it can carry data.
 *
 * @remarks
 * Connects to `127.0.0.1:port` and observes the socket directly. A close or
 * connection error before `ms` is a drop; a connection that remains open
 * through the observation window is not. The socket is always destroyed
 * before resolution.
 *
 * @param port - The target server's bound port
 * @param ms - Maximum observation window in milliseconds
 * @returns Whether the server dropped the connection within the window
 */
export async function probeConnectionDrop(port: number, ms = 500): Promise<boolean> {
	const socket = net.createConnection({ port, host: '127.0.0.1' })
	const signal = AbortSignal.timeout(ms)
	try {
		await once(socket, 'connect', { signal })
		await once(socket, 'close', { signal })
		return true
	} catch {
		return socket.destroyed && !signal.aborted
	} finally {
		socket.destroy()
	}
}

/**
 * Checks whether this host can bind a loopback address family.
 *
 * @param host - The loopback literal to attempt, such as `127.0.0.1` or `::1`.
 * @returns True if a listener bound the address; false otherwise.
 *
 * @remarks
 * A host built without IPv6 rejects `::1` with `EAFNOSUPPORT` at `listen`, so a proof whose
 * subject is an address family asks the host rather than the platform name. The listener takes an
 * ephemeral port and closes before the answer returns.
 *
 * @example
 * ```ts
 * import { probeLoopback } from './setupServer.js'
 *
 * await probeLoopback('127.0.0.1') // true on every host this suite runs on
 * ```
 */
export async function probeLoopback(host: string): Promise<boolean> {
	const server = net.createServer()
	try {
		server.listen(0, host)
		await once(server, 'listening')
		return true
	} catch {
		return false
	} finally {
		server.close()
	}
}

/** A client-side upgraded connection deliberately left open — see {@link holdUpgrade}. */
export interface HeldUpgradeInterface {
	/** Resolves when the connection closes, from either end. */
	readonly closed: Promise<void>
	/** Whether the client socket is already gone. */
	readonly done: boolean
	/** Close the client end. */
	release(): void
}

/**
 * Complete a real protocol upgrade and KEEP the socket open — the long-lived
 * connection a WebSocket peer holds, for the tests that ask what `stop()` does
 * while one is attached.
 *
 * @remarks
 * The sibling of {@link upgradeRequest}, which ends the socket the moment the
 * `101` lands and so can never hold the server's stop path open. Real client
 * sockets throughout (no mocks); `closed` resolves when the server cuts
 * the connection, which is how a test proves the force-close reached the peer
 * rather than only the server's own bookkeeping.
 *
 * @param port - The target server's bound port (assumed `127.0.0.1`)
 * @param path - The request path to upgrade, defaulting to `/`
 * @returns The held-connection handle
 *
 * @example
 * ```ts
 * import { holdUpgrade } from '../../setupServer.js'
 *
 * const held = await holdUpgrade(port, '/ws')
 * await server.stop()
 * await held.closed // the stop cut it
 * ```
 */
export async function holdUpgrade(port: number, path = '/'): Promise<HeldUpgradeInterface> {
	const socket = net.createConnection({ port, host: '127.0.0.1' })
	const closed = Promise.withResolvers<void>()
	socket.once('close', () => closed.resolve())
	socket.once('error', () => closed.resolve())
	await once(socket, 'connect')
	socket.write(
		`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: aGVsZA==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
	)
	// Return only once the handshake reply is in, so the server has genuinely
	// upgraded (and tracked) the connection before the caller acts on it.
	await once(socket, 'data')
	return {
		closed: closed.promise,
		get done(): boolean {
			return socket.destroyed
		},
		release(): void {
			socket.destroy()
		},
	}
}

/**
 * Drives a raw `node:http` protocol-upgrade request against a running server —
 * the real-socket probe the server face's upgrade-seam tests use (no
 * mocks). Resolves after the outcome is known: a `101` upgrade response means a
 * registered handler CLAIMED the socket, and an ordinary HTTP response or a
 * connection error from a destroyed socket means none did.
 *
 * @param base - The server's base URL (`http://127.0.0.1:PORT`)
 * @param path - The request path to upgrade
 * @param headers - Extra request headers merged with the upgrade handshake headers
 * @returns An {@link UpgradeOutcomeInterface}
 *
 * @remarks
 * Kept local rather than replaced by `requestUpgrade` from `@orkestrel/test/server`,
 * on measurements taken against this server's own upgrade seam. This face
 * declines an upgrade by destroying the un-upgraded socket, which the shipped
 * helper reads as a transport failure: driven at a port whose sole handler
 * returns `false`, and at a port with no handler registered, it rejects with
 * `Error: socket hang up` where the suites here assert `claimed: false`. Its
 * result is a discriminated union whose claimed arm carries `protocol` and no
 * `status`, so the `101` this file reports is unavailable there. It also offers
 * no way to send `Sec-WebSocket-Key`, which the claimed-path test supplies —
 * `protocols` is the only header input it accepts.
 *
 * @example
 * ```ts
 * import { upgradeRequest } from '../setupServer.js'
 *
 * const outcome = await upgradeRequest(handle.url, '/ws')
 * ```
 */
export function upgradeRequest(
	base: string,
	path = '/',
	headers: Record<string, string> = {},
): Promise<UpgradeOutcomeInterface> {
	return new Promise((resolve) => {
		const request = http.request(base + path, {
			headers: { Connection: 'Upgrade', Upgrade: 'websocket', ...headers },
		})
		request.on('upgrade', (response, socket) => {
			socket.end()
			resolve({ claimed: true, status: response.statusCode ?? 0 })
		})
		request.on('response', (response) => {
			response.resume()
			resolve({ claimed: false, status: response.statusCode ?? 0 })
		})
		request.on('error', () => {
			resolve({ claimed: false, status: 0 })
		})
		request.end()
	})
}
