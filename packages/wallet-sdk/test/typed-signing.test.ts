import { describe, expect, it, vi } from 'vitest';
import { toHex, verifyTypedData, type EIP1193Provider } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { signOwnerTypedData } from '../src/wallet.js';

const owner = privateKeyToAccount(toHex(1, { size: 32 }));
const data = {
  domain: { name: 'PurchaseGate', version: '1', chainId: 80002, verifyingContract: toHex(2, { size: 20 }) },
  types: { Consent: [{ name: 'amount', type: 'uint256' }] },
  primaryType: 'Consent', message: { amount: 2000n * 10n ** 18n },
} as const;

describe('browser owner signatures', () => {
  it('sends explicit domain types and preserves the onchain signature digest', async () => {
    const request = vi.fn(async ({ method, params }: { method: string; params?: any[] }) => {
      if (method === 'eth_chainId') return '0x13882';
      if (method === 'eth_accounts') return [owner.address];
      if (method === 'eth_signTypedData_v4') {
        expect(params![0]).toBe(owner.address);
        const raw = JSON.parse(params![1]);
        expect(raw.types.EIP712Domain).toEqual([
          { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
        ]);
        expect(raw.domain).toEqual(data.domain);
        expect(raw.message.amount).toBe(data.message.amount.toString());
        return owner.signTypedData(raw);
      }
      throw new Error('unexpected method');
    });
    const signature = await signOwnerTypedData({ request } as unknown as EIP1193Provider, 80002, owner.address, data);
    expect(await verifyTypedData({ ...data, address: owner.address, signature })).toBe(true);
    expect(request.mock.calls.filter(([r]) => r.method === 'eth_signTypedData_v4')).toHaveLength(1);
  });
  it('preserves the RPC reason without retrying a rejected signature', async () => {
    const request = vi.fn(async ({ method }) => {
      if (method === 'eth_chainId') return '0x13882';
      if (method === 'eth_accounts') return [owner.address];
      throw { code: 4001, message: 'User rejected the request' };
    });
    await expect(signOwnerTypedData({ request } as unknown as EIP1193Provider, 80002, owner.address, data)).rejects.toMatchObject({
      message: 'wallet_rejected', diagnostic: { method: 'eth_signTypedData_v4', code: 4001 },
    });
    expect(request.mock.calls.filter(([r]) => r.method === 'eth_signTypedData_v4')).toHaveLength(1);
  });
  it('never requests a raw owner delegation, a different chain or a changed owner', async () => {
    const request = vi.fn(async ({ method }) => method === 'eth_chainId' ? '0x13882' : [toHex(99, { size: 20 })]);
    const provider = { request } as unknown as EIP1193Provider;
    await expect(signOwnerTypedData(provider, 80002, owner.address, { ...data, primaryType: 'Delegation' } as any)).rejects.toThrow('wallet_permission_request_required');
    await expect(signOwnerTypedData(provider, 1, owner.address, data)).rejects.toThrow('wallet_chain_mismatch');
    expect(request).not.toHaveBeenCalled();
    await expect(signOwnerTypedData(provider, 80002, owner.address, data)).rejects.toThrow('wallet_account_changed');
    expect(request.mock.calls.some(([r]) => r.method === 'eth_signTypedData_v4')).toBe(false);
  });
});
