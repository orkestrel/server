import type { Encoding, FormatHandlerMap, MiddlewareContext, NegotiatorInterface } from './types.js'
import { languageQuality, matchMediaType, negotiateEncoding, parseAcceptHeader } from './helpers.js'

/**
 * The content-negotiation machine over the weighted `Accept` family — a
 * reusable, cross-middleware ENTITY (not a middleware). Implements exactly
 * {@link NegotiatorInterface}.
 *
 * @remarks
 * `negotiate` is the generic media-type primitive (exact / subtype-wildcard /
 * any-range, q-sorted, `;q=0` rejected); `encoding` / `language` are its
 * sibling axes and REUSE the same {@link parseAcceptHeader} q-value parser the
 * rest of the substrate uses — one parser, never two. `format` reads the
 * request `Accept`, negotiates a {@link FormatHandlerMap}'s keys, and invokes
 * the winner — or answers `406 Not Acceptable`.
 *
 * @example
 * ```ts
 * const negotiator = new Negotiator()
 * negotiator.negotiate('text/html, application/json;q=0.9', ['application/json', 'text/html'])
 * // 'text/html'
 * ```
 */
export class Negotiator implements NegotiatorInterface {
	negotiate(header: string, available: readonly string[]): string | undefined {
		if (available.length === 0) return undefined
		const entries = parseAcceptHeader(header)
		if (entries.length === 0) return available[0]
		let best: string | undefined
		let bestQuality = 0
		let bestRank = Number.POSITIVE_INFINITY
		for (const candidate of available) {
			const match = matchMediaType(entries, candidate)
			if (match === undefined) continue
			const { q, rank } = match
			if (q > bestQuality || (q === bestQuality && rank < bestRank)) {
				best = candidate
				bestQuality = q
				bestRank = rank
			}
		}
		return best
	}

	encoding(header: string, available: readonly Encoding[]): Encoding | undefined {
		return negotiateEncoding(header, available)
	}

	language(header: string, available: readonly string[]): string | undefined {
		if (available.length === 0) return undefined
		const entries = parseAcceptHeader(header)
		if (entries.length === 0) return available[0]
		let best: string | undefined
		let bestQuality = 0
		for (const candidate of available) {
			const quality = languageQuality(entries, candidate)
			if (quality > bestQuality) {
				best = candidate
				bestQuality = quality
			}
		}
		return best
	}

	/**
	 * @remarks
	 * Errors thrown by the negotiated handler propagate UNMODIFIED — the
	 * server boundary classifies them, never this negotiator.
	 */
	async format<TState>(
		request: Request,
		context: MiddlewareContext<TState>,
		handlers: FormatHandlerMap<TState>,
	): Promise<Response> {
		const keys = Object.keys(handlers)
		const header = request.headers.get('accept')
		const type = header === null ? keys[0] : this.negotiate(header, keys)
		if (type === undefined) return new Response('Not Acceptable', { status: 406 })
		const handler = handlers[type]
		if (handler === undefined) return new Response('Not Acceptable', { status: 406 })
		return handler(request, context)
	}
}
