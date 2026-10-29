import { describe, expect, it } from 'vitest'
import {
	ContentTooLargeError,
	HTTPError,
	isContentTooLargeError,
	isHTTPError,
	isServerError,
	ServerError,
} from '@src/server'
import { loadServerErrors } from '../../setupServer.js'

describe('declared error contexts', () => {
	it('accepts a class-instance context for every declared error guard', () => {
		const context = new URL('https://example.invalid/context')
		const http = new HTTPError(400, 'context')
		const server = new ServerError('STATUS', 'context')
		const limit = new ContentTooLargeError(1)
		for (const error of [http, server, limit])
			Object.defineProperty(error, 'context', { value: context })
		expect(isHTTPError(http)).toBe(true)
		expect(isServerError(server)).toBe(true)
		expect(isContentTooLargeError(limit)).toBe(true)
	})

	it('accepts a callable context for every declared error guard', () => {
		const context = Object.assign(() => undefined, { field: 'callable' })
		const http = new HTTPError(400, 'context')
		const server = new ServerError('STATUS', 'context')
		const limit = new ContentTooLargeError(1)
		for (const error of [http, server, limit])
			Object.defineProperty(error, 'context', { value: context })
		expect(isHTTPError(http)).toBe(true)
		expect(isServerError(server)).toBe(true)
		expect(isContentTooLargeError(limit)).toBe(true)
	})
})

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

	it('narrows a structurally-complete instance from a foreign package copy', async () => {
		const copy = await loadServerErrors()
		expect(copy.HTTPError).not.toBe(HTTPError)
		const foreign = new copy.HTTPError(401, 'unauthorized')
		expect(isHTTPError(foreign)).toBe(true)
	})

	it('narrows a foreign-copy clone of an HTTPError subclass', async () => {
		const copy = await loadServerErrors()
		expect(copy.ContentTooLargeError).not.toBe(ContentTooLargeError)
		const foreignSubclass = new copy.ContentTooLargeError(1024)
		expect(isHTTPError(foreignSubclass)).toBe(true)
	})
})

describe('ServerError', () => {
	it('carries the code, the message, and its name', () => {
		const error = new ServerError('STATUS', "server cannot start from 'listening'")
		expect(error.code).toBe('STATUS')
		expect(error.message).toBe("server cannot start from 'listening'")
		expect(error.name).toBe('ServerError')
		expect(error.context).toBeUndefined()
	})

	it('carries an optional context record', () => {
		const error = new ServerError('STATUS', 'refused', { status: 'stopping' })
		expect(error.context).toEqual({ status: 'stopping' })
	})

	it('is a real Error instance and not an HTTPError', () => {
		const error = new ServerError('STATUS', 'refused')
		expect(error).toBeInstanceOf(Error)
		expect(error).not.toBeInstanceOf(HTTPError)
		expect(isHTTPError(error)).toBe(false)
	})
})

describe('isServerError', () => {
	it('narrows a ServerError', () => {
		expect(isServerError(new ServerError('STATUS', 'refused'))).toBe(true)
	})

	it('rejects a generic Error and an HTTPError', () => {
		expect(isServerError(new Error('plain'))).toBe(false)
		expect(isServerError(new HTTPError(404, 'not found'))).toBe(false)
	})

	it('rejects non-error values and a bare code-carrying lookalike', () => {
		expect(isServerError(undefined)).toBe(false)
		expect(isServerError(null)).toBe(false)
		expect(isServerError('ServerError')).toBe(false)
		expect(isServerError({ code: 'STATUS', message: 'refused' })).toBe(false)
	})
})
