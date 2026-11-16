import type { SignerInterface } from '@src/server'
import { createHmac, KeyObject } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeBase64URL, encodeBase64URL } from '@orkestrel/codec'
import { attempt } from '@orkestrel/contract'
import { createHostileValues } from '@orkestrel/test'
import {
	createSigner,
	isServerError,
	readSignedCookie,
	Signer,
	signToken,
	verifyToken,
	writeSignedCookie,
} from '@src/server'
import {
	buildMalformedSignatures,
	recordSignerCrypto,
	SIGNER_HEADER_LIMIT,
	SIGNER_REFUSED_SECRETS,
	SIGNER_SECRETS,
	SIGNER_UNLISTED_SECRET,
} from '../../setupServer.js'

// Mirror of `src/server/Signer.ts`. The signer's answers are checked against `createHmac` over the
// raw secret, a second mechanism that holds no key, and its key work is read through a recorder
// over the `node:crypto` exports it calls.

const MESSAGE = encodeBase64URL(new TextEncoder().encode('{"value":"session-7f3a"}'))

describe('Signer — construction', () => {
	it.each(SIGNER_REFUSED_SECRETS)(
		'refuses $label with code SECRET and no secret text',
		({ secret }) => {
			const outcome = attempt(() => Reflect.apply(createSigner, undefined, [secret]))
			const error = outcome.success ? undefined : outcome.error
			expect(isServerError(error) ? error.code : error).toBe('SECRET')
			const text = isServerError(error) ? `${error.message} ${JSON.stringify(error.context)}` : ''
			expect(SIGNER_SECRETS.filter((entry) => text.includes(entry))).toEqual([])
		},
	)

	it('refuses every hostile value with code SECRET', () => {
		for (const [index, value] of createHostileValues().entries()) {
			const outcome = attempt(() => Reflect.apply(createSigner, undefined, [value]))
			const error = outcome.success ? undefined : outcome.error
			expect(isServerError(error) ? error.code : error, `hostile value ${index}`).toBe('SECRET')
		}
	})

	it('creates one key per secret, at construction', async () => {
		const { calls } = await recordSignerCrypto('createSecretKey', async () =>
			createSigner(SIGNER_SECRETS),
		)
		expect(calls).toHaveLength(SIGNER_SECRETS.length)
	})

	it('creates no key across any later call', async () => {
		const signer = createSigner(SIGNER_SECRETS)
		const oldest = createSigner(SIGNER_SECRETS.slice(-1))
		const unlisted = createSigner(SIGNER_UNLISTED_SECRET)
		const values = ['session-1', 'session-2', 'session-3']
		const { value, calls } = await recordSignerCrypto('createSecretKey', async () =>
			Promise.all(
				values.map(async (entry) => {
					const headers = new Headers()
					await writeSignedCookie(headers, 'session', entry, signer)
					const cookie = (headers.get('set-cookie') ?? '').split(';')[0] ?? ''
					const request = new Request('http://localhost/', { headers: { cookie } })
					return [
						await signer.verify(entry, await signer.sign(entry)),
						await signer.verify(entry, await oldest.sign(entry)),
						await signer.verify(entry, await unlisted.sign(entry)),
						await signer.verify(entry, 'not-a-signature'),
						await verifyToken(await signToken(entry, { signer, ttl: 60_000 }), signer),
						await readSignedCookie(request, 'session', signer),
					]
				}),
			),
		)
		expect(value).toEqual(values.map((entry) => [true, true, false, false, entry, entry]))
		expect(calls).toEqual([])
	})

	it('hands createHmac the held key object, never raw secret bytes', async () => {
		const signer = createSigner(SIGNER_SECRETS)
		const { calls } = await recordSignerCrypto('createHmac', async () => [
			await signer.verify(MESSAGE, await signer.sign(MESSAGE)),
			await signer.verify(MESSAGE, encodeBase64URL(new Uint8Array(32))),
		])
		expect(calls.length).toBeGreaterThan(0)
		expect(calls.filter(([, key]) => !(key instanceof KeyObject))).toEqual([])
	})
})

describe('Signer — sign', () => {
	it('signs with the first key: the HMAC-SHA256 of the message under the current secret', async () => {
		const expected = createHmac('sha256', SIGNER_SECRETS[0] ?? '')
			.update(MESSAGE)
			.digest('base64url')
		await expect(createSigner(SIGNER_SECRETS).sign(MESSAGE)).resolves.toBe(expected)
	})

	it('signs the UTF-8 bytes of the message, a lone surrogate as U+FFFD', async () => {
		const signer = createSigner('current-signing-secret-2026-11')
		const expected = createHmac('sha256', 'current-signing-secret-2026-11')
			.update(Buffer.from(`café ${String.fromCharCode(0xfffd)}`, 'utf8'))
			.digest('base64url')
		await expect(signer.sign('café \ud800')).resolves.toBe(expected)
	})

	it('emits a canonical base64url signature of 32 bytes', async () => {
		const signature = await createSigner(SIGNER_SECRETS).sign('')
		expect(decodeBase64URL(signature)?.byteLength).toBe(32)
	})
})

describe('Signer — rotation', () => {
	it('verifies a signature from any listed key and refuses an unlisted key', async () => {
		const signer = createSigner(SIGNER_SECRETS)
		for (const secret of SIGNER_SECRETS)
			await expect(signer.verify(MESSAGE, await createSigner(secret).sign(MESSAGE))).resolves.toBe(
				true,
			)
		const unlisted = await createSigner(SIGNER_UNLISTED_SECRET).sign(MESSAGE)
		await expect(signer.verify(MESSAGE, unlisted)).resolves.toBe(false)
	})

	it('signs with the current key, which an older-only signer refuses', async () => {
		const signature = await createSigner(SIGNER_SECRETS).sign(MESSAGE)
		await expect(createSigner(SIGNER_SECRETS.slice(0, 1)).verify(MESSAGE, signature)).resolves.toBe(
			true,
		)
		await expect(createSigner(SIGNER_SECRETS.slice(1)).verify(MESSAGE, signature)).resolves.toBe(
			false,
		)
	})

	it('refuses a valid signature over another message', async () => {
		const signer = createSigner(SIGNER_SECRETS)
		await expect(signer.verify(`${MESSAGE}x`, await signer.sign(MESSAGE))).resolves.toBe(false)
	})

	it('reads every key for a wrong signature, and stops at the first match', async () => {
		const signer = createSigner(SIGNER_SECRETS)
		const unlisted = await createSigner(SIGNER_UNLISTED_SECRET).sign(MESSAGE)
		const current = await createSigner(SIGNER_SECRETS[0] ?? '').sign(MESSAGE)
		const wrong = await recordSignerCrypto('createHmac', async () =>
			signer.verify(MESSAGE, unlisted),
		)
		const first = await recordSignerCrypto('createHmac', async () =>
			signer.verify(MESSAGE, current),
		)
		expect([wrong.value, wrong.calls.length]).toEqual([false, SIGNER_SECRETS.length])
		expect([first.value, first.calls.length]).toEqual([true, 1])
	})
})

describe('Signer — malformed signatures', () => {
	it.each(buildMalformedSignatures(createHmac('sha256', 'x').update('y').digest('base64url')))(
		'answers false for $label before reading a key',
		async ({ signature }) => {
			const signer: SignerInterface = createSigner(SIGNER_SECRETS)
			const { value, calls } = await recordSignerCrypto('createHmac', async () =>
				signer.verify(MESSAGE, signature),
			)
			expect([value, calls.length]).toEqual([false, 0])
		},
	)

	it('answers false for a header-limit message without rejecting', async () => {
		const signer = createSigner(SIGNER_SECRETS)
		const message = 'A'.repeat(SIGNER_HEADER_LIMIT)
		await expect(signer.verify(message, await signer.sign(`${message}x`))).resolves.toBe(false)
		await expect(signer.verify(message, await signer.sign(message))).resolves.toBe(true)
	})

	it('answers lone surrogates in the message without rejecting', async () => {
		const signer = createSigner(SIGNER_SECRETS)
		const signature = await signer.sign('\ud800')
		await expect(signer.verify('\udc00', signature)).resolves.toBe(true)
		await expect(signer.verify('𐀀', signature)).resolves.toBe(false)
	})
})

describe('Signer — instance', () => {
	it('is the class createSigner returns', () => {
		expect(createSigner('current-signing-secret-2026-11')).toBeInstanceOf(Signer)
	})
})
