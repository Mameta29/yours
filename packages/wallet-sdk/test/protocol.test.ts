import { describe, it, expect } from 'vitest';
import { toHex, type Address, type Hex } from 'viem';
import vectors from './vectors.json';
import { gateTypes, structHash, digest, merchantSetHash, assetLimitsHash, relayerSetHash, grantsHash, requirementsHash, fairInputAtomic, evidenceDigest, paymentKeyId, amountSchema } from '../src/index.js';

describe('35 signed ABI reference vectors (generated before implementation)', () => {
  for (const [name, fixture] of Object.entries(vectors.fixtures)) {
    it(name, () => {
      const primaryType = name as keyof typeof gateTypes;
      expect(gateTypes[primaryType]).toEqual(vectors.types[name as keyof typeof vectors.types]);
      expect(structHash(primaryType, fixture.message)).toBe(fixture.structHash);
      expect(digest({ ...vectors.domain, verifyingContract: vectors.domain.verifyingContract as Address }, primaryType, fixture.message)).toBe(fixture.digest);
    });
  }
  it('matches collection and requirements commitments', () => {
    const p = vectors.fixtures.Policy.message;
    expect(merchantSetHash(vectors.arrays.shops as never)).toBe(p.merchantSetHash);
    expect(assetLimitsHash(vectors.arrays.assets as never)).toBe(p.assetLimitsHash);
    expect(relayerSetHash(vectors.arrays.relayers as Address[])).toBe(p.relayerSetHash);
    expect(grantsHash([vectors.fixtures.GrantBinding.message] as never)).toBe(vectors.fixtures.PolicyRegistration.message.grantsHash);
    expect(requirementsHash(vectors.domain.chainId, vectors.domain.verifyingContract as Address, vectors.fixtures.PurchaseOrder.message as never)).toBe(vectors.fixtures.PurchaseOrder.message.requirementsHash);
  });
});
describe('amounts and identities', () => {
  it('accounts for input depeg with integer upward rounding', () => {
    expect(fairInputAtomic(1000n * 10n ** 18n, 6, 100n, 15000n, 1000000n, 1000000n)).toBe(6666667n);
    expect(fairInputAtomic(1000n * 10n ** 18n, 6, 100n, 15000n, 500000n, 1000000n)).toBe(13333334n);
  });
  it('rejects lossy or noncanonical monetary input', () => {
    for (const v of [1, '01', '1.0', '-1', '1e18', (2n ** 256n).toString()]) expect(amountSchema.safeParse(v).success).toBe(false);
  });
  it('does not treat different JSON property ordering as changed evidence', () => {
    expect(evidenceDigest({ b: 2, a: 'x' })).toBe(evidenceDigest({ a: 'x', b: 2 }));
    expect(evidenceDigest({ b: 3, a: 'x' })).not.toBe(evidenceDigest({ a: 'x', b: 2 }));
  });
  it('never includes revision, intent, root, or agent in settlement uniqueness', () => {
    const key = { method: 'erc7710' as const, network: 'eip155:11155111', payer: toHex(1, { size: 20 }), gate: toHex(2, { size: 20 }), orderId: toHex(3, { size: 32 }) };
    expect(paymentKeyId(key)).toBe(`erc7710:eip155:11155111:${key.payer}:${key.gate}:${key.orderId}`);
    expect(() => paymentKeyId({ ...key, revisionId: toHex(4, { size: 32 }) } as never)).toThrow();
  });
  it('rejects ambiguous set ordering and duplicate entries', () => {
    expect(() => relayerSetHash([toHex(2, { size: 20 }), toHex(1, { size: 20 })])).toThrow();
    expect(() => merchantSetHash([vectors.arrays.shops[0], vectors.arrays.shops[0]] as never)).toThrow();
  });
});
