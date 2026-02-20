export function basicAuthMiddleware(req: any, res: any, next: any): void {
	const authHeader = req.headers?.authorization

	if (!authHeader || !authHeader.startsWith("Basic ")) {
		res.status(401).json({ error: "Unauthorized" })
		return
	}

	next()
}
