import { randomUUID } from 'node:crypto';
import { DomainError, sha256 } from '@yours/domain';
import type { P256Signer } from '@yours/signing';
import type { Config } from './config.js';
import { verifyLineSignature } from './chat-security.js';

/** Reuses the existing EC's LINE channel without copying its channel secret.
 * The EC bridge accepts sends/token exchanges only from the pinned yours HSM.
 * Verification is a read-only HMAC check against the original LINE request. */
export async function lineBridge(config: Config, signer: P256Signer | undefined, payload?: unknown) {
  if (!config.LINE_BRIDGE_URL) throw new DomainError('line_not_configured', 503);
  const url = new URL(config.LINE_BRIDGE_URL);
  if (url.protocol !== 'https:' && !(config.NODE_ENV === 'test' && url.hostname === '127.0.0.1')) throw new DomainError('line_bridge_invalid', 503);
  const body = payload === undefined ? undefined : JSON.stringify(payload), headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (body && signer) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: signer.kid, typ: 'yours-line-bridge+jwt' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: config.PUBLIC_ORIGIN, aud: config.LINE_BRIDGE_URL, iat: now, exp: now + 30, jti: randomUUID(), body_sha256: sha256(body) })).toString('base64url');
    const input = header + '.' + claims;
    headers.Authorization = 'Bearer ' + input + '.' + Buffer.from(await signer.sign(Buffer.from(input))).toString('base64url');
  }
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', body, headers, redirect: 'error', signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new DomainError('line_bridge_unavailable', 503);
  const text = await response.text();
  if (text.length > 65536) throw new DomainError('line_bridge_response_invalid', 502);
  return JSON.parse(text) as any;
}
export async function verifyIncomingLine(config: Config, raw: string, signature?: string) {
  if (config.LINE_CHANNEL_SECRET) { verifyLineSignature(raw, signature, config.LINE_CHANNEL_SECRET); return; }
  if (!signature || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) throw new DomainError('line_signature_invalid', 401);
  const result = await lineBridge(config, undefined, { operation: 'verify', raw, signature });
  if (result.valid !== true) throw new DomainError('line_signature_invalid', 401);
}
