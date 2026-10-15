import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress } from 'viem';
import { channelUserHash, lineConsentData, lineTextEvent, seal, unseal, verifyLineSignature, LINE_SCOPE } from '../src/chat-security.js';

describe('LINE proof boundary', () => {
  it('verifies the unmodified body and rejects a wrong channel, changed body and malformed signature', () => {
    const body = '{"events":[]}', secret = 'channel-secret', signature = createHmac('sha256', secret).update(body).digest('base64');
    expect(() => verifyLineSignature(body, signature, secret)).not.toThrow();
    expect(() => verifyLineSignature(body + ' ', signature, secret)).toThrow();
    expect(() => verifyLineSignature(body, signature, 'another-channel')).toThrow();
    for (const value of [undefined, '', 'invalid', signature + 'garbage']) expect(() => verifyLineSignature(body, value, secret)).toThrow();
  });
  it('encrypts channel identities with purpose binding and rejects ciphertext edits', () => {
    const key = randomBytes(32).toString('base64'), value = seal(key, 'line-user:one', 'U' + 'a'.repeat(32));
    expect(unseal(key, 'line-user:one', value)).toBe('U' + 'a'.repeat(32));
    expect(() => unseal(key, 'line-user:two', value)).toThrow();
    const parts = value.split('.'); parts[2] = 'A' + parts[2].slice(1);
    if (parts.join('.') !== value) expect(() => unseal(key, 'line-user:one', parts.join('.'))).toThrow();
  });
  it('only accepts the bound direct sender and a unique text event', () => {
    const id = 'evt', user = 'U' + 'a'.repeat(32), event = { webhookEventId: id, type: 'message', source: { type: 'user', userId: user }, message: { type: 'text', text: 'お米10kg買っといて' }, timestamp: Date.now() };
    expect(lineTextEvent(JSON.stringify({ events: [event] }), id, channelUserHash(user)).text).toBe(event.message.text);
    expect(() => lineTextEvent(JSON.stringify({ events: [event, event] }), id, channelUserHash(user))).toThrow();
    expect(() => lineTextEvent(JSON.stringify({ events: [event] }), id, channelUserHash('different'))).toThrow();
    expect(() => lineTextEvent(JSON.stringify({ events: [{ ...event, source: { ...event.source, type: 'group' } }] }), id, channelUserHash(user))).toThrow();
  });
  it('binds the wallet signature to the LINE identity, policy, email, chain and expiry', async () => {
    const account = privateKeyToAccount(generatePrivateKey()), gate = '0x' + '12'.repeat(20);
    const consent = { account: account.address, connectionId: '11111111-1111-4111-8111-111111111111', lineUserHash: 'ab'.repeat(32), policyId: '0x' + 'cd'.repeat(32), emailHash: 'ef'.repeat(32), scope: LINE_SCOPE, nonce: '0x' + '01'.repeat(32), validUntil: 2000000000 };
    const data = lineConsentData(consent, 80002, gate), signature = await account.signTypedData(data as any);
    expect(await recoverTypedDataAddress({ ...data, signature } as any)).toBe(account.address);
    for (const changed of [{ ...consent, lineUserHash: '11'.repeat(32) }, { ...consent, policyId: '0x' + '11'.repeat(32) }, { ...consent, validUntil: consent.validUntil + 1 }, { ...consent, emailHash: '22'.repeat(32) }]) {
      expect(await recoverTypedDataAddress({ ...lineConsentData(changed, 80002, gate), signature } as any)).not.toBe(account.address);
    }
    expect(await recoverTypedDataAddress({ ...lineConsentData(consent, 1, gate), signature } as any)).not.toBe(account.address);
  });
});
