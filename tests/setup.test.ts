import { describe, expect, it } from 'vitest'
import * as setup from './setup.js'

// `tests/setup.ts` is the first setup file every Vitest project in `vite.config.ts` loads. It
// registers the per-test mock restoration hook and declares no export, so the whole contract a
// consuming suite depends on is that loading it contributes no name of its own: a suite reaches
// every shared helper through `@orkestrel/test` or through an environment setup module instead.
// The restoration hook is Vitest's own behavior, driven by the runner rather than by this
// workspace, so it is not re-proven here.

describe('setup — module surface', () => {
	it('contributes no exported name to a consuming suite', () => {
		expect(Object.keys(setup)).toEqual([])
	})
})
