import type { KeyObject } from 'node:crypto'
import type { SignerInterface, TokenSecret } from './types.js'
import { createHmac, createSecretKey, timingSafeEqual } from 'node:crypto'
import { decodeBase64URL, encodeBase64URL } from '@orkestrel/codec'
import { normalizeSecret } from './helpers.js'

/**
 * Represents an HMAC-SHA256 signer that creates one `node:crypto` key per secret at
 * construction and reuses it on every call. Implements exactly {@link SignerInterface}.
 *
 * @remarks
 * The constructor normalizes the secret through {@link normalizeSecret}, so it
 * throws a {@link ServerError} of code `'SECRET'` for a secret that is not a
 * string or a list of strings, an empty list, or a list holding a blank entry.
 * `verify` compares signature bytes only through `timingSafeEqual`, after a
 * length check.
 *
 * @example
 * ```ts
 * import { Signer } from '@orkestrel/server'
 *
 * const signer = new Signer(['current-secret', 'previous-secret'])
 * await signer.verify('payload', await signer.sign('payload')) // true
 * ```
 */
export class Signer implements SignerInterface {
	readonly #keys: readonly [KeyObject, ...KeyObject[]]

	constructor(secret: TokenSecret) {
		const [current, ...older] = normalizeSecret(secret)
		this.#keys = [
			createSecretKey(current, 'utf8'),
			...older.map((entry) => createSecretKey(entry, 'utf8')),
		]
	}

	async sign(message: string): Promise<string> {
		const [key] = this.#keys
		return encodeBase64URL(createHmac('sha256', key).update(message, 'utf8').digest())
	}

	async verify(message: string, signature: string): Promise<boolean> {
		const bytes = decodeBase64URL(signature)
		// 32 is the byte length of an HMAC-SHA256; `timingSafeEqual` throws on unequal lengths.
		if (bytes === undefined || bytes.byteLength !== 32) return false
		return this.#keys.some((key) =>
			timingSafeEqual(createHmac('sha256', key).update(message, 'utf8').digest(), bytes),
		)
	}
}
