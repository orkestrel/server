import type { MiddlewareContext } from '@src/server'
import { afterEach, vi } from 'vitest'

// ── Environment-agnostic base setup ───────────────────────────────────────────
//
// Loaded first by every test project (`vite.config.ts` `setupFiles[0]`). Holds
// ONLY helpers with no `node:*` / DOM / Vue dependency, so it is safe for
// `src:core`, `src:browser`, and `src:server` alike. Environment-specific
// helpers live in their own matching setup file (`setupBrowser.ts`,
// `setupServer.ts`).
//
// The fleet-wide helpers live in `@orkestrel/test`.

afterEach(() => {
	vi.restoreAllMocks()
})

/**
 * Builds the per-request {@link MiddlewareContext} a middleware, negotiator, or
 * guide-fence proof drives — a fixed `GET http://localhost/` request with an
 * empty body and the caller's own state bag.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param state - The state bag the returned context carries, passed through by
 *   identity
 * @returns A context over `http://localhost/` whose `method` is `'GET'` and
 *   whose `body()` resolves `undefined`
 *
 * @example
 * ```ts
 * import { buildContext } from '../../setup.js'
 *
 * buildContext({ userId: 'me' }).state.userId // 'me'
 * ```
 */
export function buildContext<TState>(state: TState): MiddlewareContext<TState> {
	return {
		url: new URL('http://localhost/'),
		method: 'GET',
		state,
		body: async () => undefined,
	}
}
