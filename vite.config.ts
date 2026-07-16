import type { UserConfig } from 'vite'
import { defineConfig, mergeConfig } from 'vitest/config'
import tsconfig from './tsconfig.json' with { type: 'json' }
import { fileURLToPath, URL } from 'node:url'
import { globSync } from 'node:fs'
import { playwright } from '@vitest/browser-playwright'

export function resolveWorkspacePath(relativePath: string): string {
	return fileURLToPath(new URL(relativePath, import.meta.url))
}

/**
 * Resolve the Playwright browser provider, by precedence — one self-contained
 * function covering every environment (Windows, macOS, Linux, Claude Code Cloud):
 *
 *   1. `PLAYWRIGHT_EXECUTABLE_PATH` — an explicit browser binary (CI / pinned).
 *   2. `PLAYWRIGHT_WS_ENDPOINT`     — a CDP / WebSocket endpoint of an already-
 *      running browser (remote debugging, a browser-tools MCP, etc.).
 *   3. `PLAYWRIGHT_CHANNEL`         — an explicit channel (`chrome`, `msedge`,
 *      `chromium`, …) for local dev loops.
 *   4. Claude Code / Claude Cloud  — the bundled chromium under
 *      `/opt/pw-browsers/`. The revision dir AND its inner layout drift across
 *      Playwright builds, plus a top-level `chromium` symlink points at the
 *      installed binary — so glob every known shape and take the highest match.
 *   5. Platform default — Windows → `msedge` (ships with the OS, never collides
 *      with a foreground Chrome); macOS / Linux → `chrome`. Override with
 *      `PLAYWRIGHT_CHANNEL` when the default isn't installed.
 */
export function createBrowserProvider() {
	const { PLAYWRIGHT_EXECUTABLE_PATH, PLAYWRIGHT_WS_ENDPOINT, PLAYWRIGHT_CHANNEL } = process.env
	if (PLAYWRIGHT_EXECUTABLE_PATH)
		return playwright({ launchOptions: { executablePath: PLAYWRIGHT_EXECUTABLE_PATH } })
	if (PLAYWRIGHT_WS_ENDPOINT)
		return playwright({ connectOptions: { wsEndpoint: PLAYWRIGHT_WS_ENDPOINT } })
	if (PLAYWRIGHT_CHANNEL) return playwright({ launchOptions: { channel: PLAYWRIGHT_CHANNEL } })
	if (process.platform === 'linux') {
		for (const pattern of [
			'/opt/pw-browsers/chromium',
			'/opt/pw-browsers/chromium-*/chrome-linux64/chrome',
			'/opt/pw-browsers/chromium-*/chrome-linux/chrome',
		]) {
			const [executablePath] = globSync(pattern).sort().reverse()
			if (executablePath) return playwright({ launchOptions: { executablePath } })
		}
	}
	const channel = process.platform === 'win32' ? 'msedge' : 'chrome'
	return playwright({ launchOptions: { channel } })
}

const resolve = {
	alias: Object.entries(tsconfig.compilerOptions.paths).reduce(
		(a, [k, v]) => Object.assign(a, { [k]: resolveWorkspacePath(v[0]) }),
		{},
	),
}

// Base: shared resolve + build defaults + src:server tests. Server-only
// library (`src/server`, the `node:http` ↔ fetch glue that adapts a
// `@orkestrel/router` dispatcher into a request listener, plus the
// environment-agnostic middleware seam + substrate it composes). Builds a
// dual ESM+CJS lib for Node and runs its tests in the node environment.
// Externalizes `node:*` (so `node:http` is never bundled) AND declared
// `@orkestrel/*` deps — nothing else to externalize, this is the package's
// only surface.
export const srcServer = (config?: UserConfig): UserConfig =>
	mergeConfig(
		{
			resolve,
			build: {
				emptyOutDir: true,
				sourcemap: true,
				minify: false,
				lib: {
					entry: resolveWorkspacePath('src/server/index.ts'),
					formats: ['es', 'cjs'],
					fileName: (format: string) => (format === 'es' ? 'index.js' : 'index.cjs'),
				},
				outDir: 'dist/src/server',
				target: 'node24',
				rolldownOptions: {
					external: (id: string) => id.startsWith('node:') || id.startsWith('@orkestrel/'),
				},
			},
			test: {
				name: { label: 'src:server', color: 'red' },
				include: ['tests/src/server/**/*.test.ts'],
				setupFiles: ['./tests/setup.ts', './tests/setupServer.ts'],
				environment: 'node',
				browser: { enabled: false },
			},
		},
		config ?? {},
	)

// Extends srcServer: the guides-parity suite. Node env — it reads the real
// guides/*.md and the documented source modules off disk — but resolves like
// server tests.
export const guides = (config?: UserConfig): UserConfig =>
	srcServer(
		mergeConfig(
			{
				test: {
					name: { label: 'guides', color: 'green' },
					include: ['tests/guides/**/*.test.ts'],
					exclude: ['tests/src/**/*.test.ts', 'tests/setup.test.ts'],
				},
			},
			config ?? {},
		),
	)

export default defineConfig({
	resolve,
	test: {
		projects: [srcServer, guides],
	},
})
