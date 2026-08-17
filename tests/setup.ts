import { afterEach, vi } from 'vitest'

// ── Environment-agnostic base setup (AGENTS §16.1) ────────────────────────────
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
