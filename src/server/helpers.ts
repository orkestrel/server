// ============================================================================
//  The node face — pure helpers (AGENTS §5). Every function here is genuinely
//  node-bound (a `node:net` probe, an `AddressInfo` narrow) — everything
//  fetch/string-pure lives in `@src/core` and is consumed, never duplicated
//  (the socket-encrypted narrow and the `Request`/`Response` conversion are
//  `@orkestrel/router`'s `isEncryptedSocket` / `buildRequest` / `sendResponse`).
// ============================================================================

import type { AddressInfo } from 'node:net'
import { createServer as createNetServer } from 'node:net'
import { isNumber, isRecord } from '@orkestrel/contract'

/**
 * Whether a `node:net` `server.address()` return is the structured
 * {@link AddressInfo} (carrying a numeric `port`) rather than a pipe `string`
 * or `null` — the total, never-throwing narrow (AGENTS §14) `discoverPort`
 * and the `Server`'s own port resolution read the bound port through.
 *
 * @param value - The `server.address()` return (`AddressInfo | string | null`)
 * @returns `true` when `value` is an `AddressInfo` with a numeric `port`
 *
 * @example
 * ```ts
 * import { isAddressInfo } from '@src/server'
 *
 * isAddressInfo({ address: '127.0.0.1', family: 'IPv4', port: 4000 }) // true
 * isAddressInfo(null) // false
 * ```
 */
export function isAddressInfo(value: unknown): value is AddressInfo {
	return isRecord(value) && isNumber(value.port)
}

/**
 * Find a FREE TCP port — bind a throwaway `node:net` server, read the
 * OS-assigned port, close it, and resolve that port.
 *
 * @remarks
 * With no `preferred` it binds port `0` (an ephemeral OS-assigned free port)
 * and returns it. With a `preferred` port it tries THAT port first and
 * returns it when free; if already in use (`EADDRINUSE`) it FALLS BACK to an
 * ephemeral free port rather than rejecting — a caller always gets a usable
 * port. It binds then immediately closes a probe server, so the returned
 * port is free at the instant of the probe (an inherent TOCTOU race — bind it
 * promptly). Rejects only on an unexpected listen error other than a taken
 * `preferred` port (e.g. a permission fault).
 *
 * @param preferred - An optional port to try first; taken (`EADDRINUSE`) ⇒
 *   fall back to an ephemeral port
 * @returns A free TCP port number
 *
 * @example
 * ```ts
 * import { createServer, discoverPort } from '@src/server'
 *
 * const port = await discoverPort() // a guaranteed-free ephemeral port
 * ```
 */
export function discoverPort(preferred?: number): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const bind = (port: number, fallback: boolean): void => {
			const probe = createNetServer()
			const onError = (error: Error): void => {
				probe.close()
				const taken = 'code' in error && error.code === 'EADDRINUSE'
				if (fallback && taken) bind(0, false)
				else reject(error)
			}
			probe.once('error', onError)
			probe.listen(port, () => {
				const address = probe.address()
				const resolved = isAddressInfo(address) ? address.port : 0
				probe.close(() => resolve(resolved))
			})
		}
		bind(preferred ?? 0, preferred !== undefined)
	})
}
