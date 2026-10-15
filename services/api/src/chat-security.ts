import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { keccak256, stringToHex } from 'viem';
import { DomainError, sha256 } from '@yours/domain';

export const LINE_SCOPE = 'Execute explicit purchase requests from this LINE account under my active yours policy. Exceptions require my explicit approval of that exact order from this LINE account.';
export function seal(key: string, purpose: string, value: string): string {
  const bytes = Buffer.from(key, 'base64');
  if (bytes.length !== 32) throw new Error('chat_encryption_key_invalid');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', bytes, iv);
  cipher.setAAD(Buffer.from(purpose));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}
export function unseal(key: string, purpose: string, value: string): string {
  const [v, iv, data, tag, extra] = value.split('.');
  if (v !== 'v1' || !iv || data === undefined || !tag || extra) throw new Error('cipher_invalid');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(purpose)); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
export function verifyLineSignature(body: string, signature: string | undefined, secret: string): void {
  if (!secret || !signature || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) throw new DomainError('line_signature_invalid', 401);
  const expected = createHmac('sha256', secret).update(body).digest(), actual = Buffer.from(signature, 'base64');
  if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw new DomainError('line_signature_invalid', 401);
}
export const channelUserHash = (userId: string) => sha256('line:' + userId);
export function lineConsentData(consent: any, chainId: number, gate: string) {
  return {
    domain: { name: 'yours LINE Consent', version: '1', chainId, verifyingContract: gate },
    types: { LineConsent: [
      { name: 'account', type: 'address' }, { name: 'connectionId', type: 'bytes32' },
      { name: 'lineUserHash', type: 'bytes32' }, { name: 'policyId', type: 'bytes32' },
      { name: 'emailHash', type: 'bytes32' }, { name: 'scope', type: 'string' },
      { name: 'nonce', type: 'bytes32' }, { name: 'validUntil', type: 'uint64' },
    ] }, primaryType: 'LineConsent',
    message: { account: consent.account, connectionId: keccak256(stringToHex(consent.connectionId)),
      lineUserHash: '0x' + consent.lineUserHash, policyId: consent.policyId, emailHash: '0x' + consent.emailHash,
      scope: LINE_SCOPE, nonce: consent.nonce, validUntil: String(consent.validUntil) },
  };
}

/** Only direct, text messages from the signed webhook can become tasks. */
export function lineTextEvent(raw: string, eventId: string, userHash: string) {
  const body = JSON.parse(raw), events = Array.isArray(body.events) ? body.events : [];
  const matches = events.filter((e: any) => e.webhookEventId === eventId);
  if (matches.length !== 1) throw new DomainError('line_event_invalid', 403);
  const event = matches[0];
  if (event.type !== 'message' || event.source?.type !== 'user' || event.message?.type !== 'text' ||
      typeof event.source.userId !== 'string' || channelUserHash(event.source.userId) !== userHash ||
      typeof event.message.text !== 'string' || !event.message.text.trim() || event.message.text.length > 2000) {
    throw new DomainError('line_event_invalid', 403);
  }
  return { text: event.message.text.trim(), timestamp: event.timestamp, userId: event.source.userId };
}
