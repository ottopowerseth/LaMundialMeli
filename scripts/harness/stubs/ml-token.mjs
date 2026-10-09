// Nunca refresca ni escribe: devuelve el token que el runner dejó en globalThis.__H.
export async function getValidAccessToken() { return globalThis.__H.token ?? "replay"; }
export async function saveTokens() { throw new Error("harness: saveTokens no debe llamarse"); }
