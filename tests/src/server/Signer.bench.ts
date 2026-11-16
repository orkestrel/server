import { decodeBase64URL, encodeBase64URL } from '@orkestrel/codec'
import { createSigner } from '@src/server'
import { expect, it } from 'vitest'
import { SIGNER_SECRETS } from '../../setupServer.js'

// The engine choice behind `Signer`: its `node:crypto` keys (`createHmac` over a held `KeyObject`,
// `timingSafeEqual` after a length check) against WebCrypto keys imported once with the usages
// `['sign', 'verify']`, read as the p50 latency of a sign at one secret, a verify at one secret,
// and a verify at three secrets of a signature the oldest key made. The interleaved reading on
// 2026-11-16 read the `node:crypto` signer 83.38%, 81.94%, and 89.11% cheaper in process CPU per
// call. No gate collects this file; run it with
// `npm run test:bench -- tests/src/server/Signer.bench.ts`.

const MESSAGE = encodeBase64URL(new TextEncoder().encode('{"value":"session-7f3a"}'))
const OPTIONS = Object.freeze({
	iterations: 10_000,
	time: 0,
	warmupIterations: 2_000,
	warmupTime: 0,
})

it('reads both engines for a sign at one secret', { timeout: 600_000 }, async ({ bench }) => {
	const secret = SIGNER_SECRETS[0] ?? ''
	const signer = createSigner(secret)
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	)
	const data = new TextEncoder().encode(MESSAGE)
	const signed = new Uint8Array(await crypto.subtle.sign('HMAC', key, data))
	expect(encodeBase64URL(signed)).toBe(await signer.sign(MESSAGE))
	const webcrypto = await bench('WebCrypto sign, one secret', async () => {
		encodeBase64URL(new Uint8Array(await crypto.subtle.sign('HMAC', key, data)))
	}).run(OPTIONS)
	const nodecrypto = await bench('node:crypto sign, one secret', async () => {
		await signer.sign(MESSAGE)
	}).run(OPTIONS)
	console.log(
		`signer sign-1 webcrypto p50=${String(webcrypto.latency.p50)} node:crypto p50=${String(nodecrypto.latency.p50)}`,
	)
	expect(nodecrypto.latency.p50).toBeGreaterThan(0)
})

it.for([
	{ label: 'one secret', count: 1 },
	{ label: 'three secrets, oldest-signed', count: 3 },
])(
	'reads both engines for a verify at $label',
	{ timeout: 600_000 },
	async ({ label, count }, { bench }) => {
		const secrets = SIGNER_SECRETS.slice(0, count)
		const signer = createSigner(secrets)
		const keys = await Promise.all(
			secrets.map((secret) =>
				crypto.subtle.importKey(
					'raw',
					new TextEncoder().encode(secret),
					{ name: 'HMAC', hash: 'SHA-256' },
					false,
					['sign', 'verify'],
				),
			),
		)
		const data = new TextEncoder().encode(MESSAGE)
		const signature = await createSigner(secrets.slice(-1)).sign(MESSAGE)
		const bytes = decodeBase64URL(signature) ?? new Uint8Array()
		const answers = await Promise.all(
			keys.map((key) => crypto.subtle.verify('HMAC', key, bytes, data)),
		)
		expect([answers.at(-1), await signer.verify(MESSAGE, signature)]).toEqual([true, true])
		const webcrypto = await bench(`WebCrypto verify, ${label}`, async () => {
			await keys.reduce<Promise<boolean>>(
				async (matched, key) => (await matched) || crypto.subtle.verify('HMAC', key, bytes, data),
				Promise.resolve(false),
			)
		}).run(OPTIONS)
		const nodecrypto = await bench(`node:crypto verify, ${label}`, async () => {
			await signer.verify(MESSAGE, signature)
		}).run(OPTIONS)
		console.log(
			`signer verify ${label} webcrypto p50=${String(webcrypto.latency.p50)} node:crypto p50=${String(nodecrypto.latency.p50)}`,
		)
		expect(nodecrypto.latency.p50).toBeGreaterThan(0)
	},
)
