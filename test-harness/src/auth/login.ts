/**
 * Authentication — Login Module
 *
 * Handles user login with basic credential validation.
 * This module is a candidate for refactoring under the "refactor-auth" intent.
 */

export interface LoginCredentials {
	email: string
	password: string
}

export interface LoginResult {
	success: boolean
	token?: string
	error?: string
}

const MOCK_USERS: Record<string, string> = {
	"admin@example.com": "admin123",
	"user@example.com": "password",
}

function normalizestring(value: unknown): string {
	return typeof value === "string" ? value : ""
}

function sanitizeEmail(email: unknown): string {
	return normalizestring(email)
		.trim()
		.toLowerCase()
		.replace(/[\u0000-\u001F\u007F]/g, "")
}

function sanitizePassword(password: unknown): string {
	return normalizestring(password).replace(/\u0000/g, "")
}

export function validateemailformat(email: string): boolean {
	const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
	return EMAIL_REGEX.test(email)
}

function validateLoginInput(email: string, password: string): string | null {
	const MAX_EMAIL_LENGTH = 254
	const MAX_PASSWORD_LENGTH = 128

	if (!email || !password) {
		return "Email and password are required"
	}

	if (email.length > MAX_EMAIL_LENGTH) {
		return "Email is too long"
	}

	if (!validateemailformat(email)) {
		return "Invalid email format"
	}

	if (password.length > MAX_PASSWORD_LENGTH) {
		return "Password is too long"
	}

	return null
}

/**
 * Authenticates a user with sanitized credentials and basic validation.
 *
 * @param credentials - Raw login credentials containing email and password.
 * @returns A successful result with a generated token, or a failure result with an error message.
 */
export function authenticateUser(credentials: LoginCredentials): LoginResult {
	try {
		const email = sanitizeEmail(credentials?.email)
		const password = sanitizePassword(credentials?.password)

		const validationError = validateLoginInput(email, password)
		if (validationError) {
			return { success: false, error: validationError }
		}

		const storedPassword = MOCK_USERS[email]

		if (!storedPassword) {
			return { success: false, error: "User not found" }
		}

		if (storedPassword !== password) {
			return { success: false, error: "Invalid password" }
		}

		const token = Buffer.from(`${email}:${Date.now()}`).toString("base64")
		return { success: true, token }
	} catch {
		return { success: false, error: "Login processing failed" }
	}
}

/**
 * Validate an existing authentication token.
 */
export function validateToken(token: string): boolean {
	if (!token) {
		return false
	}

	try {
		const decoded = Buffer.from(token, "base64").toString("utf-8")
		const [email, timestamp] = decoded.split(":")
		const age = Date.now() - parseInt(timestamp, 10)
		const ONE_HOUR = 3600000

		return !!email && age < ONE_HOUR
	} catch {
		return false
	}
}
