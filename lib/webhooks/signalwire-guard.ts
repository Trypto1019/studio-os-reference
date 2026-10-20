/**
 * Guard applied to every telephony webhook (sms-inbound, sms-status,
 * voice-inbound, voice-status, conference-status): read the raw body once,
 * rebuild the URL from the trusted public origin, verify, and only then
 * hand parsed params to the handler. Unsigned or mis-signed requests get a
 * uniform 403 with no detail.
 */

import { getSignalWireSignature, verifySignalWireSignature } from "./signatures.ts";

export type TelephonyHandler = (params: Record<string, string>, req: Request) => Promise<Response>;

export function withSignalWireSignature(
  opts: { publicUrl: string; signingKey: string | undefined },
  handler: TelephonyHandler,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const rawBody = await req.text();
    const incoming = new URL(req.url);
    // Trusted origin + the request's own path/query. Never req Host / XFF.
    const url = `${opts.publicUrl}${incoming.pathname}${incoming.search}`;
    const params = Object.fromEntries(new URLSearchParams(rawBody));
    const ok = verifySignalWireSignature({
      url,
      params,
      rawBody,
      signature: getSignalWireSignature(req.headers),
      signingKey: opts.signingKey,
    });
    if (!ok) return new Response("Forbidden", { status: 403 });
    return handler(params, req);
  };
}
