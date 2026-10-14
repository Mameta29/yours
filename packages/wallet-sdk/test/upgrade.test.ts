import { describe, expect, it, vi } from 'vitest';
import { toHex, type EIP1193Provider, type PublicClient } from 'viem';
import { ensureGateSmartAccount } from '../src/upgrade.js';

const owner = toHex(1, { size: 20 }), implementation = toHex(2, { size: 20 });
const id = toHex(3, { size: 32 }), txHash = toHex(4, { size: 32 }), blockHash = toHex(5, { size: 32 });
const code = `0xef0100${implementation.slice(2)}`;
function fixture() {
  let currentCode: string | undefined, chain = '0x13882';
  const status = { id, version: '2.0.0', chainId: chain, status: 200, atomic: true, receipts: [{ status: '0x1', transactionHash: txHash }] };
  const request = vi.fn(async ({ method, params }: { method: string; params?: any[] }) => {
    if (method === 'eth_chainId') return chain;
    if (method === 'eth_accounts') return [owner];
    if (method === 'wallet_getCapabilities') return { '0x13882': { atomic: { status: 'ready' } } };
    if (method === 'wallet_sendCalls') {
      // MetaMask 13.48 / eip-5792-middleware 3.0.3 uses optional(StrictHexStruct)
      // for data: omitted is valid, but an explicit empty "0x" is rejected.
      // Reproduce the reported RPC boundary instead of accepting any payload.
      for (const call of params![0].calls) {
        if (call.data !== undefined && (typeof call.data !== 'string' || !/^0x[0-9a-f]+$/.test(call.data))) {
          throw { code: -32602, message: 'Invalid params: calls.data must be omitted or nonempty hex' };
        }
      }
      return { id };
    }
    if (method === 'wallet_getCallsStatus') return status;
    throw new Error('unexpected_method');
  });
  const waitForTransactionReceipt = vi.fn(async () => { currentCode = code; return { status: 'success', blockHash, blockNumber: 10n }; });
  const getCode = vi.fn(async () => currentCode);
  const client = { getChainId: async () => 80002, getCode, waitForTransactionReceipt, getBlock: async () => ({ hash: blockHash }) } as unknown as PublicClient;
  const options = { provider: { request } as unknown as EIP1193Provider, client, owner, implementation, chainId: 80002, onSubmitted: vi.fn(), onSettled: vi.fn() };
  return { options, request, status, getCode, waitForTransactionReceipt, setCode: (value: string) => { currentCode = value; }, switchChain: () => { chain = '0x1'; } };
}
describe('explicit owner smart-account upgrade', () => {
  it('sends only two zero-value self calls, persists the ID and requires canonical five-confirmation code', async () => {
    const f = fixture();
    await ensureGateSmartAccount(f.options);
    expect(f.request.mock.calls.find(([r]) => r.method === 'wallet_sendCalls')).toEqual([{ method: 'wallet_sendCalls', params: [{ version: '2.0.0', from: owner, chainId: '0x13882', atomicRequired: true, calls: [{ to: owner, value: '0x0' }, { to: owner, value: '0x0' }] }] }]);
    expect(f.options.onSubmitted).toHaveBeenCalledWith(id);
    expect(f.options.onSubmitted.mock.invocationCallOrder[0]).toBeLessThan(f.waitForTransactionReceipt.mock.invocationCallOrder[0]!);
    expect(f.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: txHash, confirmations: 5, timeout: 180000 });
    expect(f.getCode).toHaveBeenCalledWith({ address: owner, blockNumber: 10n });
    expect(f.options.onSettled).toHaveBeenCalledOnce();
  });
  it('resumes a saved batch without another request or discarding its journal on an uncertain error', async () => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async args => { if (args.method === 'wallet_getCallsStatus') throw new Error('offline'); return original(args); });
    await expect(ensureGateSmartAccount({ ...f.options, pendingBatchId: id })).rejects.toThrow('wallet_upgrade_request_failed');
    expect(f.request.mock.calls.some(([r]) => r.method === 'wallet_sendCalls')).toBe(false);
    expect(f.options.onSettled).not.toHaveBeenCalled();
    f.request.mockImplementation(original);
    await ensureGateSmartAccount({ ...f.options, pendingBatchId: id });
    expect(f.options.onSubmitted).not.toHaveBeenCalled();
  });
  it('does not treat a successful transaction as proof that EIP-7702 was applied', async () => {
    const f = fixture(); f.waitForTransactionReceipt.mockImplementation(async () => ({ status: 'success', blockHash, blockNumber: 10n }));
    await expect(ensureGateSmartAccount(f.options)).rejects.toThrow('wallet_upgrade_not_applied');
    expect(f.options.onSettled).not.toHaveBeenCalled();
  });
  it('rejects a forged batch chain or receipt and keeps the batch for recovery', async () => {
    const f = fixture(); f.status.chainId = '0x1';
    await expect(ensureGateSmartAccount(f.options)).rejects.toThrow('wallet_upgrade_response_invalid');
    expect(f.waitForTransactionReceipt).not.toHaveBeenCalled();
    expect(f.options.onSettled).not.toHaveBeenCalled();
  });
  it('never upgrades over another implementation and skips already configured accounts', async () => {
    const f = fixture(); f.setCode('0xef0100' + toHex(99, { size: 20 }).slice(2));
    await expect(ensureGateSmartAccount(f.options)).rejects.toThrow('wallet_implementation_mismatch');
    f.setCode(code); await ensureGateSmartAccount(f.options);
    expect(f.request.mock.calls.every(([r]) => !r.method.startsWith('wallet_'))).toBe(true);
  });
  it.each([4001, 5750, -32002, 5760])('never retries a rejected or uncertain prompt (%s)', async rpcCode => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async args => { if (args.method === 'wallet_sendCalls') throw { code: rpcCode }; return original(args); });
    await expect(ensureGateSmartAccount(f.options)).rejects.toThrow();
    expect(f.request.mock.calls.filter(([r]) => r.method === 'wallet_sendCalls')).toHaveLength(1);
    expect(f.options.onSubmitted).not.toHaveBeenCalled();
  });
  it('does not prompt if the active account chain changed or atomic upgrade is unavailable', async () => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async args => args.method === 'wallet_getCapabilities' ? {} : original(args));
    await expect(ensureGateSmartAccount(f.options)).rejects.toThrow('wallet_upgrade_unsupported');
    f.switchChain();
    await expect(ensureGateSmartAccount(f.options)).rejects.toThrow('wallet_chain_mismatch');
    expect(f.request.mock.calls.some(([r]) => r.method === 'wallet_sendCalls')).toBe(false);
  });
});
