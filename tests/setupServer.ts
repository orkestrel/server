import type * as ServerErrors from '../src/server/errors.js'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
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
	SSEMessage,
} from '@src/server'
import type { IncomingMessage } from 'node:http'
import { seededRandom } from '@orkestrel/contract'
import { createDispatcher } from '@orkestrel/router'
import http from 'node:http'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { queryObjects } from 'node:v8'
import {
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
	const small = build(size)
	const large = build(4 * size)
	small()
	large()
	const repeat = Math.max(1, Math.ceil(20 / Math.max(timeServerBatch(small, 1), 0.001)))
	const rounds = Array.from({ length: 5 }, (_, round) =>
		round % 2 === 0
			? { small: timeServerBatch(small, repeat), large: timeServerBatch(large, repeat) }
			: { large: timeServerBatch(large, repeat), small: timeServerBatch(small, repeat) },
	)
	return (
		Math.min(...rounds.map((times) => times.large)) /
		Math.min(...rounds.map((times) => times.small))
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
 * @returns The number of live objects whose prototype chain holds `Object.prototype`
 */
export async function countLiveObjects(): Promise<number> {
	queryObjects(Object, { format: 'count' })
	await waitForDelay(10)
	queryObjects(Object, { format: 'count' })
	await waitForDelay(10)
	return queryObjects(Object, { format: 'count' })
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
 * - `POST /upload` reads its body as text, then answers it.
 * - `GET /trickle` answers {@link BOUNDARY_FIRST_CHUNK}, then a body that waits until it is
 *   cancelled.
 * - `GET /fail-body` answers {@link BOUNDARY_FIRST_CHUNK}, then fails with
 *   {@link BOUNDARY_BODY_FAULT} after {@link BOUNDARY_SLOW_MS}.
 * - `GET /slow` waits {@link BOUNDARY_SLOW_MS}, answers its first chunk, waits again, then ends.
 * - `GET /unavailable` waits {@link BOUNDARY_SLOW_MS}, then throws an `HTTPError` of 503.
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
			return new Response(await request.text())
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
	return dispatcher
}

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
