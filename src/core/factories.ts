import type { NegotiatorInterface } from './types.js'
import { Negotiator } from './Negotiator.js'

/**
 * Create a {@link NegotiatorInterface} — the reusable content-negotiation
 * machine over the weighted `Accept` family.
 *
 * @remarks
 * Prefer this over `new Negotiator()` at call sites that only need the
 * interface.
 *
 * @returns A {@link NegotiatorInterface}
 *
 * @example
 * ```ts
 * import { createNegotiator } from '@src/core'
 *
 * const negotiator = createNegotiator()
 * negotiator.negotiate('text/html, application/json;q=0.9', ['application/json', 'text/html'])
 * // 'text/html'
 * ```
 */
export function createNegotiator(): NegotiatorInterface {
	return new Negotiator()
}
