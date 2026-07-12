import type { NavigatorInterface } from '../src/browser/types.js'
import { waitForDelay } from './setup.js'

// ── Browser-test setup (AGENTS §16.1) ─────────────────────────────────────────
//
// Loaded after `setup.ts` for the `src:browser` project, which runs in a real
// Chromium (DOM available, no `node:*`). Holds the `Navigator` teardown +
// scenario helpers every `src/browser` test reuses — real `location.hash` /
// `history` + real DOM events, no mocks (§16.2).

/**
 * Destroy and forget every tracked navigator, so no `hashchange` / `popstate`
 * / click listener leaks across test cases — the shared `afterEach` teardown
 * (the array is emptied in place).
 *
 * @param navigators - The tracked navigators to tear down (emptied in place)
 */
export function drainNavigators(navigators: NavigatorInterface<unknown>[]): void {
	while (navigators.length > 0) navigators.pop()?.destroy()
}

/**
 * Reset `location.hash` to empty and let a pending ASYNC `hashchange` flush
 * (a macrotask) — the shared `beforeEach` pause so a case starts from a
 * quiescent `#''` before any navigator is listening.
 */
export async function settleHash(): Promise<void> {
	window.location.hash = ''
	await waitForDelay()
}

/**
 * Set `location.hash` and let its ASYNC `hashchange` flush (a macrotask)
 * BEFORE any navigator is listening — so a test counting `navigate`
 * emissions sees only the navigator's own resolve(s), not a spurious replay.
 *
 * @param value - The hash to set (e.g. `'#/tokens'`)
 */
export async function setHash(value: string): Promise<void> {
	window.location.hash = value
	await waitForDelay()
}

/**
 * Reset `history` state to a plain root pathname (via `replaceState`) — the
 * `'history'`-mode counterpart of {@link settleHash}, so each `'history'`-mode
 * case starts from a known location with no leftover `pushState` entries
 * driving the next test's resolve.
 *
 * @param pathname - The pathname to reset to (default `'/'`)
 */
export function settleHistory(pathname = '/'): void {
	window.history.replaceState(null, '', pathname)
}

/**
 * Build a synthetic same-origin `<a>` element (attached to `document.body`
 * so it participates in `event.composedPath()`) — the fixture every
 * `'history'`-mode link-interception test clicks. Caller removes it (or lets
 * the test's own DOM teardown handle it).
 *
 * @param href - The anchor's `href` (a same-origin path, e.g. `'/tokens'`)
 * @param options - `target` / `download` set the matching anchor attributes
 * @returns The attached anchor element
 */
export function createAnchor(
	href: string,
	options?: { readonly target?: string; readonly download?: boolean },
): HTMLAnchorElement {
	const anchor = document.createElement('a')
	anchor.href = href
	if (options?.target !== undefined) anchor.target = options.target
	if (options?.download === true) anchor.setAttribute('download', '')
	document.body.append(anchor)
	return anchor
}

/**
 * Dispatch a real, bubbling, cancelable left-click `MouseEvent` on a node —
 * the click-interception test fixture, so a case can assert
 * `event.defaultPrevented` after dispatch without hand-rolling `MouseEvent`
 * init options each time.
 *
 * @param target - The node to click
 * @param options - Modifier keys / button override (defaults: primary button,
 *   no modifiers)
 * @returns The dispatched event (post-dispatch, so `defaultPrevented` reads live)
 */
export function click(
	target: EventTarget,
	options?: {
		readonly metaKey?: boolean
		readonly ctrlKey?: boolean
		readonly shiftKey?: boolean
		readonly altKey?: boolean
		readonly button?: number
	},
): MouseEvent {
	const event = new MouseEvent('click', {
		bubbles: true,
		cancelable: true,
		composed: true,
		button: options?.button ?? 0,
		metaKey: options?.metaKey ?? false,
		ctrlKey: options?.ctrlKey ?? false,
		shiftKey: options?.shiftKey ?? false,
		altKey: options?.altKey ?? false,
	})
	target.dispatchEvent(event)
	return event
}

/**
 * Dispatch a real click via {@link click} while guaranteeing the iframe can
 * NEVER actually navigate — a bubble-phase `window` listener (registered
 * before dispatch, `{ once: true }`) runs AFTER the `Navigator`'s own
 * `document`-level click listener (bubble order: `document` before `window`),
 * records the Navigator's verdict (`event.defaultPrevented`) into `prevented`,
 * then unconditionally calls `event.preventDefault()` so a declined
 * interception can't fall through to the browser's default navigation and
 * kill the test iframe. Assert against the RETURNED `prevented`, not
 * `event.defaultPrevented` read afterward (this guard always leaves it
 * `true`).
 *
 * @param target - The node to click
 * @param options - Forwarded to {@link click} (modifier keys / button)
 * @returns The dispatched `event` plus the recorded `prevented` verdict
 */
export function safeClick(
	target: EventTarget,
	options?: Parameters<typeof click>[1],
): { readonly event: MouseEvent; readonly prevented: boolean } {
	let prevented = false
	window.addEventListener(
		'click',
		(event) => {
			prevented = event.defaultPrevented
			event.preventDefault()
		},
		{ once: true },
	)
	const event = click(target, options)
	return { event, prevented }
}

/**
 * A manually-resolved promise pair — the deterministic guard-supersede
 * fixture (AGENTS §16.1): a guard under test `await`s `promise` and the
 * scenario calls `resolve`/`reject` on its own schedule, so a "slow guard"
 * case is timing-deterministic rather than relying on real delays.
 */
export interface DeferredInterface<T> {
	readonly promise: Promise<T>
	resolve(value: T): void
	reject(reason: unknown): void
}

/**
 * Create a {@link DeferredInterface} — a promise whose settlement is driven
 * externally, for deterministic async-guard scenarios (AGENTS §16.1: no real
 * delays for a race that must be exact).
 *
 * @typeParam T - The value the deferred promise resolves to
 * @returns A deferred `promise` plus its `resolve` / `reject`
 */
export function createDeferred<T>(): DeferredInterface<T> {
	let resolve: (value: T) => void = () => {}
	let reject: (reason: unknown) => void = () => {}
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}
