import { describe, expect, it } from 'vitest'
import { buildContext } from './setup.js'

// `tests/setup.ts` is the first setup file every Vitest project in `vite.config.ts` loads. It
// registers the per-test mock restoration hook and owns the shared `MiddlewareContext` fixture the
// `compose`, `Negotiator`, and guide-fence suites drive, so one change to that contract reaches one
// declaration rather than a copy per suite. The restoration hook is Vitest's own behavior, driven
// by the runner rather than by this workspace, so it is not re-proven here.

describe('buildContext', () => {
	it('builds a GET context over http://localhost/ carrying the caller state and an empty body', async () => {
		const state = { userId: 'me' }
		const context = buildContext(state)
		expect(context.url.href).toBe('http://localhost/')
		expect(context.method).toBe('GET')
		expect(context.state).toBe(state)
		await expect(context.body()).resolves.toBeUndefined()
	})
})
