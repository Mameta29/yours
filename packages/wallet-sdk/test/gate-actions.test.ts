import { describe, expect, it } from 'vitest';
import { parseGateAction } from '../src/wire.js';
const input = { kind: 'revoke', account: `0x${'11'.repeat(20)}`, policyId: `0x${'22'.repeat(32)}`, nonce: '1', validUntil: '2000000000', signature: `0x${'33'.repeat(65)}` };
describe('fixed Gate lifecycle requests', () => {
  it('converts canonical bounded integers and rejects arbitrary calls', () => {
    expect(parseGateAction(input).nonce).toBe(1n);
    for (const change of [{ kind: 'execute' }, { data: '0x1234' }, { to: input.account }, { nonce: '-1' }, { nonce: (2n ** 64n).toString() }, { signature: '0x' }]) {
      expect(() => parseGateAction({ ...input, ...change })).toThrow();
    }
  });
});
