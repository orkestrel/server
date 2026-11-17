import type * as ServerErrors from '../src/server/errors.js'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes, syncBuiltinESMExports } from 'node:module'
import type { Duplex } from 'node:stream'
import type { LoopbackInterface } from '@orkestrel/test/server'
import type { RecorderInterface } from '@orkestrel/test'
import type { RandomFunction } from '@orkestrel/contract'
import type { DispatcherInterface } from '@orkestrel/router'
import type {
	Connection,
	MiddlewareContext,
	MiddlewareHandler,
	NextFunction,
	RangeSpec,
	ServerInterface,
	SignerInterface,
	SSEMessage,
	TokenSecret,
} from '@src/server'
import type { IncomingMessage } from 'node:http'
import { encodeBase64URL } from '@orkestrel/codec'
import { isRecord, seededRandom } from '@orkestrel/contract'
import { createDispatcher } from '@orkestrel/router'
import { buildRequest, sendResponse } from '@orkestrel/router/server'
import crypto from 'node:crypto'
import diagnostics from 'node:diagnostics_channel'
import http from 'node:http'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { queryObjects } from 'node:v8'
import {
	createRecorder,
	resolveRoot,
	waitForAbort,
	waitForCondition,
	waitForDelay,
	waitForEvent,
} from '@orkestrel/test'
import { HTTPError } from '@src/server'

/** Holds the mutable observation owned by one test invocation. */
export class ServerObservation<T> {
	#value: T

	constructor(value: T) {
		this.#value = value
	}

	get value(): T {
		return this.#value
	}

	set value(value: T) {
		this.#value = value
	}
}

// ── Server-only setup ────────────────────────────────────────────────────────
//
// Loaded after `setup.ts` for the `src:server` test project. Holds `node:*`
// helpers for the server face's real-socket tests (no mocks — a real
// `node:http` server on an ephemeral port, closed by every caller).

/** Holds the workspace root, anchored from this setup file's own location. */
export const WORKSPACE_ROOT = fileURLToPath(resolveRoot(import.meta))

export interface ServerUpgrade {
	readonly request: IncomingMessage
	readonly socket: Duplex
	readonly head: Buffer
}

/** Loads the actual error implementation at an independent module identity before build. */
export async function loadServerErrors(): Promise<typeof ServerErrors> {
	const source = readFileSync(new URL('../src/server/errors.ts', import.meta.url), 'utf8')
	const compiled = stripTypeScriptTypes(source)
		.replace("'@orkestrel/contract'", JSON.stringify(import.meta.resolve('@orkestrel/contract')))
		.replace(
			"'./constants.js'",
			JSON.stringify(new URL('../src/server/constants.ts', import.meta.url).href),
		)
	return import(`data:text/javascript,${encodeURIComponent(compiled)}`)
}

export function trackLoopback(
	bound: LoopbackInterface[],
	loopback: LoopbackInterface,
): LoopbackInterface {
	bound.push(loopback)
	return loopback
}

export function createRawPeer(
	opened: Array<{ destroy(): void }>,
	requests: RecorderInterface<[string]>,
	answer: string,
): net.Server {
	return net.createServer((socket) => {
		opened.push(socket)
		const chunks: string[] = []
		socket.on('data', (chunk: Buffer) => {
			chunks.push(chunk.toString('utf8'))
			const text = chunks.join('')
			if (!text.endsWith('\r\n\r\n')) return
			requests.handler(text)
			socket.write(answer)
		})
	})
}

export function createAnsweringPeer(paths: RecorderInterface<[string | undefined]>): http.Server {
	return http.createServer((request, response) => {
		paths.handler(request.url)
		response.writeHead(200, { 'Content-Type': 'text/plain' })
		response.end('parked')
	})
}

export function createUpgradePeer(
	opened: Array<{ destroy(): void }>,
	handshakes: RecorderInterface<[string | undefined, unknown]>,
	claimed: Duplex[],
): http.Server {
	const server = http.createServer((_request, response) => {
		response.writeHead(426)
		response.end()
	})
	server.on('upgrade', (request, socket) => {
		claimed.push(socket)
		opened.push(socket)
		handshakes.handler(request.url, request.headers['sec-websocket-key'])
		socket.write(
			'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
		)
		// A real peer reads its side of the upgraded connection. A claimed socket that never reads
		// stays paused, so the client's departure sits unread in the receive buffer and the peer
		// reports nothing. An upgraded socket also keeps its writable side after the client leaves,
		// so `end` is the peer's departure signal and `close` never arrives.
		socket.on('error', () => undefined)
		socket.resume()
	})
	return server
}

export async function compressServerFixture(text: string): Promise<Uint8Array<ArrayBuffer>> {
	const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text))
			controller.close()
		},
	})
	return new Uint8Array(
		await new Response(source.pipeThrough(new CompressionStream('gzip'))).arrayBuffer(),
	)
}

/** Lists the own property names of `Object.prototype` that a cookie name can spell. */
export const SERVER_PROTOTYPE_NAMES: readonly string[] = Object.freeze([
	'__defineGetter__',
	'__defineSetter__',
	'__lookupGetter__',
	'__lookupSetter__',
	'__proto__',
	'constructor',
	'hasOwnProperty',
	'isPrototypeOf',
	'propertyIsEnumerable',
	'toLocaleString',
	'toString',
	'valueOf',
])

/** Holds U+00A0, the no-break space, a space outside OWS. */
export const SERVER_NBSP = String.fromCharCode(0x00a0)

/** Holds U+FEFF, the byte-order mark, a space outside OWS. */
export const SERVER_BOM = String.fromCharCode(0xfeff)

/** Holds U+3000, the ideographic space, a space outside OWS. */
export const SERVER_WIDE_SPACE = String.fromCharCode(0x3000)

/** Describes one `parseRange` row: a header against a 1000-byte resource and its answer. */
export interface ServerRangeCase {
	readonly header: string
	readonly expected: RangeSpec | undefined
}

/** Lists `Range` headers whose bounds are `1*DIGIT`, the language `parseRange` admits. */
export const SERVER_RANGE_ADMITTED: readonly ServerRangeCase[] = Object.freeze([
	{ header: 'bytes=0-99', expected: { satisfiable: true, start: 0, end: 99 } },
	{ header: 'bytes=0-0', expected: { satisfiable: true, start: 0, end: 0 } },
	{ header: 'bytes=500-', expected: { satisfiable: true, start: 500, end: 999 } },
	{ header: 'bytes=-100', expected: { satisfiable: true, start: 900, end: 999 } },
	{ header: 'bytes=-5000', expected: { satisfiable: true, start: 0, end: 999 } },
	{ header: 'bytes=007-009', expected: { satisfiable: true, start: 7, end: 9 } },
	{ header: 'bytes=10-99999999999999999999', expected: { satisfiable: true, start: 10, end: 999 } },
	{ header: 'bytes=99999999999999999999-', expected: { satisfiable: false } },
	{ header: 'bytes=1000-', expected: { satisfiable: false } },
	{ header: ' bytes= 5-9 ', expected: { satisfiable: true, start: 5, end: 9 } },
	{ header: '\tbytes=\t5-9\t', expected: { satisfiable: true, start: 5, end: 9 } },
	{ header: 'Bytes=0-1', expected: { satisfiable: true, start: 0, end: 1 } },
	{ header: 'BYTES=0-1', expected: { satisfiable: true, start: 0, end: 1 } },
	{ header: 'bytes=0-1,', expected: { satisfiable: true, start: 0, end: 1 } },
	{ header: 'bytes=,0-1', expected: { satisfiable: true, start: 0, end: 1 } },
	{ header: 'bytes=0-1 , ,', expected: { satisfiable: true, start: 0, end: 1 } },
	{ header: 'bytes=-0', expected: { satisfiable: false } },
	{ header: `bytes=${'9'.repeat(400)}-`, expected: { satisfiable: false } },
	{ header: `bytes=0-${'9'.repeat(400)}`, expected: { satisfiable: true, start: 0, end: 999 } },
	{ header: `bytes=-${'9'.repeat(400)}`, expected: { satisfiable: true, start: 0, end: 999 } },
	{ header: `bytes=${'0'.repeat(400)}5-9`, expected: { satisfiable: true, start: 5, end: 9 } },
])

/** Lists `Range` headers outside the RFC 9110 § 14.1 grammar, which `parseRange` ignores. */
export const SERVER_RANGE_REFUSED: readonly ServerRangeCase[] = Object.freeze([
	{ header: 'bytes=2000-0x10', expected: undefined },
	{ header: 'bytes=2000-garbage', expected: undefined },
	{ header: 'bytes=1000-+5', expected: undefined },
	{ header: 'bytes=2000-1000', expected: undefined },
	{ header: `bytes=${'9'.repeat(400)}-${'9'.repeat(399)}`, expected: undefined },
	{ header: 'bytes=5 -9', expected: undefined },
	{ header: 'bytes=5- 9', expected: undefined },
	{ header: ' bytes= 5 - 9 ', expected: undefined },
	{ header: `bytes=${SERVER_NBSP}5-9`, expected: undefined },
	{ header: `bytes=5-9${SERVER_BOM}`, expected: undefined },
	{ header: `bytes=5${SERVER_WIDE_SPACE}-9`, expected: undefined },
	{ header: `${SERVER_NBSP}bytes=0-1`, expected: undefined },
	{ header: `${SERVER_BOM}bytes=0-1`, expected: undefined },
	{ header: `bytes=0-1${SERVER_WIDE_SPACE}`, expected: undefined },
	{ header: 'bytes =0-1', expected: undefined },
	{ header: 'bytes=0-1 0-2', expected: undefined },
	{ header: 'bytes=', expected: undefined },
	{ header: 'bytes=,', expected: undefined },
	{ header: 'bytes=0-1,2-3', expected: undefined },
	{ header: 'bytes=0-1-2', expected: undefined },
	{ header: 'bytes=garbage', expected: undefined },
	{ header: 'bytes=0x10-', expected: undefined },
	{ header: 'bytes=0X10-', expected: undefined },
	{ header: 'bytes=0b11-9', expected: undefined },
	{ header: 'bytes=0o7-9', expected: undefined },
	{ header: 'bytes=1e1-', expected: undefined },
	{ header: 'bytes=1E1-20', expected: undefined },
	{ header: 'bytes=+5-', expected: undefined },
	{ header: 'bytes=+5-9', expected: undefined },
	{ header: 'bytes=1.0-9', expected: undefined },
	{ header: 'bytes=5.-9', expected: undefined },
	{ header: 'bytes=.5-9', expected: undefined },
	{ header: 'bytes=5-1e1', expected: undefined },
	{ header: 'bytes=5-0x10', expected: undefined },
	{ header: 'bytes=5-+9', expected: undefined },
	{ header: 'bytes=5-9.0', expected: undefined },
	{ header: 'bytes=-0x10', expected: undefined },
	{ header: 'bytes=-1e1', expected: undefined },
	{ header: 'bytes=-+5', expected: undefined },
	{ header: 'bytes=-5.0', expected: undefined },
	{ header: 'bytes=Infinity-', expected: undefined },
	{ header: 'bytes=5-Infinity', expected: undefined },
	{ header: 'bytes=1_0-', expected: undefined },
	{ header: 'bytes=١-', expected: undefined },
	{ header: 'bytes=５-', expected: undefined },
])

/** Holds the `tchar` characters of RFC 9110 § 5.6.2, which a range unit is made of. */
export const SERVER_TCHAR =
	"!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/** Names the place a reference scan has reached in the `Range` field grammar. */
export type ServerRangePhase =
	| 'lead'
	| 'unit'
	| 'space'
	| 'element'
	| 'tail'
	| 'separator'
	| 'reject'

/**
 * Describes a reference scan of a `Range` field value: its phase, the span of its unit, the
 * start of the element it is reading, and the spans of the list elements it has closed.
 */
export interface ServerRangeScan {
	readonly phase: ServerRangePhase
	readonly unit: readonly [number, number]
	readonly start: number
	readonly elements: ReadonlyArray<readonly [number, number]>
}

/** Describes one `parseRange` input: a header and a resource size. */
export interface ServerRangeProbe {
	readonly header: string
	readonly size: number
}

/**
 * Advances a reference scan of the `Range` field value by one character, written from the
 * RFC 9110 ABNF: `OWS range-unit "=" OWS range-set OWS`, where `range-set` is `1#range-spec`
 * under the § 5.6.1 recipient list rule and a `range-spec` is a run of VCHAR other than `,`.
 *
 * @param scan - The scan so far
 * @param char - The next UTF-16 code unit
 * @param index - The position of `char` in the field value
 * @returns The advanced scan
 */
export function stepServerRange(
	scan: ServerRangeScan,
	char: string,
	index: number,
): ServerRangeScan {
	const space = char === ' ' || char === '\t'
	const code = char.charCodeAt(0)
	const visible = code >= 0x21 && code <= 0x7e && char !== ','
	const token = SERVER_TCHAR.includes(char)
	switch (scan.phase) {
		case 'lead':
			if (space) return scan
			return token
				? { ...scan, phase: 'unit', unit: [index, index + 1] }
				: { ...scan, phase: 'reject' }
		case 'unit':
			if (char === '=') return { ...scan, phase: 'space' }
			return token ? { ...scan, unit: [scan.unit[0], index + 1] } : { ...scan, phase: 'reject' }
		case 'space':
			if (space) return scan
			if (char === ',') return { ...scan, phase: 'separator' }
			return visible ? { ...scan, phase: 'element', start: index } : { ...scan, phase: 'reject' }
		case 'element':
			if (space)
				return { ...scan, phase: 'tail', elements: [...scan.elements, [scan.start, index]] }
			if (char === ',') {
				return { ...scan, phase: 'separator', elements: [...scan.elements, [scan.start, index]] }
			}
			return visible ? scan : { ...scan, phase: 'reject' }
		case 'tail':
			if (space) return scan
			return char === ',' ? { ...scan, phase: 'separator' } : { ...scan, phase: 'reject' }
		case 'separator':
			if (space || char === ',') return scan
			return visible ? { ...scan, phase: 'element', start: index } : { ...scan, phase: 'reject' }
		case 'reject':
			return scan
	}
}

/**
 * Checks whether text is `1*DIGIT`, one ASCII digit or more, by its characters.
 *
 * @param text - The candidate bound
 * @returns True if every character is `0` through `9` and there is one at least; false otherwise
 */
export function isServerDigits(text: string): boolean {
	return text.length > 0 && text.split('').every((char) => char >= '0' && char <= '9')
}

/**
 * Recognizes a `Range` field value against a resource size, the reference oracle for
 * `parseRange`: a character scan of the RFC 9110 § 14.1 grammar, with every bound compared
 * as a `BigInt`.
 *
 * @param header - The `Range` field value
 * @param size - The resource's length in bytes
 * @returns The answer RFC 9110 § 14.1.2 and § 14.2 give for one byte range, or `undefined`
 *   when the field is ignored: outside the grammar, another unit, more than one range, an
 *   invalid range, or a size that is not a non-negative safe integer
 */
export function recognizeServerRange(header: string, size: number): RangeSpec | undefined {
	if (!Number.isSafeInteger(size) || size < 0) return undefined
	const initial: ServerRangeScan = { phase: 'lead', unit: [0, 0], start: 0, elements: [] }
	const scan = header
		.split('')
		.reduce<ServerRangeScan>((state, char, index) => stepServerRange(state, char, index), initial)
	const closed = scan.phase === 'element' || scan.phase === 'tail' || scan.phase === 'separator'
	const open: readonly [number, number] = [scan.start, header.length]
	const spans = scan.phase === 'element' ? [...scan.elements, open] : scan.elements
	if (!closed || spans.length !== 1) return undefined
	if (header.slice(scan.unit[0], scan.unit[1]).toLowerCase() !== 'bytes') return undefined
	const parts = header.slice(spans[0]?.[0], spans[0]?.[1]).split('-')
	if (parts.length !== 2) return undefined
	const [first = '', last = ''] = parts
	const extent = BigInt(size)
	if (first === '') {
		if (!isServerDigits(last)) return undefined
		const suffix = BigInt(last)
		// § 14.1.2: a non-zero suffix on an empty representation selects no window, so § 14.2's ignore applies.
		if (suffix === 0n) return { satisfiable: false }
		if (extent === 0n) return undefined
		return {
			satisfiable: true,
			start: suffix >= extent ? 0 : Number(extent - suffix),
			end: size - 1,
		}
	}
	if (!isServerDigits(first) || (last !== '' && !isServerDigits(last))) return undefined
	const start = BigInt(first)
	if (last !== '' && BigInt(last) < start) return undefined
	if (start >= extent) return { satisfiable: false }
	const end = last === '' || BigInt(last) >= extent ? size - 1 : Number(BigInt(last))
	return { satisfiable: true, start: Number(start), end }
}

/**
 * Lists every string of one length over an alphabet, in counting order.
 *
 * @param alphabet - The characters to draw from
 * @param length - The length of each string
 * @returns Every one of the `alphabet.length ** length` strings
 */
export function listServerStrings(alphabet: readonly string[], length: number): readonly string[] {
	return Array.from({ length: alphabet.length ** length }, (_, count) =>
		Array.from(
			{ length },
			(__, place) => alphabet[Math.floor(count / alphabet.length ** place) % alphabet.length],
		).join(''),
	)
}

/** Holds the characters the exhaustive `Range` walk builds its range sets from. */
export const SERVER_RANGE_WALK_ALPHABET: readonly string[] = Object.freeze([
	'0',
	'1',
	'9',
	'-',
	',',
	' ',
	'\t',
	'x',
	'+',
])

/** Holds the field prefixes the exhaustive `Range` walk puts before its short range sets. */
export const SERVER_RANGE_WALK_PREFIXES: readonly string[] = Object.freeze([
	'bytes=',
	'Bytes=',
	'BYTES=',
	' bytes=',
	'bytes= ',
	'bytes =',
	'byte=',
	'items=',
])

/** Holds the resource sizes the exhaustive `Range` walk pairs with every header. */
export const SERVER_RANGE_WALK_SIZES: readonly number[] = Object.freeze([0, 1, 2, 10])

/**
 * Builds the exhaustive `Range` walk: every prefix before every range set of up to 3 walk
 * characters, `bytes=` before every range set of exactly 4, each paired with every walk size.
 *
 * @returns The header and size pairs, 52,484 of them
 */
export function buildServerRangeWalk(): readonly ServerRangeProbe[] {
	const short = [0, 1, 2, 3].flatMap((length) =>
		listServerStrings(SERVER_RANGE_WALK_ALPHABET, length),
	)
	const headers = [
		...SERVER_RANGE_WALK_PREFIXES.flatMap((prefix) => short.map((set) => `${prefix}${set}`)),
		...listServerStrings(SERVER_RANGE_WALK_ALPHABET, 4).map((set) => `bytes=${set}`),
	]
	return headers.flatMap((header) => SERVER_RANGE_WALK_SIZES.map((size) => ({ header, size })))
}

/** Holds the parts the seeded `Range` population assembles headers from. */
export const SERVER_RANGE_PARTS = Object.freeze({
	ends: Object.freeze(['', '', ' ', '\t', SERVER_NBSP, SERVER_BOM, SERVER_WIDE_SPACE]),
	units: Object.freeze(['bytes', 'bytes', 'Bytes', 'BYTES', 'bYtEs', 'items', 'byte', 'by tes']),
	equals: Object.freeze(['=', '=', '= ', '=\t', ' =', `=${SERVER_NBSP}`]),
	bounds: Object.freeze([
		'',
		'0',
		'5',
		'9',
		'10',
		'999',
		'1000',
		'007',
		'9'.repeat(400),
		`${'0'.repeat(400)}5`,
		'0x10',
		'1e1',
		'+5',
		'1.0',
		'5.',
		'.5',
		'1_0',
		'١',
		'５',
		'Infinity',
		'garbage',
		' 5',
		'5 ',
	]),
	dashes: Object.freeze(['-', '-', '-', ' -', '- ', '--', '']),
	joins: Object.freeze([',', ', ', ' , ', ',,', ' ']),
	sizes: Object.freeze([0, 1, 10, 1000, Number.MAX_SAFE_INTEGER, 1.5, -1]),
})

/**
 * Bounds the growth ratio t(4n)/t(n) that a linear call may show in a cost row. On 2026-11-16, at
 * n = 4,000 with the host's load average near 1.1, 30 solo readings per shape of the base
 * `parseRange` (`2eb2876`, linear) read 0.91 to 4.36, and the quadratic `parseRange` of
 * `c90ecec` read 15.93 to 18.28; 8 sits near twice the linear maximum and half the quadratic
 * minimum.
 */
export const SERVER_GROWTH_BOUND = 8

/** Holds the run length n at which a cost row reads t(n), and 4n for t(4n). */
export const SERVER_GROWTH_SIZE = 4_000

/**
 * Bounds the cost ratio of scrubbing an array of n primitives over an array of n empty arrays. On
 * 2026-11-17, at n = 4,000, 12 solo readings of the base `scrubPrototype` (`b245633`, both guards
 * on every member) read 0.316 to 0.427 over two runs with the host's load average from 1.9 to 5.6,
 * and the scrub that skips the guards for a primitive read 0.028 to 0.081; 0.15 sits near half the
 * base minimum and twice the skip's maximum.
 */
export const SERVER_SCRUB_ARRAY_BOUND = 0.15

/**
 * Bounds the cost ratio of scrubbing n/4 records of 4 primitive members over n/4 records of 4
 * empty-array members. On 2026-11-17, at n = 4,000 with the host's load average from 3.6 to 5.6,
 * 12 solo readings each read 0.444 to 0.481 for the base `scrubPrototype` (`b245633`), 0.451 to
 * 0.517 with the skip on array members only, and 0.254 to 0.277 with the skip on record members
 * too; 0.36 sits between them.
 */
export const SERVER_SCRUB_RECORD_BOUND = 0.36

/** Describes one cost-row header: the text before and after a run of spaces of size n. */
export interface ServerRangeShape {
	readonly before: string
	readonly after: string
}

/** Lists the `Range` header shapes a review found quadratic: a run of spaces inside the field. */
export const SERVER_RANGE_SHAPES: readonly ServerRangeShape[] = Object.freeze([
	{ before: 'bytes=0', after: 'x' },
	{ before: 'bytes', after: 'x=0-1' },
	{ before: 'bytes=0-1', after: 'x,' },
])

/**
 * Times one batch of `repeat` runs of `call`, in milliseconds.
 *
 * @param call - The call to time
 * @param repeat - The number of runs in the batch
 * @returns The duration of the batch
 */
export function timeServerBatch(call: () => unknown, repeat: number): number {
	const start = performance.now()
	Array.from({ length: repeat }, () => call())
	return performance.now() - start
}

/**
 * Measures how a call's cost grows from size n to 4n: the batch time at 4n over the batch time
 * at n, each the least of 5 batches, with the batch sized so it takes 20 ms or more at n.
 *
 * @remarks
 * The batches interleave in 5 rounds, the small batch first in the even rounds and the large batch
 * first in the odd ones, so a burst of contention on the host reaches both sizes rather than one.
 *
 * @param build - Builds the call to time for one size
 * @param size - The size n
 * @returns t(4n)/t(n), near 4 for a linear call and near 16 for a quadratic one
 */
export function measureServerGrowth(build: (size: number) => () => unknown, size: number): number {
	return compareServerCost(build(4 * size), build(size))
}

/**
 * Compares two calls' costs: the batch time of `call` over the batch time of `reference`, each the
 * least of 5 batches, with the batch sized so `reference` takes 20 ms or more.
 *
 * @remarks
 * The batches interleave in 5 rounds, `reference` first in the even rounds and `call` first in the
 * odd ones, so a burst of contention on the host reaches both calls rather than one.
 *
 * @param call - The call whose cost is the numerator
 * @param reference - The call whose cost is the denominator
 * @returns t(call)/t(reference)
 */
export function compareServerCost(call: () => unknown, reference: () => unknown): number {
	reference()
	call()
	const repeat = Math.max(1, Math.ceil(20 / Math.max(timeServerBatch(reference, 1), 0.001)))
	const rounds = Array.from({ length: 5 }, (_, round) =>
		round % 2 === 0
			? { reference: timeServerBatch(reference, repeat), call: timeServerBatch(call, repeat) }
			: { call: timeServerBatch(call, repeat), reference: timeServerBatch(reference, repeat) },
	)
	return (
		Math.min(...rounds.map((times) => times.call)) /
		Math.min(...rounds.map((times) => times.reference))
	)
}

/**
 * Picks one member of a list with a seeded random source.
 *
 * @param random - The seeded source
 * @param list - The list to pick from, which must not be empty
 * @returns The picked member
 */
export function pickServer<T>(random: RandomFunction, list: readonly T[]): T {
	const member = list[Math.floor(random() * list.length)]
	if (member === undefined) throw new Error('pickServer needs a non-empty list')
	return member
}

/**
 * Builds a seeded `Range` population of grammar members and near misses from
 * {@link SERVER_RANGE_PARTS}, most headers holding one range and some holding two or three.
 *
 * @param seed - The seed of the random source
 * @param count - The number of header and size pairs
 * @returns The pairs, the same for the same seed and count
 */
export function buildServerRangePopulation(
	seed: number,
	count: number,
): readonly ServerRangeProbe[] {
	const random = seededRandom(seed)
	return Array.from({ length: count }, () => {
		const ranges = Array.from(
			{ length: pickServer(random, [1, 1, 1, 1, 2, 3]) },
			() =>
				`${pickServer(random, SERVER_RANGE_PARTS.bounds)}${pickServer(random, SERVER_RANGE_PARTS.dashes)}${pickServer(random, SERVER_RANGE_PARTS.bounds)}`,
		)
		const header = `${pickServer(random, SERVER_RANGE_PARTS.ends)}${pickServer(random, SERVER_RANGE_PARTS.units)}${pickServer(random, SERVER_RANGE_PARTS.equals)}${ranges.join(pickServer(random, SERVER_RANGE_PARTS.joins))}${pickServer(random, SERVER_RANGE_PARTS.ends)}`
		return { header, size: pickServer(random, SERVER_RANGE_PARTS.sizes) }
	})
}

/** Describes one SSE message `serializeEvent` refuses and the field that carries the refusal. */
export interface ServerEventRefusal {
	readonly message: SSEMessage
	readonly field: string
}

/** Lists SSE messages whose `event`, `id`, or `retry` the event-stream wire cannot carry. */
export const SERVER_EVENT_REFUSALS: readonly ServerEventRefusal[] = Object.freeze([
	{ message: { event: 'tick\ndata: injected', data: 'x' }, field: 'event' },
	{ message: { event: 'tick\r', data: 'x' }, field: 'event' },
	{ message: { event: 'tick\r\nid: 9', data: 'x' }, field: 'event' },
	{ message: { id: '7\n\ndata: forged', data: 'x' }, field: 'id' },
	{ message: { id: '7\r', data: 'x' }, field: 'id' },
	{ message: { id: 'a\u0000b', data: 'x' }, field: 'id' },
	{ message: { retry: Number.NaN, data: 'x' }, field: 'retry' },
	{ message: { retry: Number.POSITIVE_INFINITY, data: 'x' }, field: 'retry' },
	{ message: { retry: Number.NEGATIVE_INFINITY, data: 'x' }, field: 'retry' },
	{ message: { retry: -1, data: 'x' }, field: 'retry' },
	{ message: { retry: 1.5, data: 'x' }, field: 'retry' },
	{ message: { retry: 2 ** 53, data: 'x' }, field: 'retry' },
])

/** Lists SSE messages `serializeEvent` admits, each of which a conforming parser reads back unchanged. */
export const SERVER_EVENT_MESSAGES: readonly SSEMessage[] = Object.freeze([
	{ data: 'hello' },
	{ event: 'token', id: '1', retry: 500, data: 'hello' },
	{ data: 'multi\nline' },
	{ data: '' },
	{ data: 'data: injected\n\nevent: forged' },
	{ event: ' padded', id: ' 7', data: ' leading' },
	{ event: '', id: '', data: 'empty fields' },
	{ event: 'tick:tock', id: 'a:b', data: 'colon' },
	{ retry: 0, data: 'zero' },
	{ retry: Number.MAX_SAFE_INTEGER, data: 'largest' },
	{ event: 'grüße', id: '番号', data: 'é\u0000🎉' },
])

/**
 * Builds a node whose `self` getter returns the node itself until `bound` reads, then a
 * primitive, and counts every read — a cycle that terminates on its own count.
 *
 * @param bound - The number of reads after which the getter stops returning the node
 * @param reads - The observation the getter increments on every read
 * @returns The self-referencing node
 */
export function buildServerCycle(bound: number, reads: ServerObservation<number>): object {
	return {
		get self(): unknown {
			reads.value += 1
			return reads.value < bound ? this : 0
		},
	}
}

export interface ServerAppState {
	readonly userId: string
}

export class ServerUserState {
	#userId: string | undefined

	get userId(): string | undefined {
		return this.#userId
	}

	set userId(value: string | undefined) {
		this.#userId = value
	}
}

export function createTraceLayer(
	order: string[],
	name: string,
): MiddlewareHandler<Record<string, never>> {
	return async (_request, _context, next) => {
		order.push(`${name}-before`)
		const response = await next()
		order.push(`${name}-after`)
		return response
	}
}

export async function repeatServerNext(
	_request: Request,
	_context: MiddlewareContext<Record<string, never>>,
	next: NextFunction,
): Promise<Response> {
	await next()
	return next()
}

export async function raceServerNext(
	_request: Request,
	_context: MiddlewareContext<Record<string, never>>,
	next: NextFunction,
): Promise<Response> {
	const results = await Promise.allSettled([next(), next()])
	const rejected = results.find((result) => result.status === 'rejected')
	if (rejected === undefined || rejected.status !== 'rejected') {
		throw new Error('expected one of the concurrent next() calls to reject')
	}
	return new Response(rejected.reason instanceof Error ? rejected.reason.message : 'unknown')
}

export async function refuseServerRequest(): Promise<Response> {
	return new Response('blocked', { status: 403 })
}

export function createObservedRefusal(
	observation: ServerObservation<boolean>,
): MiddlewareHandler<Record<string, never>> {
	return async () => {
		observation.value = true
		return new Response('blocked', { status: 403 })
	}
}

export function createResponseHeader(
	name: string,
	value: string,
): MiddlewareHandler<Record<string, never>> {
	return async (_request, _context, next) => {
		const response = await next()
		response.headers.set(name, value)
		return response
	}
}

export async function stashServerUser(
	_request: Request,
	context: MiddlewareContext<ServerUserState>,
	next: NextFunction,
): Promise<Response> {
	context.state.userId = 'user-42'
	return next()
}

export interface EchoState {
	readonly ip: string | undefined
	readonly encrypted: boolean
}

export function createEchoDispatcher(): DispatcherInterface<EchoState> {
	const dispatcher = createDispatcher<EchoState>()
	dispatcher.add({ method: 'GET', path: '/ping', handler: () => new Response('pong') })
	return dispatcher
}

export function createPingDispatcher(): DispatcherInterface<undefined> {
	const dispatcher = createDispatcher<undefined>()
	dispatcher.add({ method: 'GET', path: '/ping', handler: () => new Response('pong') })
	return dispatcher
}

export function createUploadDispatcher(): DispatcherInterface<undefined> {
	const dispatcher = createPingDispatcher()
	dispatcher.add({
		method: 'POST',
		path: '/upload',
		handler: () => new Response('too large', { status: 413 }),
	})
	return dispatcher
}

export function claimUpgrades(server: ServerInterface<undefined>): Duplex[] {
	const claimed: Duplex[] = []
	server.upgrade((_request, socket) => {
		claimed.push(socket)
		socket.write(
			'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
		)
		return true
	})
	return claimed
}

export function trackServer<T extends { stop(): Promise<void> }>(
	running: Array<{ stop(): Promise<void> }>,
	server: T,
): T {
	running.push(server)
	return server
}

/** Reports the outcome of a raw `upgradeRequest` probe: whether a handler claimed the socket. */
export interface UpgradeOutcomeInterface {
	readonly claimed: boolean
	readonly status: number
}

/**
 * Sends a raw, hand-written HTTP request over a bare `node:net` socket and
 * resolves with whatever bytes come back — the real-socket probe for
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
		const chunks: string[] = []
		socket.on('data', (chunk: Buffer) => {
			chunks.push(chunk.toString('utf8'))
			socket.end()
		})
		socket.on('close', () => resolve(chunks.join('')))
		socket.on('error', reject)
	})
}

/** Represents a real HTTP response socket whose readable side starts paused. */
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
 * Opens a real HTTP request over TCP while parking the response reader.
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
	const chunks: number[] = []
	socket.on('data', (chunk: Buffer) => {
		chunks.push(chunk.byteLength)
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
			return chunks.reduce((bytes, size) => bytes + size, 0)
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
 * Probes whether a real TCP connection is dropped before it can carry data.
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

/** Represents a client-side upgraded connection deliberately left open — see {@link holdUpgrade}. */
export interface HeldUpgradeInterface {
	/** Resolves when the connection closes, from either end. */
	readonly closed: Promise<void>
	/** Whether the client socket is already gone. */
	readonly done: boolean
	/** Close the client end. */
	release(): void
}

/**
 * Completes a real protocol upgrade and keeps the socket open — the long-lived
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
 * registered handler claimed the socket, and an ordinary HTTP response or a
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

// ── The exchange seam oracle ─────────────────────────────────────────────────
//
// The tables and layers `tests/src/server/integration.test.ts` drives through a real `Server`. Every
// expectation comes from the declared seam contract, never from the code: one `Request` per
// exchange, one context per exchange that carries `connection` and `abort`, a `next` that takes no
// argument, an in-flight registry of abort handles, and mutable response headers at every layer.

/** Holds the JSON body the body-reading cells post: the request of fit finding F1. */
export const SEAM_BODY = '{"item":"lamp"}'

/** Represents one argument a layer passes to its `next`, which the seam refuses. */
export interface SeamArgumentCase {
	readonly label: string
	readonly build: (request: Request) => unknown
}

/** Lists the arguments a layer can pass to its `next`; each call rejects with code `'NEXT'`. */
export const SEAM_NEXT_ARGUMENTS: readonly SeamArgumentCase[] = Object.freeze([
	{
		label: 'a rewritten Request for another path, the fit finding F2 rewrite',
		build: (request: Request): unknown =>
			new Request(new URL('/b', request.url), { method: 'POST', body: 'rewritten body' }),
	},
	{
		label: 'a copy carrying another signal, the request rebuild of fit finding F1',
		build: (request: Request): unknown =>
			new Request(request, { signal: AbortSignal.timeout(5_000) }),
	},
	{ label: 'the same Request', build: (request: Request): unknown => request },
	{ label: 'undefined', build: (): unknown => undefined },
])

/** Represents one `state` factory the connection cells run under. */
export interface SeamStateCase {
	readonly label: string
	readonly state: (connection: Connection) => object
}

/** Lists the `state` factories under which every layer reads the exchange's `connection`. */
export const SEAM_STATE_FACTORIES: readonly SeamStateCase[] = Object.freeze([
	{ label: 'a factory that ignores the connection, fit finding F4', state: (): object => ({}) },
	{
		label: 'a factory that keeps the connection',
		state: (connection: Connection): object => ({ connection }),
	},
])

/** Represents one route response whose headers a layer sets after `await next()`. */
export interface SeamResponseCase {
	readonly label: string
	readonly status: number
	readonly location: string | undefined
	readonly body: string
	readonly respond: (request: Request, origin: string) => Response | Promise<Response>
}

/**
 * Lists the immutable-header responses a route returns behind header-setting layers: a
 * `Response.redirect` result to `/next`, and a `fetch` result from an answering peer at `origin`,
 * whose body is `parked`.
 */
export const SEAM_IMMUTABLE_RESPONSES: readonly SeamResponseCase[] = Object.freeze([
	{
		label: 'a Response.redirect result',
		status: 302,
		location: '/next',
		body: '',
		respond: (request: Request): Response => Response.redirect(new URL('/next', request.url), 302),
	},
	{
		label: 'a fetch result',
		status: 200,
		location: undefined,
		body: 'parked',
		respond: (_request: Request, origin: string): Promise<Response> => fetch(`${origin}/peer`),
	},
])

/** Represents one exchange whose `Request` constructions the construction cells count. */
export interface SeamConstructionCase {
	readonly label: string
	readonly method: string
	readonly path: string
	readonly status: number
}

/** Lists the exchanges that each construct one `Request`: a `GET`, a `POST`, and a handler throw. */
export const SEAM_CONSTRUCTION_CASES: readonly SeamConstructionCase[] = Object.freeze([
	{ label: 'a GET', method: 'GET', path: '/plain', status: 200 },
	{ label: 'a POST', method: 'POST', path: '/a', status: 200 },
	{ label: 'a handler throw', method: 'GET', path: '/throw', status: 500 },
])

/** Reports one reply a {@link sendSeamRequest} call read. */
export interface SeamReply {
	readonly status: number
	readonly body: string
	readonly reused: boolean
}

/**
 * Sends one `GET` through `agent` and reads its status, its body, and whether the request went
 * out on a socket an earlier request used.
 *
 * @param port - The server's bound port on `127.0.0.1`
 * @param path - The request path
 * @param agent - The keep-alive agent that owns the connection
 * @returns The reply
 */
export function sendSeamRequest(port: number, path: string, agent: http.Agent): Promise<SeamReply> {
	return new Promise((resolve, reject) => {
		const request = http.get({ host: '127.0.0.1', port, path, agent }, (response) => {
			const chunks: Buffer[] = []
			response.on('data', (chunk: Buffer) => chunks.push(chunk))
			response.once('end', () =>
				resolve({
					status: response.statusCode ?? 0,
					body: Buffer.concat(chunks).toString('utf8'),
					reused: request.reusedSocket,
				}),
			)
		})
		request.once('error', reject)
	})
}

/**
 * Describes an abort reason as the text a seam route answers with: an error's message, or the
 * reason's string form.
 *
 * @param reason - The reason a signal carries
 * @returns The text that names it
 */
export function describeSeamReason(reason: unknown): string {
	return reason instanceof Error ? reason.message : String(reason)
}

/**
 * Builds the dispatcher the seam cells route into, recording every request it receives.
 *
 * @remarks
 * - `GET /plain` answers `plain`.
 * - `GET /state` answers `aborted` or `open` for its signal as the handler starts.
 * - `GET /throw` throws an `Error`, which the server's boundary answers with 500.
 * - `GET /hold` parks until its request signal aborts, then answers the reason's text.
 * - `GET /gate` parks until `gate` settles, then answers `aborted` or `open` for its signal.
 * - `POST /a` and `POST /b` answer their path and their body text.
 *
 * @param requests - The log each route appends its `Request` to, in arrival order
 * @param gate - The promise `GET /gate` parks on
 * @returns The dispatcher
 */
export function createSeamDispatcher<TState>(
	requests: Request[],
	gate: Promise<void>,
): DispatcherInterface<TState> {
	const dispatcher = createDispatcher<TState>()
	dispatcher.add({
		method: 'GET',
		path: '/plain',
		handler: (request) => {
			requests.push(request)
			return new Response('plain')
		},
	})
	dispatcher.add({
		method: 'GET',
		path: '/state',
		handler: (request) => {
			requests.push(request)
			return new Response(request.signal.aborted ? 'aborted' : 'open')
		},
	})
	dispatcher.add({
		method: 'GET',
		path: '/throw',
		handler: (request) => {
			requests.push(request)
			throw new Error('the /throw route failed')
		},
	})
	dispatcher.add({
		method: 'GET',
		path: '/hold',
		handler: async (request) => {
			requests.push(request)
			await waitForAbort(request.signal)
			return new Response(describeSeamReason(request.signal.reason))
		},
	})
	dispatcher.add({
		method: 'GET',
		path: '/gate',
		handler: async (request) => {
			requests.push(request)
			await gate
			return new Response(request.signal.aborted ? 'aborted' : 'open')
		},
	})
	for (const path of ['/a', '/b']) {
		dispatcher.add({
			method: 'POST',
			path,
			handler: async (request) => {
				requests.push(request)
				return new Response(`${path}:${await request.text()}`)
			},
		})
	}
	return dispatcher
}

/**
 * Creates a layer that aborts its exchange with a `TimeoutError` after `ms`, the deadline that
 * `createDeadline` in `@orkestrel/middleware` builds on `context.abort`.
 *
 * @param ms - The deadline in milliseconds
 * @returns The layer
 */
export function createDeadlineLayer<TState>(ms: number): MiddlewareHandler<TState> {
	return async (_request, context, next) => {
		// Bound up front, so a context without `abort` refuses in the layer rather than in the timer.
		const abort = context.abort.bind(context)
		const timer = setTimeout(
			() => abort(new DOMException(`deadline of ${ms} ms passed`, 'TimeoutError')),
			ms,
		)
		try {
			return await next()
		} finally {
			clearTimeout(timer)
		}
	}
}

/**
 * Creates a layer that answers with the decoded request body and never calls `next`.
 *
 * @returns The layer, answering `{ body }` as JSON
 */
export function createBodyLayer<TState>(): MiddlewareHandler<TState> {
	return async (_request, context) => Response.json({ body: await context.body() })
}

/**
 * Creates a layer that records the request and the context it receives, then continues.
 *
 * @param seen - The log the layer appends its `[request, context]` pair to
 * @returns The layer
 */
export function createSeenLayer<TState>(
	seen: Array<readonly [Request, MiddlewareContext<TState>]>,
): MiddlewareHandler<TState> {
	return async (request, context, next) => {
		seen.push([request, context])
		return next()
	}
}

/**
 * Creates a layer that records the response its `next` resolves, then sets `name` on it.
 *
 * @param seen - The log the layer appends each downstream response to
 * @param name - The header the layer sets to `set`
 * @returns The layer
 */
export function createResponseLayer<TState>(
	seen: Response[],
	name: string,
): MiddlewareHandler<TState> {
	return async (_request, _context, next) => {
		const response = await next()
		seen.push(response)
		response.headers.set(name, 'set')
		return response
	}
}

/**
 * Creates a layer that calls its `next` with the argument `build` returns, records the
 * rejection, and rethrows it.
 *
 * @param build - Builds the argument from the layer's request
 * @param refusal - The observation the rejection is recorded in
 * @returns The layer
 */
export function createArgumentLayer<TState>(
	build: (request: Request) => unknown,
	refusal: ServerObservation<unknown>,
): MiddlewareHandler<TState> {
	return async (request, _context, next) => {
		// A layer written against the 0.0.28 seam passes its `next` an argument; the type admits it.
		const forward: (argument: unknown) => Promise<Response> = next
		try {
			return await forward(build(request))
		} catch (error) {
			refusal.value = error
			throw error
		}
	}
}

/**
 * Creates a layer that calls its `next` with the request, records that refusal, and then calls
 * `next` again with no argument: the refused-then-valid order, whose second call the seam refuses.
 *
 * @param refusal - The observation the first call's rejection is recorded in
 * @returns The layer
 */
export function createRetryLayer<TState>(
	refusal: ServerObservation<unknown>,
): MiddlewareHandler<TState> {
	return async (request, _context, next) => {
		const forward: (argument: unknown) => Promise<Response> = next
		refusal.value = await forward(request).then(
			() => undefined,
			(error: unknown) => error,
		)
		return next()
	}
}

/**
 * Replaces `globalThis.Request` with a proxy that records every construction, and returns the
 * function that puts the original back.
 *
 * @param constructions - The recorder each `new Request(…)` through the global calls
 * @returns The restore function
 */
export function countRequestConstructions(constructions: RecorderInterface<[]>): () => void {
	const original = globalThis.Request
	globalThis.Request = new Proxy(original, {
		construct: (target, args, newTarget) => {
			constructions.handler()
			return Reflect.construct(target, args, newTarget)
		},
	})
	return () => {
		globalThis.Request = original
	}
}

/**
 * Creates a layer that aborts its exchange with each reason in order when the request path is
 * `path`, then continues.
 *
 * @param path - The pathname the layer aborts on
 * @param reasons - The reasons passed to `context.abort`, in call order
 * @returns The layer
 */
export function createAbortLayer<TState>(
	path: string,
	reasons: readonly unknown[],
): MiddlewareHandler<TState> {
	return async (_request, context, next) => {
		if (context.url.pathname === path) for (const reason of reasons) context.abort(reason)
		return next()
	}
}

/**
 * Counts the live objects in this process's heap after three full collections, each followed by a
 * yield so the cleanup callbacks it queued run before the next.
 *
 * @remarks
 * `queryObjects` runs a full garbage collection before it counts. A `FinalizationRegistry`
 * callback runs as a later task, and freeing what one callback releases can queue another: fetch
 * unregisters a `Request`'s abort listener from its signal, and only then can Node collect a
 * signal `AbortSignal.any` composed and prune its bookkeeping. Three rounds let that chain settle.
 *
 * @param kind - The constructor whose prototype the counted objects carry; Default: `Object`
 * @returns The number of live objects whose prototype chain holds `kind.prototype`
 */
export async function countLiveObjects(
	kind: abstract new (...args: never[]) => unknown = Object,
): Promise<number> {
	queryObjects(kind, { format: 'count' })
	await waitForDelay(10)
	queryObjects(kind, { format: 'count' })
	await waitForDelay(10)
	return queryObjects(kind, { format: 'count' })
}

/**
 * Creates a layer that only calls its `next`.
 *
 * @returns The layer
 */
export function createPassLayer<TState>(): MiddlewareHandler<TState> {
	return async (_request, _context, next) => next()
}

/**
 * Sends `count` sequential `GET` requests for `path` on each of the agent's sockets in turn, and
 * reads every reply whole.
 *
 * @param port - The server's bound port on `127.0.0.1`
 * @param path - The request path
 * @param count - The number of requests
 * @param agent - The keep-alive agent that owns the connections
 * @returns The number of replies whose status was not 200
 */
export async function driveSeamRequests(
	port: number,
	path: string,
	count: number,
	agent: http.Agent,
): Promise<number> {
	const lanes = agent.maxSockets
	const shares = Array.from(
		{ length: lanes },
		(_, lane) => Math.floor(count / lanes) + (lane < count % lanes ? 1 : 0),
	)
	const failures = await Promise.all(
		shares.map((share) =>
			Array.from({ length: share }).reduce<Promise<number>>(async (previous) => {
				const failed = await previous
				const reply = await sendSeamRequest(port, path, agent)
				return failed + (reply.status === 200 ? 0 : 1)
			}, Promise.resolve(0)),
		),
	)
	return failures.reduce((sum, failed) => sum + failed, 0)
}

// ── The boundary and its outcomes ────────────────────────────────────────────
//
// The tables and routes the boundary blocks of `tests/src/server/integration.test.ts` and
// `tests/src/server/Server.test.ts` drive through a real `Server`. Every expectation comes from the
// Fetch standard's declarations, never from the code: `Response` admits an integer status from 200
// through 599, and a null body status carries no body.

/** Holds the message every status route throws or answers with. */
export const BOUNDARY_MESSAGE = 'status under test'

/** Holds the body the server sends for a fault whose message it hides. */
export const BOUNDARY_HIDDEN = 'Internal Server Error'

/** Lists the Fetch standard's null body statuses: a response with one of them carries no body. */
export const BOUNDARY_NULL_BODY_STATUSES: readonly number[] = Object.freeze([
	101, 103, 204, 205, 304,
])

/** Holds the lowest and the highest status the Fetch standard's `Response` constructor admits. */
export const BOUNDARY_STATUS_RANGE = Object.freeze({ lowest: 200, highest: 599 })

/** Lists the statuses no `Response` carries beside the range ends: past it, zero, `NaN`, and a fraction. */
export const BOUNDARY_INVALID_STATUSES: readonly number[] = Object.freeze([
	600,
	0,
	Number.NaN,
	200.5,
])

/** Lists every status a route throws as an `HTTPError`: 100 through 999, then zero, `NaN`, and a fraction. */
export const BOUNDARY_THROWN_STATUSES: readonly number[] = Object.freeze([
	...Array.from({ length: 900 }, (_, index) => 100 + index),
	0,
	Number.NaN,
	200.5,
])

/** Lists every status a route returns: a control, each null body status, and each invalid status. */
export const BOUNDARY_RETURNED_STATUSES: readonly number[] = Object.freeze([
	200,
	...BOUNDARY_NULL_BODY_STATUSES,
	...BOUNDARY_INVALID_STATUSES,
])

/** Holds the number of status requests in flight at once, inside the host's descriptor limit. */
export const BOUNDARY_WIDTH = 50

/** Holds how long a reply read waits on an idle socket before it reads the exchange as unanswered. */
export const BOUNDARY_REPLY_MS = 2_000

/** Holds the error the `/fail-body` route's body source fails with after its first chunk. */
export const BOUNDARY_BODY_FAULT = new Error('body source failed after the first chunk')

/** Holds the first chunk the streaming routes send. */
export const BOUNDARY_FIRST_CHUNK = 'part1;'

/** Holds how long the `/slow` route waits before its response and again before its last chunk. */
export const BOUNDARY_SLOW_MS = 30

/** Lists the values the fit finding F3 routes throw, in `/f3/:index` order. */
export const BOUNDARY_F3_THROWS: readonly unknown[] = Object.freeze([
	new Error('secret detail'),
	'thrown string',
	new HTTPError(418, 'teapot'),
])

/** Represents one row of fit finding F3: a throw, the `expose` option, and the answer it must get. */
export interface BoundaryFitCase {
	readonly index: number
	readonly expose: boolean
	readonly status: number
	readonly body: string
	readonly reports: number
}

/**
 * Lists fit finding F3's table: each throw of {@link BOUNDARY_F3_THROWS} under each `expose`
 * value, answered as one renderer answers it.
 */
export const BOUNDARY_F3_CASES: readonly BoundaryFitCase[] = Object.freeze([
	{ index: 0, expose: false, status: 500, body: BOUNDARY_HIDDEN, reports: 1 },
	{ index: 1, expose: false, status: 500, body: BOUNDARY_HIDDEN, reports: 1 },
	{ index: 2, expose: false, status: 418, body: 'teapot', reports: 0 },
	{ index: 0, expose: true, status: 500, body: 'secret detail', reports: 1 },
	{ index: 1, expose: true, status: 500, body: BOUNDARY_HIDDEN, reports: 1 },
	{ index: 2, expose: true, status: 418, body: 'teapot', reports: 0 },
])

/** Describes the answer a status route must get: its status, its body, and its report count. */
export interface BoundaryExpectation {
	readonly status: number
	readonly body: string
	readonly reports: number
}

/**
 * Infers the answer a route that throws or returns `status` must get from a server whose `expose`
 * is off, from the Fetch declarations alone: a status `Response` admits answers itself, with no
 * body when it is a null body status, and every other status answers 500 with the hidden body and
 * one report.
 *
 * @param status - The status the route throws or returns
 * @returns The expected answer
 */
export function inferBoundaryReply(status: number): BoundaryExpectation {
	const admitted =
		Number.isInteger(status) &&
		status >= BOUNDARY_STATUS_RANGE.lowest &&
		status <= BOUNDARY_STATUS_RANGE.highest
	if (!admitted) return { status: 500, body: BOUNDARY_HIDDEN, reports: 1 }
	const empty = BOUNDARY_NULL_BODY_STATUSES.includes(status)
	return { status, body: empty ? '' : BOUNDARY_MESSAGE, reports: 0 }
}

/**
 * Builds the response a `/return/:status` route answers: `Response.error()` for zero, a platform
 * `Response` for a status the constructor admits, and otherwise a platform `Response` whose own
 * `status` property reads `status`, as a subclass that overrides the field would.
 *
 * @param status - The status to answer with
 * @returns The response
 */
export function buildBoundaryResponse(status: number): Response {
	if (status === 0) return Response.error()
	const admitted =
		Number.isInteger(status) &&
		status >= BOUNDARY_STATUS_RANGE.lowest &&
		status <= BOUNDARY_STATUS_RANGE.highest
	if (admitted)
		return new Response(BOUNDARY_NULL_BODY_STATUSES.includes(status) ? null : BOUNDARY_MESSAGE, {
			status,
		})
	const response = new Response(null)
	Object.defineProperty(response, 'status', { value: status })
	return response
}

/**
 * Builds the dispatcher the boundary blocks route into.
 *
 * @remarks
 * - `GET /throw/:status` throws `new HTTPError(Number(status), BOUNDARY_MESSAGE)`.
 * - `GET /return/:status` answers {@link buildBoundaryResponse} for `Number(status)`.
 * - `GET /f3/:index` throws the member of {@link BOUNDARY_F3_THROWS} at `index`.
 * - `GET /boom` throws an `Error`, and `GET /ping` answers `pong`.
 * - `GET /hang` parks until its request signal aborts, then throws the signal's reason.
 * - `POST /upload` reads its body as text, then answers it; a read that fails appends
 *   `/upload failed` and rethrows.
 * - `POST /upload-caught` reads its body as text, then answers it; a read that fails appends
 *   `/upload-caught failed` and answers a 200 with no body.
 * - `POST /echo` answers its own request body as the response body.
 * - `GET /trickle` answers {@link BOUNDARY_FIRST_CHUNK}, then a body that waits until it is
 *   cancelled.
 * - `GET /fail-body` answers {@link BOUNDARY_FIRST_CHUNK}, then fails with
 *   {@link BOUNDARY_BODY_FAULT} after {@link BOUNDARY_SLOW_MS}.
 * - `GET /slow` waits {@link BOUNDARY_SLOW_MS}, answers its first chunk, waits again, then ends.
 * - `GET /unavailable` waits {@link BOUNDARY_SLOW_MS}, then throws an `HTTPError` of 503.
 * - `GET /late-empty` and `GET /late-204` park until their request signal aborts, wait
 *   {@link BOUNDARY_SLOW_MS}, append `<path> answered`, then answer with no body: a 200 and a 204.
 * - `GET /answer-empty` answers a 200 with no body.
 *
 * @param entered - The log each parking route appends its path to as it starts
 * @returns The dispatcher
 */
export function createBoundaryDispatcher(entered: string[]): DispatcherInterface<undefined> {
	const dispatcher = createDispatcher<undefined>()
	dispatcher.add({
		method: 'GET',
		path: '/throw/:status',
		handler: (_request, context) => {
			throw new HTTPError(Number(context.params.status), BOUNDARY_MESSAGE)
		},
	})
	dispatcher.add({
		method: 'GET',
		path: '/return/:status',
		handler: (_request, context) => buildBoundaryResponse(Number(context.params.status)),
	})
	dispatcher.add({
		method: 'GET',
		path: '/f3/:index',
		handler: (_request, context) => {
			throw BOUNDARY_F3_THROWS[Number(context.params.index)]
		},
	})
	dispatcher.add({
		method: 'GET',
		path: '/boom',
		handler: () => {
			throw new Error('handler failed')
		},
	})
	dispatcher.add({ method: 'GET', path: '/ping', handler: () => new Response('pong') })
	dispatcher.add({
		method: 'GET',
		path: '/hang',
		handler: async (request) => {
			entered.push('/hang')
			await waitForAbort(request.signal)
			throw request.signal.reason
		},
	})
	dispatcher.add({
		method: 'POST',
		path: '/upload',
		handler: async (request) => {
			entered.push('/upload')
			const text = await request.text().catch((error: unknown) => {
				entered.push('/upload failed')
				throw error
			})
			return new Response(text)
		},
	})
	dispatcher.add({
		method: 'POST',
		path: '/upload-caught',
		handler: async (request) => {
			entered.push('/upload-caught')
			return request.text().then(
				(text) => new Response(text),
				() => {
					entered.push('/upload-caught failed')
					return new Response(null)
				},
			)
		},
	})
	dispatcher.add({
		method: 'POST',
		path: '/echo',
		handler: (request) => {
			entered.push('/echo')
			return new Response(request.body)
		},
	})
	dispatcher.add({
		method: 'GET',
		path: '/trickle',
		handler: () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start: (controller) => controller.enqueue(new TextEncoder().encode(BOUNDARY_FIRST_CHUNK)),
					pull: () => new Promise<void>(() => undefined),
				}),
			),
	})
	dispatcher.add({
		method: 'GET',
		path: '/fail-body',
		handler: () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start: (controller) => controller.enqueue(new TextEncoder().encode(BOUNDARY_FIRST_CHUNK)),
					pull: async () => {
						await waitForDelay(BOUNDARY_SLOW_MS)
						throw BOUNDARY_BODY_FAULT
					},
				}),
			),
	})
	dispatcher.add({
		method: 'GET',
		path: '/slow',
		handler: async () => {
			await waitForDelay(BOUNDARY_SLOW_MS)
			return new Response(
				new ReadableStream<Uint8Array>({
					start: (controller) => controller.enqueue(new TextEncoder().encode(BOUNDARY_FIRST_CHUNK)),
					pull: async (controller) => {
						await waitForDelay(BOUNDARY_SLOW_MS)
						controller.close()
					},
				}),
			)
		},
	})
	dispatcher.add({
		method: 'GET',
		path: '/unavailable',
		handler: async () => {
			await waitForDelay(BOUNDARY_SLOW_MS)
			throw new HTTPError(503, 'unavailable')
		},
	})
	for (const [path, status] of [
		['/late-empty', 200],
		['/late-204', 204],
	] as const) {
		dispatcher.add({
			method: 'GET',
			path,
			handler: async (request) => {
				entered.push(path)
				await waitForAbort(request.signal)
				await waitForDelay(BOUNDARY_SLOW_MS)
				entered.push(`${path} answered`)
				return new Response(null, { status })
			},
		})
	}
	dispatcher.add({ method: 'GET', path: '/answer-empty', handler: () => new Response(null) })
	return dispatcher
}

/** Reports one exchange a {@link readBoundaryRaw} call read. */
export interface BoundaryRawReply {
	/** The bytes the server sent before the connection closed or went idle. */
	readonly text: string
	/** Whether the socket went idle for the limit before the server closed it. */
	readonly idle: boolean
}

/**
 * Writes `raw` on its own connection and reads every byte until the server closes the connection,
 * or until the socket stays idle for `ms`.
 *
 * @param port - The server's bound port on `127.0.0.1`
 * @param raw - The request bytes, which ask the server to close after its answer
 * @param ms - The idle limit. Default: {@link BOUNDARY_REPLY_MS}
 * @returns The bytes, and whether the idle limit ended the read
 */
export function readBoundaryRaw(
	port: number,
	raw: string,
	ms = BOUNDARY_REPLY_MS,
): Promise<BoundaryRawReply> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = []
		const idle = new AbortController()
		const socket = net.createConnection({ host: '127.0.0.1', port }, () => socket.write(raw))
		socket.setTimeout(ms, () => {
			idle.abort()
			socket.destroy()
		})
		socket.on('data', (chunk: Buffer) => chunks.push(chunk))
		socket.on('error', () => undefined)
		socket.once('close', () =>
			resolve({ text: Buffer.concat(chunks).toString('latin1'), idle: idle.signal.aborted }),
		)
	})
}

/** Holds a request `buildRequest` refuses, a `Host` with a space, which asks to close after the answer. */
export const BOUNDARY_REFUSED_REQUEST =
	'GET / HTTP/1.1\r\nHost: foo bar\r\nConnection: close\r\n\r\n'

/** Represents one value the renderer renders: how to build it, `expose`, and the answer it gets. */
export interface BoundaryRenderCase {
	readonly label: string
	readonly build: () => unknown
	readonly expose: boolean
	readonly status: number
	readonly body: string | null
}

/**
 * Builds an `HTTPError` whose own `status` or `message` property reads through a getter that throws.
 *
 * @param member - The own property to replace: `status` or `message`
 * @param status - The status the error is constructed with
 * @returns The error
 */
export function buildThrowingHTTPError(member: 'status' | 'message', status: number): HTTPError {
	const error = new HTTPError(status, 'teapot')
	Object.defineProperty(error, member, {
		get: () => {
			throw new Error(`the ${member} accessor throws`)
		},
	})
	return error
}

/**
 * Builds a `Proxy` object over an `Error` whose handler has been revoked, so every read of it throws.
 *
 * @returns The revoked proxy
 */
export function buildRevokedProxy(): object {
	const { proxy, revoke } = Proxy.revocable(new Error('behind a revoked proxy'), {})
	revoke()
	return proxy
}

/**
 * Lists what the renderer answers for each value a boundary can catch, from the Fetch declarations:
 * an `HTTPError` whose status `Response` admits keeps it, a null body status carries a `null` body,
 * and every other value answers 500 with the hidden body, or an `Error`'s readable message under
 * `expose`.
 */
export const BOUNDARY_RENDER_CASES: readonly BoundaryRenderCase[] = Object.freeze([
	{
		label: 'an HTTPError of 404',
		build: (): unknown => new HTTPError(404, 'no such lamp'),
		expose: false,
		status: 404,
		body: 'no such lamp',
	},
	...[204, 205, 304].map((status) => ({
		label: `an HTTPError of ${String(status)}`,
		build: (): unknown => new HTTPError(status, 'no body'),
		expose: false,
		status,
		body: null,
	})),
	...[101, 600, Number.NaN, 200.5, 65_736].map((status) => ({
		label: `an HTTPError of ${String(status)} under expose`,
		build: (): unknown => new HTTPError(status, 'past the range'),
		expose: true,
		status: 500,
		body: 'past the range',
	})),
	{
		label: 'an HTTPError of 600 without expose',
		build: (): unknown => new HTTPError(600, 'past the range'),
		expose: false,
		status: 500,
		body: BOUNDARY_HIDDEN,
	},
	{
		label: 'an HTTPError whose status accessor throws',
		build: (): unknown => buildThrowingHTTPError('status', 404),
		expose: true,
		status: 500,
		body: 'teapot',
	},
	{
		label: 'an HTTPError whose message accessor throws',
		build: (): unknown => buildThrowingHTTPError('message', 404),
		expose: true,
		status: 500,
		body: BOUNDARY_HIDDEN,
	},
	{
		label: 'a revoked Proxy over an Error',
		build: buildRevokedProxy,
		expose: true,
		status: 500,
		body: BOUNDARY_HIDDEN,
	},
	{
		label: 'an Error under expose',
		build: (): unknown => new Error('database offline'),
		expose: true,
		status: 500,
		body: 'database offline',
	},
	{
		label: 'an Error without expose',
		build: (): unknown => new Error('database offline'),
		expose: false,
		status: 500,
		body: BOUNDARY_HIDDEN,
	},
	...[undefined, null, 0, '', 'thrown string', Symbol('thrown'), 10n, Number.NaN].map((value) => ({
		label: `the primitive ${String(value)}`,
		build: (): unknown => value,
		expose: true,
		status: 500,
		body: BOUNDARY_HIDDEN,
	})),
])

/** Reports one exchange a {@link readBoundaryReply} call read. */
export interface BoundaryReply {
	/** The status line's code, or `undefined` when no response arrived before the socket went idle. */
	readonly status: number | undefined
	/** The body as Node's client framed it. */
	readonly body: string
	/** Whether Node's client read the whole framed body before the connection closed. */
	readonly complete: boolean
	/** The bytes the server sent after the header block, before any framing is removed. */
	readonly wire: string
}

/**
 * Sends one `GET` on its own connection, with `Connection: close`, and reads the reply both as
 * Node's client frames it and as the bytes after the header block.
 *
 * @remarks
 * A socket idle for `ms` is destroyed, so an exchange the server never answers reads as a reply
 * with no status rather than a hang.
 *
 * @param port - The server's bound port on `127.0.0.1`
 * @param path - The request path
 * @param ms - The idle limit. Default: {@link BOUNDARY_REPLY_MS}
 * @returns The reply
 */
export function readBoundaryReply(
	port: number,
	path: string,
	ms = BOUNDARY_REPLY_MS,
): Promise<BoundaryReply> {
	return new Promise((resolve) => {
		const raw: Buffer[] = []
		const chunks: Buffer[] = []
		const request = http.get({
			host: '127.0.0.1',
			port,
			path,
			agent: false,
			timeout: ms,
			headers: { connection: 'close' },
		})
		request.once('socket', (socket) => socket.on('data', (chunk: Buffer) => raw.push(chunk)))
		request.once('timeout', () => request.destroy())
		request.once('error', () => resolve({ status: undefined, body: '', complete: false, wire: '' }))
		request.once('response', (message) => {
			message.on('data', (chunk: Buffer) => chunks.push(chunk))
			message.on('error', () => undefined)
			message.once('close', () => {
				const bytes = Buffer.concat(raw).toString('latin1')
				const end = bytes.indexOf('\r\n\r\n')
				resolve({
					status: message.statusCode,
					body: Buffer.concat(chunks).toString('utf8'),
					complete: message.complete,
					wire: end === -1 ? '' : bytes.slice(end + 4),
				})
			})
		})
	})
}

/**
 * Reads the reply to every path, {@link BOUNDARY_WIDTH} connections at a time.
 *
 * @param port - The server's bound port on `127.0.0.1`
 * @param paths - The request paths
 * @returns The replies, in path order
 */
export async function readBoundaryReplies(
	port: number,
	paths: readonly string[],
): Promise<readonly BoundaryReply[]> {
	const groups = Array.from({ length: Math.ceil(paths.length / BOUNDARY_WIDTH) }, (_, index) =>
		paths.slice(index * BOUNDARY_WIDTH, (index + 1) * BOUNDARY_WIDTH),
	)
	return groups.reduce<Promise<readonly BoundaryReply[]>>(
		async (previous, group) => [
			...(await previous),
			...(await Promise.all(group.map((path) => readBoundaryReply(port, path)))),
		],
		Promise.resolve([]),
	)
}

/**
 * Opens a `GET` on its own connection and destroys it after the route has started, so the peer
 * disconnects before any response.
 *
 * @param port - The server's bound port on `127.0.0.1`
 * @param path - The request path
 * @param entered - The log the route appends its path to as it starts
 * @returns A promise that settles after the client socket closes
 */
export async function abandonBoundaryRequest(
	port: number,
	path: string,
	entered: readonly string[],
): Promise<void> {
	const before = entered.filter((member) => member === path).length
	const request = http.get({ host: '127.0.0.1', port, path, agent: false })
	request.on('error', () => undefined)
	await waitForCondition(
		`the ${path} route starts`,
		() => entered.filter((member) => member === path).length > before,
	)
	const closed = waitForEvent<readonly []>((listener) => {
		request.once('close', listener)
	}, `the ${path} request closes`)
	request.destroy()
	await closed
}

/**
 * Opens a `POST /upload` that declares a body longer than it sends, and destroys it after the route
 * has started reading, so the peer disconnects in the middle of the body.
 *
 * @param port - The server's bound port on `127.0.0.1`
 * @param entered - The log the route appends its path to as it starts
 * @returns A promise that settles after the client socket closes
 */
export async function abandonBoundaryUpload(
	port: number,
	entered: readonly string[],
): Promise<void> {
	const before = entered.filter((member) => member === '/upload').length
	const socket = net.createConnection({ host: '127.0.0.1', port })
	socket.on('error', () => undefined)
	await once(socket, 'connect')
	socket.write('POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 1000\r\n\r\nten bytes.')
	await waitForCondition(
		'the /upload route starts',
		() => entered.filter((member) => member === '/upload').length > before,
	)
	socket.destroy()
	await once(socket, 'close')
}

/**
 * Opens a `GET /trickle`, reads its first chunk, and destroys the connection, so the peer
 * disconnects after the headers and before the end of the body.
 *
 * @param port - The server's bound port on `127.0.0.1`
 * @returns The text the client read before it disconnected
 */
export async function abandonBoundaryBody(port: number): Promise<string> {
	const request = http.get({ host: '127.0.0.1', port, path: '/trickle', agent: false })
	request.on('error', () => undefined)
	const [message] = await once(request, 'response')
	if (!(message instanceof http.IncomingMessage)) throw new Error('no response to GET /trickle')
	message.on('error', () => undefined)
	const [chunk] = await once(message, 'data')
	const closed = waitForEvent<readonly []>((listener) => {
		request.once('close', listener)
	}, 'the /trickle request closes')
	request.destroy()
	await closed
	return chunk instanceof Buffer ? chunk.toString('utf8') : ''
}

// ── The server matrix ────────────────────────────────────────────────────────
//
// The fixtures `tests/src/server/integration.test.ts` drives the server matrix with. Each cell feeds
// a real `Server` and a bare `node:http` control the same bytes over raw sockets, frames what each
// answered with the raw client's own parse, and reads from the client whether the server closed
// the connection. The expectation is the control's answer or the declared contract, never the code.

/** Represents one HTTP/1.1 response a raw client framed from the bytes it read. */
export interface ServerRawResponse {
	readonly status: number
	readonly headers: Readonly<Record<string, string>>
	readonly body: string
	readonly complete: boolean
}

/** Represents one framed body and the offset where its framing ended. */
export interface ServerFramedBody {
	readonly body: string
	readonly complete: boolean
	readonly end: number
}

/**
 * Decodes a chunked body from raw response bytes, stopping where its framing stops.
 *
 * @remarks
 * The last chunk ends at the blank line after its trailer section, which may hold fields.
 *
 * @param bytes - The raw bytes the client read
 * @param offset - Where the next chunk-size line starts
 * @returns The decoded body, whether the last chunk arrived, and the offset after it
 */
export function decodeServerChunks(bytes: Buffer, offset: number): ServerFramedBody {
	const line = bytes.indexOf('\r\n', offset)
	if (line < 0) return { body: '', complete: false, end: bytes.length }
	const size = Number.parseInt(bytes.subarray(offset, line).toString('latin1'), 16)
	if (size === 0) {
		const trailer = bytes.indexOf('\r\n\r\n', line)
		return trailer < 0
			? { body: '', complete: false, end: bytes.length }
			: { body: '', complete: true, end: trailer + 4 }
	}
	const data = line + 2 + size
	const part = bytes.subarray(line + 2, Math.min(data, bytes.length)).toString()
	if (bytes.length < data + 2) return { body: part, complete: false, end: bytes.length }
	const rest = decodeServerChunks(bytes, data + 2)
	return { body: part + rest.body, complete: rest.complete, end: rest.end }
}

/**
 * Frames one response body that starts at `start`, by the framing its status and headers declare.
 *
 * @remarks
 * Follows RFC 9112 section 6.3: a response to `HEAD`, and a 1xx, 204, or 304 response, ends at the
 * blank line whatever its framing headers say; then chunked, then `Content-Length`; any other
 * response runs to the end of the connection, so it is complete only after the connection closed.
 *
 * @param bytes - The raw bytes the client read
 * @param start - Where the body starts
 * @param status - The response status
 * @param headers - The response headers, keyed in lower case
 * @param closed - If `true`, the connection closed after `bytes`; if `false`, it is open
 * @param head - If `true`, the response answers a `HEAD` request; if `false`, any other method
 * @returns The body, whether its framing ended, and the offset after it
 */
export function frameServerBody(
	bytes: Buffer,
	start: number,
	status: number,
	headers: Readonly<Record<string, string>>,
	closed: boolean,
	head: boolean,
): ServerFramedBody {
	if (head || status < 200 || status === 204 || status === 304)
		return { body: '', complete: true, end: start }
	if (headers['transfer-encoding'] === 'chunked') return decodeServerChunks(bytes, start)
	const length = headers['content-length']
	if (length !== undefined) {
		const end = start + Number(length)
		return {
			body: bytes.subarray(start, end).toString(),
			complete: bytes.length >= end,
			end,
		}
	}
	return { body: bytes.subarray(start).toString(), complete: closed, end: bytes.length }
}

/**
 * Frames HTTP/1.1 responses from the raw bytes a client read, in wire order.
 *
 * @remarks
 * An interim 1xx response answers the same request as the response after it, so it takes no
 * method from `methods`. The last response is returned incomplete while its framing is open, and
 * bytes that hold no complete status line and header block frame as nothing.
 *
 * @param bytes - The raw bytes the client read
 * @param closed - If `true`, the connection closed after `bytes`; if `false`, it is open
 * @param methods - The request methods the responses answer, in order; a missing one reads as `GET`
 * @param offset - Where the next status line starts
 * @returns Each response, in wire order
 */
export function parseResponses(
	bytes: Buffer,
	closed: boolean,
	methods: readonly string[],
	offset = 0,
): readonly ServerRawResponse[] {
	const head = bytes.indexOf('\r\n\r\n', offset)
	if (head < 0) return []
	const [line = '', ...fields] = bytes.subarray(offset, head).toString('latin1').split('\r\n')
	const status = Number(line.split(' ')[1])
	const headers = Object.fromEntries(
		fields.map((field) => {
			const colon = field.indexOf(':')
			return [field.slice(0, colon).trim().toLowerCase(), field.slice(colon + 1).trim()]
		}),
	)
	const framed = frameServerBody(bytes, head + 4, status, headers, closed, methods[0] === 'HEAD')
	const response = { status, headers, body: framed.body, complete: framed.complete }
	const rest = status < 200 ? methods : methods.slice(1)
	return framed.complete
		? [response, ...parseResponses(bytes, closed, rest, framed.end)]
		: [response]
}

/** Represents the framing class of what one connection answered: each complete status, and the close. */
export interface ServerFraming {
	readonly statuses: readonly number[]
	readonly closed: boolean
}

/** Drives one raw TCP connection, frames what it reads, and records when the peer closed it. */
export class ServerRawClient {
	readonly #socket: net.Socket
	readonly #methods: readonly string[]
	readonly #chunks: Buffer[] = []
	readonly #closed = Promise.withResolvers<number>()

	constructor(socket: net.Socket, methods: readonly string[]) {
		this.#socket = socket
		this.#methods = methods
		socket.on('data', (chunk: Buffer) => {
			this.#chunks.push(chunk)
		})
		socket.on('error', () => undefined)
		socket.once('close', () => this.#closed.resolve(performance.now()))
	}

	/** Lists every response read so far, the last one incomplete while its framing is open. */
	get responses(): readonly ServerRawResponse[] {
		return parseResponses(Buffer.concat(this.#chunks), this.closed, this.#methods)
	}

	/** Lists the responses whose framing ended. */
	get complete(): readonly ServerRawResponse[] {
		return this.responses.filter((response) => response.complete)
	}

	/** Reports whether the connection closed. */
	get closed(): boolean {
		return this.#socket.closed
	}

	/** Resolves with the `performance.now()` reading taken when the connection closed. */
	get ended(): Promise<number> {
		return this.#closed.promise
	}

	/** Writes raw request bytes. */
	write(data: string): void {
		this.#socket.write(data)
	}

	/** Writes `count` copies of `piece`, waiting `gap` milliseconds after each, while the socket is open. */
	async drip(piece: string, count: number, gap: number): Promise<void> {
		if (count === 0 || this.#socket.destroyed) return
		this.#socket.write(piece)
		await waitForDelay(gap)
		await this.drip(piece, count - 1, gap)
	}

	/** Waits until `count` complete responses arrived or the connection closed. */
	async wait(count: number, description: string, budget = 2_000): Promise<void> {
		await waitForCondition(description, () => this.closed || this.complete.length >= count, {
			budget,
		})
	}

	/**
	 * Waits for `count` complete responses, then for the close the last one announces with
	 * `Connection: close`, and reads the framing class.
	 */
	async classify(count: number, description: string): Promise<ServerFraming> {
		await this.wait(count, description)
		if (this.complete.at(-1)?.headers.connection === 'close')
			await waitForCondition(`${description}: the announced close`, () => this.closed)
		return {
			statuses: this.complete.map((response) => response.status),
			closed: this.closed,
		}
	}

	/** Closes the connection from the client side. */
	destroy(): void {
		this.#socket.destroy()
	}

	/** Resets the connection from the client side, so the peer reads `ECONNRESET`. */
	reset(): void {
		this.#socket.resetAndDestroy()
	}
}

/**
 * Opens a raw TCP connection on `127.0.0.1`.
 *
 * @param port - The server's port
 * @param methods - The request methods the client sends, in order, which frame each response
 * @returns A connected {@link ServerRawClient}
 */
export async function connectServerClient(
	port: number,
	methods: readonly string[] = [],
): Promise<ServerRawClient> {
	const socket = net.createConnection({ port, host: '127.0.0.1' })
	const client = new ServerRawClient(socket, methods)
	await once(socket, 'connect')
	return client
}

/**
 * Builds the dispatcher the server matrix routes into.
 *
 * @remarks
 * `GET /a` and `GET /b` answer `ok`; `POST /a` and `POST /b` read the whole body and answer `ok`.
 *
 * @returns The dispatcher
 */
export function createMatrixDispatcher<TState>(): DispatcherInterface<TState> {
	const dispatcher = createDispatcher<TState>()
	for (const path of ['/a', '/b']) {
		dispatcher.add({ method: 'GET', path, handler: () => new Response('ok') })
		dispatcher.add({
			method: 'POST',
			path,
			handler: async (request) => {
				await request.text()
				return new Response('ok')
			},
		})
	}
	return dispatcher
}

/**
 * Creates the bare `node:http` control of the server matrix: it reads each request body whole
 * and answers `200` with `ok`.
 *
 * @param options - The `node:http` server options the control runs under
 * @param calls - The recorder each request that reaches the handler is recorded on
 * @returns The unstarted control
 */
export function createMatrixControl(
	options: http.ServerOptions,
	calls: RecorderInterface<[string | undefined]>,
): http.Server {
	return http.createServer(options, async (request, response) => {
		calls.handler(request.url)
		try {
			for await (const part of request) void part
			response.end('ok')
		} catch {
			response.destroy()
		}
	})
}

/**
 * Holds the checking interval the timeout control runs under, in milliseconds: fine enough that
 * the control answers close to its configured timeout.
 */
export const SERVER_CONTROL_INTERVAL = 10

/**
 * Holds the scheduling allowance a timeout cell adds to its window's end on a loaded host, in
 * milliseconds.
 */
export const SERVER_TIMEOUT_SLACK = 500

/** Holds the gap between two drip writes of a timeout cell, in milliseconds. */
export const SERVER_DRIP_GAP = 50

/**
 * Holds the timeouts the timeout cells configure: `headers` below `request`, so each cell reads
 * the timeout it names.
 */
export const SERVER_MATRIX_TIMEOUTS = Object.freeze({ headers: 400, request: 800, keepalive: 400 })

/**
 * Maps `timeouts` keys onto the `node:http` options they name, for the control.
 *
 * @param timeouts - The `ServerOptions.timeouts` keys to map
 * @param interval - The control's `connectionsCheckingInterval`
 * @returns The `node:http` server options
 */
export function buildControlOptions(
	timeouts: { readonly headers?: number; readonly request?: number; readonly keepalive?: number },
	interval?: number,
): http.ServerOptions {
	return {
		...(timeouts.headers === undefined ? {} : { headersTimeout: timeouts.headers }),
		...(timeouts.request === undefined ? {} : { requestTimeout: timeouts.request }),
		...(timeouts.keepalive === undefined ? {} : { keepAliveTimeout: timeouts.keepalive }),
		...(interval === undefined ? {} : { connectionsCheckingInterval: interval }),
	}
}

/** Represents the framing class of one timeout cell's connection and the milliseconds until it closed. */
export interface ServerTimedFraming {
	readonly framing: ServerFraming
	readonly elapsed: number
}

/**
 * Writes `head`, then drips `piece` every {@link SERVER_DRIP_GAP} milliseconds until the server
 * closes the connection, and reads the framing class and the time from the first write to the close.
 *
 * @param port - The server's port on `127.0.0.1`
 * @param head - The bytes written first
 * @param piece - The bytes each drip writes
 * @param budget - The milliseconds the close may take
 * @returns The framing class and the elapsed milliseconds
 */
export async function driveServerDrip(
	port: number,
	head: string,
	piece: string,
	budget: number,
): Promise<ServerTimedFraming> {
	const client = await connectServerClient(port)
	try {
		const start = performance.now()
		client.write(head)
		void client.drip(piece, Math.ceil(budget / SERVER_DRIP_GAP) + 1, SERVER_DRIP_GAP)
		await waitForCondition('the server closes the dripping connection', () => client.closed, {
			budget,
		})
		const elapsed = (await client.ended) - start
		return {
			framing: { statuses: client.complete.map((response) => response.status), closed: true },
			elapsed,
		}
	} finally {
		client.destroy()
	}
}

/**
 * Sends one `GET /a`, reads its answer whole, and reads the framing class and the time from the
 * answer to the server's close of the idle connection.
 *
 * @param port - The server's port on `127.0.0.1`
 * @param budget - The milliseconds the close may take after the answer
 * @returns The framing class and the elapsed milliseconds
 */
export async function driveServerIdle(port: number, budget: number): Promise<ServerTimedFraming> {
	const client = await connectServerClient(port, ['GET'])
	try {
		client.write('GET /a HTTP/1.1\r\nHost: x\r\n\r\n')
		await client.wait(1, 'the idle cell answer')
		const start = performance.now()
		await waitForCondition('the server closes the idle connection', () => client.closed, {
			budget,
		})
		const elapsed = (await client.ended) - start
		return {
			framing: { statuses: client.complete.map((response) => response.status), closed: true },
			elapsed,
		}
	} finally {
		client.destroy()
	}
}

/** Represents one timeout relation row: the `timeouts` given and whether construction refuses them. */
export interface ServerTimeoutRelation {
	readonly label: string
	readonly timeouts: {
		readonly headers?: number
		readonly request?: number
		readonly keepalive?: number
	}
	readonly refused: boolean
}

/**
 * Lists the edges of Node's `headersTimeout ≤ requestTimeout` relation, which holds while
 * `requestTimeout` is positive, and the refusals of the former `headers ≤ keepalive` check.
 * `requestTimeout` defaults to `300_000`, and an omitted `headersTimeout` to the lesser of
 * `60_000` and `requestTimeout`.
 */
export const SERVER_TIMEOUT_RELATIONS: readonly ServerTimeoutRelation[] = Object.freeze([
	{ label: 'headers equal to request', timeouts: { headers: 500, request: 500 }, refused: false },
	{ label: 'headers one above request', timeouts: { headers: 501, request: 500 }, refused: true },
	{ label: 'headers above a request of 0', timeouts: { headers: 501, request: 0 }, refused: false },
	{
		label: 'headers of 0 beside a request',
		timeouts: { headers: 0, request: 500 },
		refused: false,
	},
	{ label: 'headers and request of 0', timeouts: { headers: 0, request: 0 }, refused: false },
	{ label: 'headers at the default request', timeouts: { headers: 300_000 }, refused: false },
	{ label: 'headers one above the default request', timeouts: { headers: 300_001 }, refused: true },
	{ label: 'request alone below the header default', timeouts: { request: 1_000 }, refused: false },
	{ label: 'request of 0 alone', timeouts: { request: 0 }, refused: false },
	{
		label: 'headers above keepalive, a former refusal',
		timeouts: { headers: 5_000, keepalive: 1_000 },
		refused: false,
	},
	{
		label: 'headers one above keepalive, a former refusal',
		timeouts: { headers: 1_001, keepalive: 1_000 },
		refused: false,
	},
])

/** Represents one `timeouts` value construction refuses, and the key the refusal names. */
export interface ServerTimeoutRefusal {
	readonly key: 'headers' | 'request' | 'keepalive'
	readonly value: number
	readonly limit: string
}

/**
 * Lists the values each `node:http` timeout key refuses: off-integer, negative, `NaN`, infinite,
 * and one past its limit. `headers` and `request` stop at the 2_147_483_647 timer limit;
 * `keepalive` stops 1_000 below it, because Node arms it plus its default 1_000 ms
 * `keepAliveTimeoutBuffer` as one timer.
 */
export const SERVER_TIMEOUT_REFUSALS: readonly ServerTimeoutRefusal[] = Object.freeze([
	...(['headers', 'request'] as const).flatMap((key) =>
		[1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648].map((value) => ({
			key,
			value,
			limit: '2_147_483_647',
		})),
	),
	...[1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_482_648, 2_147_483_647].map((value) => ({
		key: 'keepalive' as const,
		value,
		limit: '2_147_482_647',
	})),
])

/** Represents one `timeouts` value and the `connectionsCheckingInterval` Node must read under it. */
export interface ServerIntervalCase {
	readonly label: string
	readonly target: string
	readonly timeouts: {
		readonly headers?: number
		readonly request?: number
	}
	readonly interval: number
}

/**
 * Lists the checking intervals `Server` must hand Node: half the smaller positive of `headers`
 * and `request` as Node applies them, rounded up, and Node's own 30_000 when neither is positive.
 * Node's `request` defaults to 300_000 and its `headers` to the lesser of 60_000 and `request`.
 * Each `target` is the request target the case's capture is keyed by.
 */
export const SERVER_INTERVAL_CASES: readonly ServerIntervalCase[] = Object.freeze([
	{
		label: 'the matrix timeouts, headers 400 and request 800',
		target: '/a?interval=matrix',
		timeouts: { headers: 400, request: 800 },
		interval: 200,
	},
	{
		label: 'an odd headers of 401 below request 800',
		target: '/a?interval=odd',
		timeouts: { headers: 401, request: 800 },
		interval: 201,
	},
	{
		label: 'headers 0 beside request 803',
		target: '/a?interval=request',
		timeouts: { headers: 0, request: 803 },
		interval: 402,
	},
	{
		label: 'request 1_000 alone, which caps the header default',
		target: '/a?interval=capped',
		timeouts: { request: 1_000 },
		interval: 500,
	},
	{
		label: 'headers 120_000 alone, below the request default',
		target: '/a?interval=headers',
		timeouts: { headers: 120_000 },
		interval: 60_000,
	},
	{
		label: 'no timeouts, Node defaults',
		target: '/a?interval=none',
		timeouts: {},
		interval: 30_000,
	},
	{
		label: 'request 0 alone, which disables both',
		target: '/a?interval=disabled',
		timeouts: { request: 0 },
		interval: 30_000,
	},
])

/** Represents one input of the framing differential. */
export interface ServerFramingInput {
	readonly label: string
	readonly raw: string
	readonly rest: string | undefined
	readonly methods: readonly string[]
	readonly count: number
}

/**
 * Lists the inputs the `Server` arm and the bare control must frame alike.
 *
 * @remarks
 * `rest` is written after the first complete response, the interim `100 Continue`. `count` is the
 * number of complete responses each arm waits for before its class is read. The oversized header
 * block passes the `16_384` bytes of Node's default `maxHeaderSize`.
 */
export const SERVER_FRAMING_INPUTS: readonly ServerFramingInput[] = Object.freeze([
	{
		label: 'a pipelined pair',
		raw: 'GET /a HTTP/1.1\r\nHost: x\r\n\r\nGET /b HTTP/1.1\r\nHost: x\r\n\r\n',
		rest: undefined,
		methods: ['GET', 'GET'],
		count: 2,
	},
	{
		label: 'Content-Length beside Transfer-Encoding',
		raw: 'POST /a HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n',
		rest: undefined,
		methods: ['POST'],
		count: 1,
	},
	{
		label: 'two Content-Length values',
		raw: 'POST /a HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\nhello!',
		rest: undefined,
		methods: ['POST'],
		count: 1,
	},
	{
		label: 'an obsolete line fold',
		raw: 'GET /a HTTP/1.1\r\nHost: x\r\nX-Folded: one\r\n two\r\n\r\n',
		rest: undefined,
		methods: ['GET'],
		count: 1,
	},
	{
		label: 'a bare LF',
		raw: 'GET /a HTTP/1.1\nHost: x\n\n',
		rest: undefined,
		methods: ['GET'],
		count: 1,
	},
	{
		label: 'an oversized header block',
		raw: `GET /a HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(20_000)}\r\n\r\n`,
		rest: undefined,
		methods: ['GET'],
		count: 1,
	},
	{
		label: 'Expect: 100-continue',
		raw: 'POST /a HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nExpect: 100-continue\r\n\r\n',
		rest: 'hello',
		methods: ['POST'],
		count: 2,
	},
	{
		label: 'an unknown Expect',
		raw: 'POST /a HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nExpect: something-else\r\n\r\n',
		rest: undefined,
		methods: ['POST'],
		count: 1,
	},
])

/**
 * Feeds one framing input to a connection and reads the framing class of what it answered.
 *
 * @param port - The server's port on `127.0.0.1`
 * @param input - The framing input
 * @returns The framing class
 */
export async function frameServerInput(
	port: number,
	input: ServerFramingInput,
): Promise<ServerFraming> {
	const client = await connectServerClient(port, input.methods)
	try {
		client.write(input.raw)
		if (input.rest !== undefined) {
			await client.wait(1, `${input.label}: the interim response`)
			client.write(input.rest)
		}
		return await client.classify(input.count, input.label)
	} finally {
		client.destroy()
	}
}

/** Represents the listeners per event on one message and one response. */
export interface ServerListenerReading {
	readonly message: Readonly<Record<string, number>>
	readonly response: Readonly<Record<string, number>>
}

/**
 * Counts the listeners on `emitter` per event name.
 *
 * @param emitter - The emitter to read
 * @returns Each string event name with listeners, mapped to its listener count
 */
export function countServerListeners(
	emitter: NodeJS.EventEmitter,
): Readonly<Record<string, number>> {
	return Object.fromEntries(
		emitter
			.eventNames()
			.filter((name) => typeof name === 'string')
			.map((name) => [name, emitter.listenerCount(name)]),
	)
}

/**
 * Subtracts `control`'s listener counts from `arm`'s per event, keeping each event either holds.
 *
 * @param arm - The counts of the arm under test
 * @param control - The counts of the control arm
 * @returns The difference per event
 */
export function subtractServerListeners(
	arm: Readonly<Record<string, number>>,
	control: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
	const names = [...new Set([...Object.keys(arm), ...Object.keys(control)])].toSorted()
	return Object.fromEntries(names.map((name) => [name, (arm[name] ?? 0) - (control[name] ?? 0)]))
}

/**
 * Captures the message, the response, and the live `node:http` server of each exchange a server
 * starts, keyed by request target, through the `http.server.request.start` diagnostics channel.
 */
export class ServerExchanges {
	readonly #pairs = new Map<string, readonly [IncomingMessage, http.ServerResponse]>()
	readonly #servers = new Map<string, http.Server>()
	readonly #subscriber: (message: unknown) => void

	constructor() {
		this.#subscriber = this.#record.bind(this)
		diagnostics.subscribe('http.server.request.start', this.#subscriber)
	}

	/** Returns the message and the response of the exchange for `target`, or `undefined`. */
	exchange(target: string): readonly [IncomingMessage, http.ServerResponse] | undefined {
		return this.#pairs.get(target)
	}

	/** Returns the live `node:http` server that started the exchange for `target`, or `undefined`. */
	server(target: string): http.Server | undefined {
		return this.#servers.get(target)
	}

	/** Stops capturing. */
	destroy(): void {
		diagnostics.unsubscribe('http.server.request.start', this.#subscriber)
	}

	#record(message: unknown): void {
		if (!isRecord(message)) return
		const { request, response, server } = message
		if (!(request instanceof http.IncomingMessage) || !(response instanceof http.ServerResponse))
			return
		if (request.url === undefined) return
		this.#pairs.set(request.url, [request, response])
		if (server instanceof http.Server) this.#servers.set(request.url, server)
	}
}

/**
 * Builds a dispatcher whose `GET /count/:arm` route reads the listeners on its exchange's message
 * and response as the handler starts.
 *
 * @param exchanges - The capture that holds each exchange's message and response
 * @param readings - The recorder each reading is recorded on, with its request target
 * @returns The dispatcher
 */
export function createCountingDispatcher<TState>(
	exchanges: ServerExchanges,
	readings: RecorderInterface<[string, ServerListenerReading]>,
): DispatcherInterface<TState> {
	const dispatcher = createDispatcher<TState>()
	dispatcher.add({
		method: 'GET',
		path: '/count/:arm',
		handler: (request) => {
			const target = new URL(request.url).pathname
			const pair = exchanges.exchange(target)
			if (pair !== undefined) {
				readings.handler(target, {
					message: countServerListeners(pair[0]),
					response: countServerListeners(pair[1]),
				})
			}
			return new Response('counted')
		},
	})
	return dispatcher
}

/**
 * Creates the router-only control of the listener row: a bare `node:http` server that builds the
 * exchange's `Request` with `buildRequest` and writes the dispatcher's answer with `sendResponse`,
 * the calls `Server` makes, and attaches nothing else.
 *
 * @param dispatcher - The dispatcher the control routes into
 * @returns The unstarted control
 */
export function createRouterControl(dispatcher: DispatcherInterface<undefined>): http.Server {
	return http.createServer(async (message, response) => {
		const exchange = new AbortController()
		const request = buildRequest(message, { response, signal: exchange.signal })
		await sendResponse(await dispatcher.handle(request, undefined), response).catch(() => undefined)
	})
}

/**
 * Builds the dispatcher of the routed cells: `GET /items` answers `items` from a stream body
 * whose cancellation is recorded, with `Content-Type` and `X-Items` headers.
 *
 * @param cancels - The recorder each cancellation of a body source is recorded on
 * @returns The dispatcher
 */
export function createRoutedDispatcher<TState>(
	cancels: RecorderInterface<[unknown]>,
): DispatcherInterface<TState> {
	const dispatcher = createDispatcher<TState>()
	dispatcher.add({
		method: 'GET',
		path: '/items',
		handler: () =>
			new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						controller.enqueue(new TextEncoder().encode('items'))
						controller.close()
					},
					cancel(reason) {
						cancels.handler(reason)
					},
				}),
				{ headers: { 'Content-Type': 'text/plain', 'X-Items': 'listed' } },
			),
	})
	return dispatcher
}

/**
 * Creates the bare `node:http` control of the routed cells: `GET /items` answers `items` with the
 * routed headers, and `HEAD /items` answers the same headers with no body.
 *
 * @returns The unstarted control
 */
export function createRoutedControl(): http.Server {
	return http.createServer((request, response) => {
		response.writeHead(200, { 'Content-Type': 'text/plain', 'X-Items': 'listed' })
		if (request.method === 'HEAD') response.end()
		else {
			response.write('items')
			response.end()
		}
	})
}

/**
 * Removes the fields that frame a message or vary per response from a header record: `date`,
 * `transfer-encoding`, and `content-length`.
 *
 * @param headers - The response headers, keyed in lower case
 * @returns The remaining headers
 */
export function filterServerHeaders(
	headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
	return Object.fromEntries(
		Object.entries(headers).filter(
			([name]) => !['date', 'transfer-encoding', 'content-length'].includes(name),
		),
	)
}

/** Lists the signer fixture's secrets in `[current, ...older]` order. */
export const SIGNER_SECRETS: readonly string[] = Object.freeze([
	'current-signing-secret-2026-11',
	'previous-signing-secret-2026-10',
	'oldest-signing-secret-2026-09',
])

/** Holds a secret that no signer fixture lists. */
export const SIGNER_UNLISTED_SECRET = 'unlisted-signing-secret-2026-08'

/** Represents one token the base build (`a2632ed`) minted without a `ttl`. */
export interface ServerBaseToken {
	readonly label: string
	readonly value: string
	readonly secret: TokenSecret
	readonly token: string
}

/**
 * Lists tokens the base build (`a2632ed`) minted through `signToken(value, { secret })`, at the
 * current fixture secret and at the whole rotation list, which signs with the same current secret.
 */
export const SERVER_BASE_TOKENS: readonly ServerBaseToken[] = Object.freeze([
	{
		label: 'a session id, one secret',
		value: '6f1c2a8e-4b7d-4e90-9a35-0d2f8b61c7e4',
		secret: 'current-signing-secret-2026-11',
		token:
			'eyJ2YWx1ZSI6IjZmMWMyYThlLTRiN2QtNGU5MC05YTM1LTBkMmY4YjYxYzdlNCJ9.RRU6plw_YrH87aYkppXcu-2M3fYpeDutAaXvLTMpJu0',
	},
	{
		label: 'a session id, a rotation list',
		value: '6f1c2a8e-4b7d-4e90-9a35-0d2f8b61c7e4',
		secret: SIGNER_SECRETS,
		token:
			'eyJ2YWx1ZSI6IjZmMWMyYThlLTRiN2QtNGU5MC05YTM1LTBkMmY4YjYxYzdlNCJ9.RRU6plw_YrH87aYkppXcu-2M3fYpeDutAaXvLTMpJu0',
	},
	{
		label: 'a value with dots, one secret',
		value: 'a.b.c',
		secret: 'current-signing-secret-2026-11',
		token: 'eyJ2YWx1ZSI6ImEuYi5jIn0.VMe9ZcVYM-_R2OqWO9Ff-E1a1tCmruuhUjRZMkQbenU',
	},
	{
		label: 'a value with dots, a rotation list',
		value: 'a.b.c',
		secret: SIGNER_SECRETS,
		token: 'eyJ2YWx1ZSI6ImEuYi5jIn0.VMe9ZcVYM-_R2OqWO9Ff-E1a1tCmruuhUjRZMkQbenU',
	},
	{
		label: 'an empty value, one secret',
		value: '',
		secret: 'current-signing-secret-2026-11',
		token: 'eyJ2YWx1ZSI6IiJ9.dZkkYP_UBJzKCNywUKdN-SxXfZToEchVNcX0T0i19Zc',
	},
	{
		label: 'an empty value, a rotation list',
		value: '',
		secret: SIGNER_SECRETS,
		token: 'eyJ2YWx1ZSI6IiJ9.dZkkYP_UBJzKCNywUKdN-SxXfZToEchVNcX0T0i19Zc',
	},
	{
		label: 'non-ASCII text, one secret',
		value: 'café ☕',
		secret: 'current-signing-secret-2026-11',
		token: 'eyJ2YWx1ZSI6ImNhZsOpIOKYlSJ9.K2oYtguiIalwmZpTzsHXZ33C4-fQMbujw4WpfhUAGEY',
	},
	{
		label: 'non-ASCII text, a rotation list',
		value: 'café ☕',
		secret: SIGNER_SECRETS,
		token: 'eyJ2YWx1ZSI6ImNhZsOpIOKYlSJ9.K2oYtguiIalwmZpTzsHXZ33C4-fQMbujw4WpfhUAGEY',
	},
	{
		label: 'a lone surrogate, one secret',
		value: '\ud800',
		secret: 'current-signing-secret-2026-11',
		token: 'eyJ2YWx1ZSI6Ilx1ZDgwMCJ9.GSHkkDDDIYCfEW6Y-OvBVmv5i90aSpp9t3xLAHsoo1Y',
	},
	{
		label: 'a lone surrogate, a rotation list',
		value: '\ud800',
		secret: SIGNER_SECRETS,
		token: 'eyJ2YWx1ZSI6Ilx1ZDgwMCJ9.GSHkkDDDIYCfEW6Y-OvBVmv5i90aSpp9t3xLAHsoo1Y',
	},
])

/** Represents one secret `createSigner` refuses with code `'SECRET'`. */
export interface SignerRefusalCase {
	readonly label: string
	readonly secret: unknown
}

/** Lists the secrets `createSigner` refuses: off-type, empty, or holding a blank entry. */
export const SIGNER_REFUSED_SECRETS: readonly SignerRefusalCase[] = Object.freeze([
	{ label: 'an empty string', secret: '' },
	{ label: 'a whitespace-only string', secret: ' \t\n' },
	{ label: 'a no-break space', secret: SERVER_NBSP },
	{ label: 'an empty list', secret: [] },
	{ label: 'a list of only blank entries', secret: ['', '   '] },
	{
		label: 'a list with one blank entry',
		secret: ['current-signing-secret-2026-11', ' ', 'oldest-signing-secret-2026-09'],
	},
	{ label: 'a list with a blank current entry', secret: ['', 'previous-signing-secret-2026-10'] },
	{ label: 'a list with a number entry', secret: ['current-signing-secret-2026-11', 7] },
	{ label: 'a number', secret: 42 },
	{ label: 'a boolean', secret: true },
	{ label: 'undefined', secret: undefined },
	{ label: 'null', secret: null },
	{ label: 'a record', secret: { secret: 'current-signing-secret-2026-11' } },
	{ label: 'bytes', secret: new TextEncoder().encode('current-signing-secret-2026-11') },
	{ label: 'a String object', secret: Object('current-signing-secret-2026-11') },
])

/** Represents one signature `verify` refuses before it reads a key. */
export interface SignerMalformedCase {
	readonly label: string
	readonly signature: string
}

/** Holds Node's default `http.maxHeaderSize`, the longest header a request can carry, in bytes. */
export const SIGNER_HEADER_LIMIT = 16_384

/**
 * Builds the signatures that are not canonical base64url or do not decode to the 32 bytes of an
 * HMAC-SHA256, each derived from a valid signature.
 *
 * @param valid - A canonical base64url HMAC-SHA256 signature
 * @returns The malformed class table
 */
export function buildMalformedSignatures(valid: string): readonly SignerMalformedCase[] {
	return Object.freeze([
		{ label: 'an empty signature', signature: '' },
		{ label: 'one character', signature: valid.slice(0, 1) },
		{ label: 'the last character dropped', signature: valid.slice(0, -1) },
		{ label: 'a character appended', signature: `${valid}A` },
		{ label: 'a padding character appended', signature: `${valid}=` },
		{
			label: 'the standard alphabet',
			signature: `+/${valid.slice(2)}`,
		},
		{ label: 'a leading space', signature: ` ${valid}` },
		{ label: 'a trailing space', signature: `${valid} ` },
		{ label: 'a lone high surrogate', signature: `${valid.slice(0, 20)}\ud800${valid.slice(21)}` },
		{ label: 'a lone low surrogate appended', signature: `${valid}\udc00` },
		// `B` sets a trailing bit that a canonical final character of a 32-byte value leaves clear.
		{ label: 'non-canonical trailing bits', signature: `${valid.slice(0, -1)}B` },
		{ label: '31 bytes', signature: encodeBase64URL(new Uint8Array(31).fill(7)) },
		{ label: '33 bytes', signature: encodeBase64URL(new Uint8Array(33).fill(7)) },
		{ label: '64 bytes', signature: encodeBase64URL(new Uint8Array(64).fill(7)) },
		{ label: 'characters outside the alphabet', signature: '*'.repeat(valid.length) },
		{ label: 'a header-limit signature', signature: 'A'.repeat(SIGNER_HEADER_LIMIT) },
	])
}

/** Represents one token `verifyToken` answers `undefined` for. */
export interface SignerTokenCase {
	readonly label: string
	readonly token: string
}

/**
 * Builds the malformed tokens derived from a valid one: a missing or misplaced separator, a
 * tampered or non-UTF-16 payload, a header-limit payload, and every malformed signature.
 *
 * @param valid - A valid `<payload>.<signature>` token
 * @returns The malformed class table for `verifyToken`
 */
export function buildMalformedTokens(valid: string): readonly SignerTokenCase[] {
	const dot = valid.lastIndexOf('.')
	const payload = valid.slice(0, dot)
	const signature = valid.slice(dot + 1)
	return Object.freeze([
		{ label: 'an empty token', token: '' },
		{ label: 'no separator', token: payload },
		{ label: 'a lone separator', token: '.' },
		{ label: 'an empty signature', token: `${payload}.` },
		{ label: 'an empty payload', token: `.${signature}` },
		{ label: 'a tampered payload', token: `${payload}x.${signature}` },
		{ label: 'a trailing separator', token: `${valid}.` },
		{ label: 'a lone surrogate payload', token: `\ud800.${signature}` },
		{
			label: 'a lone surrogate inside the payload',
			token: `${payload.slice(0, 4)}\udc00${payload.slice(5)}.${signature}`,
		},
		{
			label: 'a header-limit payload',
			token: `${'A'.repeat(SIGNER_HEADER_LIMIT - signature.length - 1)}.${signature}`,
		},
		...buildMalformedSignatures(signature).map((entry) => ({
			label: `a signature: ${entry.label}`,
			token: `${payload}.${entry.signature}`,
		})),
	])
}

/**
 * Represents a consumer's signer whose key service is down: `sign` resolves a fixed text and
 * `verify` rejects with `reason`.
 */
export class SignerOutage implements SignerInterface {
	readonly #reason: string

	constructor(reason: string) {
		this.#reason = reason
	}

	async sign(): Promise<string> {
		return 'signature'
	}

	async verify(): Promise<boolean> {
		throw new Error(this.#reason)
	}
}

/** Names a `node:crypto` export the signer calls, which a recorder can wrap. */
export type SignerCryptoCall = 'createSecretKey' | 'createHmac'

/** Represents what a recorded run resolved and the calls the recorder saw meanwhile. */
export interface SignerRecording<T> {
	readonly value: T
	readonly calls: ReadonlyArray<readonly unknown[]>
}

/**
 * Runs `run` while a recorder wraps the `node:crypto` export `name`, and returns what the run
 * resolved with the arguments of every call made to that export meanwhile.
 *
 * @remarks
 * The recorder replaces the export on the module object and publishes it to every ES module binding
 * through `syncBuiltinESMExports`, then restores the original the same way. The wrapped export still
 * runs, so the code under test behaves as it does unwrapped.
 *
 * @param name - The export to record
 * @param run - The work to record across
 * @returns The run's value and each recorded call's arguments, oldest first
 */
export async function recordSignerCrypto<T>(
	name: SignerCryptoCall,
	run: () => Promise<T>,
): Promise<SignerRecording<T>> {
	const original = crypto[name]
	const recorder = createRecorder<readonly unknown[]>()
	Reflect.set(crypto, name, (...args: readonly unknown[]): unknown => {
		recorder.handler(...args)
		return Reflect.apply(original, crypto, args)
	})
	syncBuiltinESMExports()
	try {
		return { value: await run(), calls: [...recorder.calls] }
	} finally {
		Reflect.set(crypto, name, original)
		syncBuiltinESMExports()
	}
}
