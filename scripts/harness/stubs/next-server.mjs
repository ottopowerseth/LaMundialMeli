export class NextRequest { constructor(url) { this.url = url; this.headers = new Map(); } }
export const NextResponse = { json: (body, init) => ({ status: init?.status ?? 200, body }) };
