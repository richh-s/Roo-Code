/**
 * Authentication — Session Module
 *
 * Provides basic in-memory session management helpers.
 */

export interface Session {
	id: string
	userId: string
	createdAt: number
	expiresAt: number
}

const ONE_HOUR_MS = 60 * 60 * 1000

/**
 * Creates a new session object for a user.
 *
 * @param userId - The unique identifier of the authenticated user.
 * @param ttlMs - Optional session time-to-live in milliseconds. Defaults to 1 hour.
 * @returns A session descriptor with generated id and expiry metadata.
 */
export function createSession(userId: string, ttlMs: number = ONE_HOUR_MS): Session {
	const createdAt = Date.now()
	const expiresAt = createdAt + Math.max(0, ttlMs)
	const id = Buffer.from(`${userId}:${createdAt}:${Math.random()}`).toString("base64").replace(/=+$/g, "")

	return {
		id,
		userId,
		createdAt,
		expiresAt,
	}
}
