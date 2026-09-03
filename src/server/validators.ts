import type { AddressInfo } from 'node:net'
import { isNumber, isRecord, isString } from '@orkestrel/contract'

// The module's guards. A total `Guard<T>` narrows a type rather than answering
// a plain question, so it lives here rather than beside the boolean predicates
// `helpers.ts` keeps (`isCookieName`, `isCompressibleType`, `isValidRequestId`).
// This file sits at the bottom of the module's graph beside `helpers.ts`,
// imports the `node:net` address type and the `@orkestrel/contract` guards, and
// never an implementation class.

/**
 * Checks whether a `node:net` `server.address()` return is the structured
 * {@link AddressInfo} (carrying a numeric `port`) rather than a pipe `string`
 * or `null` — the total, never-throwing narrow `discoverPort`
 * and the `Server`'s own port resolution read the bound port through.
 *
 * @remarks
 * Checks the `address`, `family`, and `port` members `node:net` declares as
 * `string`, `string`, and `number`.
 *
 * @param value - The `server.address()` return (`AddressInfo | string | null`)
 * @returns True if `value` is an `AddressInfo`; false otherwise
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
	return (
		isRecord(value) && isString(value.address) && isString(value.family) && isNumber(value.port)
	)
}
