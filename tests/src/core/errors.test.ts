import { describe, expect, it } from 'vitest'
import { HTTP_ERROR_BRAND } from '../../../src/core/constants.js'
import { ContentTooLargeError, HTTPError, isHTTPError } from '../../../src/core/errors.js'

describe('HTTPError', () => {
	it('carries the status and message', () => {
		const error = new HTTPError(404, 'user not found')
		expect(error.status).toBe(404)
		expect(error.message).toBe('user not found')
		expect(error.name).toBe('HTTPError')
		expect(error.context).toBeUndefined()
	})

	it('carries an optional context record', () => {
		const error = new HTTPError(400, 'bad field', { field: 'email' })
		expect(error.context).toEqual({ field: 'email' })
	})

	it('is a real Error instance', () => {
		const error = new HTTPError(500, 'boom')
		expect(error).toBeInstanceOf(Error)
	})
})

describe('ContentTooLargeError', () => {
	it('is a 413 carrying the limit in its context', () => {
		const error = new ContentTooLargeError(1024)
		expect(error.status).toBe(413)
		expect(error.name).toBe('ContentTooLargeError')
		expect(error.context).toEqual({ limit: 1024 })
		expect(error.message).toContain('1024')
	})

	it('is an HTTPError subclass', () => {
		const error = new ContentTooLargeError(2048)
		expect(error).toBeInstanceOf(HTTPError)
	})
})

describe('isHTTPError', () => {
	it('narrows a plain HTTPError', () => {
		expect(isHTTPError(new HTTPError(404, 'not found'))).toBe(true)
	})

	it('narrows an HTTPError subclass', () => {
		expect(isHTTPError(new ContentTooLargeError(10))).toBe(true)
	})

	it('rejects a generic Error', () => {
		expect(isHTTPError(new Error('plain'))).toBe(false)
	})

	it('rejects non-error values', () => {
		expect(isHTTPError(undefined)).toBe(false)
		expect(isHTTPError(null)).toBe(false)
		expect(isHTTPError('HTTPError')).toBe(false)
		expect(isHTTPError({ status: 404, message: 'not found' })).toBe(false)
	})

	it('rejects a status carried WITHOUT the cross-copy brand', () => {
		const lookAlike = new Error('not found')
		Object.assign(lookAlike, { status: 404 })
		expect(isHTTPError(lookAlike)).toBe(false)
	})

	it('narrows a structurally-complete instance from a foreign package copy', () => {
		// Simulates the dual-package hazard: an object carrying the
		// `Symbol.for`-interned brand but NOT constructed by THIS copy's
		// `HTTPError` (so `instanceof` would fail across copies).
		const foreign: unknown = Object.assign(
			{},
			{ [HTTP_ERROR_BRAND]: true, status: 401, message: 'unauthorized' },
		)
		expect(isHTTPError(foreign)).toBe(true)
	})

	it('narrows a foreign-copy clone of an HTTPError subclass', () => {
		const foreignSubclass: unknown = Object.assign(
			{},
			{ [HTTP_ERROR_BRAND]: true, status: 413, message: 'too large', name: 'ContentTooLargeError' },
		)
		expect(isHTTPError(foreignSubclass)).toBe(true)
	})
})
