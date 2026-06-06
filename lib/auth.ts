const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

export async function createSessionToken(): Promise<string> {
  const exp = String(Date.now() + EXPIRY_MS);
  const key = await importKey();
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(exp));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  return `${exp}.${b64}`;
}

export async function verifySessionToken(token: string): Promise<boolean> {
  try {
    const [expStr, b64sig] = token.split(".");
    const exp = parseInt(expStr, 10);
    if (isNaN(exp) || Date.now() > exp) return false;

    const key = await importKey();
    const sig = Uint8Array.from(
      atob(b64sig.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0)
    );
    return await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(expStr));
  } catch {
    return false;
  }
}

function importKey() {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(process.env.ADMIN_PASSWORD!),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}
