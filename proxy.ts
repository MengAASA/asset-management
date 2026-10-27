import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/jwt";

const PUBLIC_PATHS = ["/login", "/register", "/forgot-password", "/reset-password"];
const PUBLIC_API_PREFIX = "/api/auth/";
// The on-prem AD sync agent has no login cookie; these routes check X-Agent-Key themselves.
const AGENT_API_PREFIX = "/api/ad/agent/";
const BASE_PATH = "/phniams";

// Next.js reads the nonce from the Content-Security-Policy request header and
// automatically injects it as the nonce attribute on every inline <script> it
// emits. The matching nonce in the static response CSP (next.config.ts) then
// allows those scripts to execute.
const DEPLOY_NONCE = process.env.DEPLOY_NONCE;

function withNonce(req: NextRequest): NextRequest["headers"] {
  if (!DEPLOY_NONCE) return req.headers;
  const h = new Headers(req.headers);
  h.set("x-nonce", DEPLOY_NONCE);
  h.set("Content-Security-Policy", `script-src 'self' 'nonce-${DEPLOY_NONCE}'`);
  return h;
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const logicalPath = pathname.startsWith(BASE_PATH)
    ? pathname.slice(BASE_PATH.length) || "/"
    : pathname;

  const isApiRoute = logicalPath.startsWith("/api/");

  // Allow Next.js internals (no nonce needed for static assets)
  if (logicalPath.startsWith("/_next") || logicalPath.startsWith("/favicon")) {
    return NextResponse.next();
  }

  // Allow public auth pages and auth API routes
  if (PUBLIC_PATHS.includes(logicalPath) || logicalPath.startsWith(PUBLIC_API_PREFIX)) {
    return NextResponse.next({ request: { headers: withNonce(req) } });
  }

  if (logicalPath.startsWith(AGENT_API_PREFIX)) {
    return NextResponse.next();
  }

  const token = req.cookies.get("token")?.value;

  if (!token) {
    if (isApiRoute) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL(`${BASE_PATH}/login`, req.url));
  }

  const user = await verifyToken(token);
  if (!user) {
    if (isApiRoute) {
      const res = NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      res.cookies.delete("token");
      return res;
    }
    const res = NextResponse.redirect(new URL(`${BASE_PATH}/login`, req.url));
    res.cookies.delete("token");
    return res;
  }

  return NextResponse.next({ request: { headers: withNonce(req) } });
}

export const config = {
  matcher: [
    // Root path (e.g. /phniams with no trailing slash) must be explicit;
    // the compiled basePath regex for the pattern below requires a subpath.
    "/",
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
