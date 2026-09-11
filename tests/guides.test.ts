// The consumer-side guides-parity drop-in: runs `@orkestrel/guide`'s checks against
// this repo's own `guides/README.md` manifest. The constants that follow are this
// package's own, as is the executed section that closes the file.

import { GuideCommand } from '@orkestrel/guide/server'
import { readInventory } from '@orkestrel/test/server'
import { createVitest } from 'vitest/node'

/** Every fence language this package's guides are allowed to use. */
const FENCE_LANGUAGES = Object.freeze(['ts'])
/** The fence language whose blocks count as worked examples. */
const EXAMPLE_LANGUAGE = 'ts'
/** The package identity that binds its manifest, module map, and README pitch. */
const PACKAGE_NAME = '@orkestrel/server'
/** The one guide this package sources, whose tagline the README pitch equals. */
const GUIDE_SPEC = 'guides/server.md'
/** Each import specifier this package's own guides may resolve against. */
const MODULES = Object.freeze({ [PACKAGE_NAME]: 'src/server', '@src/server': 'src/server' })
/**
 * Declarations deliberately kept out of the barrel, as `computeSymbolKey` strings.
 *
 * A class that one-class-per-file evicted from its single consumer cannot become a
 * local, so it stays exported without being public. Naming it here is what makes that
 * intentional rather than forgotten — and the assertion that follows it fails when a name
 * here stops being stranded, so the list cannot rot.
 */
const INTERNAL: readonly string[] = Object.freeze([])

await new GuideCommand({
	root: new URL('../', import.meta.url),
	patterns: ['src/**/*.ts', 'tests/**/*.ts', 'guides/*.md', '*.md', 'package.json'],
	modules: MODULES,
	languages: FENCE_LANGUAGES,
	language: EXAMPLE_LANGUAGE,
	reader: readInventory,
	runner: createVitest,
}).execute(async ({ files, report, rows }) => {
	const { isRecord, parseJSON } = await import('@orkestrel/contract')
	const {
		computeSymbolKey,
		createSourceManager,
		extractFenceImports,
		findMissing,
		findMissingSymbols,
		findUnexampled,
		isExternalLink,
		resolveLink,
	} = await import('@orkestrel/guide')
	const { createDispatcher } = await import('@orkestrel/router')
	const { requireValue } = await import('@orkestrel/test')
	const {
		createNegotiator,
		createServer,
		decodeTokenPayload,
		decompressRequestBody,
		signToken,
		verifyToken,
	} = await import('@src/server')
	const { describe, expect, it } = await import('vitest')
	const { buildContext } = await import('./setup.js')
	const sources = createSourceManager({ files, modules: MODULES })
	const own = requireValue(
		rows.find((row) => row.entry.spec === GUIDE_SPEC),
		`Missing manifest row: ${GUIDE_SPEC}`,
	)
	const manifest = parseJSON(requireValue(files['package.json'], 'Missing inventory: package.json'))
	if (!isRecord(manifest)) throw new Error('Invalid package manifest: package.json')

	it('manifest lists at least one guide', () => {
		expect(report.input).toEqual([])
		expect(rows.length).toBeGreaterThan(0)
		expect(own.entry.spec).toBe(GUIDE_SPEC)
	})

	// The example half of the equality case is silent over an empty population: with no
	// title on both sides `findDrift` compares no pair and the case passes on the summaries
	// alone. This pins the population this repository's own guide contributes, so removing
	// every `@example` title reddens the suite instead of quietly retiring half the gate.
	// The failure names both title sets, because a pin reporting only its own emptiness
	// leaves the reader to work out which side dropped the title.
	it('pairs at least one example title across the guide and the source', () => {
		expect(report.examples.titles.filter((finding) => finding.spec === GUIDE_SPEC)).toEqual([])
	})

	// The README's pitch and the guide's tagline are one text, each read as the blockquote
	// under its file's H1. `README.md` is outside the concept index, so the reader is
	// applied to it directly rather than through a manifest row. Each side is guarded
	// against `undefined` first, so a file that lost its blockquote reports that rather
	// than reporting two absences as agreement.
	it('opens the README with the guide tagline', () => {
		expect(manifest.name).toBe(PACKAGE_NAME)
		expect(report.pitch).toEqual([])
	})

	for (const { entry, guide, source } of rows) {
		describe(`${entry.concept}`, () => {
			it('uses only listed fence languages', () => {
				expect(report.fences.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('extracts a non-empty documented surface', () => {
				expect(guide.surface().length).toBeGreaterThan(0)
			})
			it('re-exports every direct declaration that is not named internal', () => {
				const stranded = findMissingSymbols(source.exports(), source.surface())
				expect(stranded.filter((key) => !INTERNAL.includes(key))).toEqual([])
			})
			it('names no symbol internal that the barrel already exports', () => {
				const stranded = findMissingSymbols(source.exports(), source.surface())
				expect(INTERNAL.filter((key) => !stranded.includes(key))).toEqual([])
			})
			it('re-exports only direct declarations', () => {
				expect(findMissingSymbols(source.surface(), source.exports())).toEqual([])
			})
			it('documents every barrel export', () => {
				expect(findMissingSymbols(source.surface(), guide.surface())).toEqual([])
			})
			it('documents only barrel exports', () => {
				expect(findMissingSymbols(guide.surface(), source.surface())).toEqual([])
			})

			it('exposes no hidden module-scope declarations', () => {
				expect(source.hidden().map(computeSymbolKey)).toEqual([])
			})

			for (const group of guide.methods()) {
				const members = source.methods(group.interface).map((method) => method.name)
				const documented = group.methods.map((method) => method.name)
				const entity = group.interface.replace(/Interface$/, '')
				describe(`${group.interface}`, () => {
					it('documents at least one method', () => {
						expect(group.methods.length).toBeGreaterThan(0)
					})
					it('documents every interface method', () => {
						expect(findMissing(members, documented)).toEqual([])
					})
					it('documents no phantom method', () => {
						expect(findMissing(documented, members)).toEqual([])
					})
					it(`${entity} exposes no undocumented method`, () => {
						const extra =
							entity === group.interface
								? []
								: findMissing(
										source.methods(entity).map((method) => method.name),
										documented,
									)
						expect(extra).toEqual([])
					})
				})
			}

			// The equality gate: a `Summary` cell against its export's description paragraph, a
			// titled fence against the `@example` of that title. `findDrift` owns the comparison
			// and names both sides; converge the two sides with `npm run docs`, never by
			// weakening this assertion. `findDrift` pairs an example only where a title is
			// present on both sides, so an untitled `@example` block is outside this case. Each
			// collected line is the spec, the key, and each side's text or `absent` — the same
			// worklist `npm run docs` prints, so a failure here is read the way that command's
			// output is.
			it('keeps every compared summary and example equal to its source', () => {
				expect(report.drift.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('documents an example for every Surface function', () => {
				expect(report.examples.functions.filter((finding) => finding.spec === entry.spec)).toEqual(
					[],
				)
			})

			for (const group of guide.methods()) {
				const entity = group.interface.replace(/Interface$/, '')
				const documented = group.methods.map((method) => method.name)
				const examples =
					entity === group.interface
						? source.examples(group.interface).map((example) => example.name)
						: source
								.examples(group.interface)
								.map((example) => example.name)
								.concat(source.examples(entity).map((example) => example.name))
				describe(`${group.interface} examples`, () => {
					it('documents an example for every method', () => {
						const fences = guide
							.fences()
							.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
							.map((fence) => fence.code)
						expect(findUnexampled(documented, fences, examples)).toEqual([])
					})
				})
			}

			it('imports only real exports in every ```ts fence', () => {
				const fences = guide.fences().filter((fence) => fence.language === EXAMPLE_LANGUAGE)
				for (const fence of fences) {
					for (const { specifier, names } of extractFenceImports(fence.code)) {
						const imported = sources.source(specifier)
						if (imported === undefined) continue
						const surface = imported.surface().map((symbol) => symbol.name)
						expect(findMissing(names, surface)).toEqual([])
					}
				}
			})

			it('resolves every relative link', () => {
				const broken = guide
					.links()
					.filter((href) => !isExternalLink(href))
					.map((href) => resolveLink(entry.spec, href))
					.filter((path) => !source.exists(path))
				expect(broken).toEqual([])
			})
			it('links only to test files that exist', () => {
				const missing = guide
					.tests()
					.map((href) => resolveLink(entry.spec, href))
					.filter((path) => !source.exists(path))
				expect(missing).toEqual([])
			})
		})
	}

	// Each case in this block transcribes one flagship fence of `guides/server.md` and asserts the value that
	// fence's comment claims. Name resolution is not a behavioural proof, so a fence documenting a
	// value the code contradicts passes every preceding parity assertion and only fails here. Change a
	// fence, change the transcription beside it. Each transcription imports through `@src/server`
	// where the fence imports through `@orkestrel/server`, because the barrel is the same surface and
	// the published specifier does not resolve inside this workspace.

	describe('guide fences', () => {
		const guideText = requireValue(files[GUIDE_SPEC], `Missing file: ${GUIDE_SPEC}`)

		it('the substrate fence negotiates the media type, coding, and language its comments claim', () => {
			const negotiator = createNegotiator()
			expect(
				negotiator.negotiate('text/html, application/json;q=0.9', [
					'application/json',
					'text/html',
				]),
			).toBe('text/html')
			expect(negotiator.encoding('gzip;q=1.0, deflate;q=0.8', ['gzip', 'deflate'])).toBe('gzip')
			expect(negotiator.language('en-US, en;q=0.8, fr;q=0.5', ['en', 'fr'])).toBe('en')
		})

		it('the substrate fence dispatches its format handler', async () => {
			const negotiator = createNegotiator()
			const response = await negotiator.format(
				new Request('http://x'),
				buildContext<Record<string, never>>({}),
				{
					'application/json': (_request, _context) => Response.json({ ok: true }),
				},
			)
			await expect(response.json()).resolves.toEqual({ ok: true })
		})

		it('the substrate fence resolves a bad token to undefined and round-trips a signed payload', async () => {
			await expect(verifyToken('bad.token', 'secret')).resolves.toBeUndefined()
			const token = await signToken('client', { secret: 'shh' })
			const encoded = requireValue(token.split('.')[0], 'signToken emitted no payload segment')
			expect(decodeTokenPayload(encoded)).toBe('client')
		})

		it('the substrate fence decompresses its capped gzip body', async () => {
			const gzipped = new Uint8Array(
				await new Response(
					new Blob(['hi']).stream().pipeThrough(new CompressionStream('gzip')),
				).arrayBuffer(),
			)
			const body = await decompressRequestBody(gzipped, 'gzip', 1_048_576)
			expect(new TextDecoder().decode(body)).toBe('hi')
		})

		it('the Quickstart fence reaches listening and then stopped', async () => {
			interface State {
				readonly requestId: string
				readonly ip: string | undefined
			}
			const dispatcher = createDispatcher<State>()
			dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })
			const server = createServer<State>({
				dispatcher,
				state: (connection) => ({ requestId: crypto.randomUUID(), ip: connection.ip }),
			})
			server.use(async (_request, context, next) => {
				const response = await next()
				response.headers.set('X-Request-ID', context.state.requestId)
				return response
			})
			try {
				const port = await server.start()
				expect(server.status).toBe('listening')
				expect(port).toBeGreaterThan(0)
				await server.stop()
				expect(server.status).toBe('stopped')
			} finally {
				await server.destroy()
			}
		})

		it('carries the fence lines the transcriptions copy', () => {
			// The presence guards beside the transcriptions: they prove the transcribed
			// lines are still the documented ones, and nothing about behavior. Binding the
			// construction line alone would leave a comment free to claim the opposite
			// value and stay green, so every line carrying a claim is bound.
			expect(guideText).toContain(
				"negotiator.negotiate('text/html, application/json;q=0.9', ['application/json', 'text/html']) // 'text/html'",
			)
			expect(guideText).toContain(
				"negotiator.encoding('gzip;q=1.0, deflate;q=0.8', ['gzip', 'deflate']) // 'gzip'",
			)
			expect(guideText).toContain(
				"negotiator.language('en-US, en;q=0.8, fr;q=0.5', ['en', 'fr']) // 'en'",
			)
			expect(guideText).toContain(
				"await verifyToken('bad.token', 'secret') // undefined — total, never throws",
			)
			expect(guideText).toContain(
				"const body = await decompressRequestBody(gzipped, 'gzip', 1_048_576)",
			)
			expect(guideText).toContain('const port = await server.start()')
			expect(guideText).toContain('await server.stop()')
		})
	})
})
