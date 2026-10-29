import type { Server as NodeHTTPServer } from 'node:http'
import { once } from 'node:events'
import { isAddressInfo } from './validators.js'

/**
 * Owns one startup attempt's listening subscription and validated bound port.
 *
 * @remarks
 * Create an instance per bind attempt. Subscribe before calling the native server's
 * `listen`, retain `pending` for failure cleanup, and record the native address after
 * listening settles. Reading `port` before a valid address was recorded throws.
 */
export class ServerBinding {
	#pending: Promise<readonly unknown[]> | undefined
	#port: number | undefined

	get pending(): Promise<readonly unknown[]> | undefined {
		return this.#pending
	}

	get port(): number {
		if (this.#port === undefined) {
			throw new TypeError('server bound a listener with no resolvable AddressInfo')
		}
		return this.#port
	}

	subscribe(server: NodeHTTPServer, signal: AbortSignal): Promise<readonly unknown[]> {
		const pending = once(server, 'listening', { signal })
		this.#pending = pending
		return pending
	}

	record(address: unknown): void {
		if (!isAddressInfo(address)) {
			throw new TypeError('server bound a listener with no resolvable AddressInfo')
		}
		this.#port = address.port
	}
}
