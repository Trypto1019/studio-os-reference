// Thin Next.js 14 adapter for the framework-free policy in ../../middleware.ts.
// Not compiled by this repo's CI (Next.js is intentionally not a dependency);
// copy into a Next app root as `middleware.ts`.
import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { decide } from "../../middleware";
import { loadConfig } from "../../lib/config";

const config = loadConfig();

export async function middleware(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  const d = decide(
    {
      host: req.headers.get("host") ?? "",
      pathname: req.nextUrl.pathname,
      headers: req.headers,
      staffSession: token?.id ? { id: String(token.id), mustChangePassword: token.mustChangePassword === true } : null,
    },
    config,
    process.env,
  );
  switch (d.type) {
    case "next":
      return NextResponse.next();
    case "rewrite": {
      const url = req.nextUrl.clone();
      url.pathname = d.pathname;
      return NextResponse.rewrite(url);
    }
    case "redirect":
      return NextResponse.redirect(new URL(d.location, req.url), d.status);
    case "json":
      return NextResponse.json(d.body, { status: d.status });
    case "not_found":
      return new NextResponse("Not found", { status: 404 });
  }
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
