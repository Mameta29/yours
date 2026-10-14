import { describe, expect, it, vi } from 'vitest';
import { encodePacked, maxUint256, toHex, verifyTypedData, type EIP1193Provider, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { SIGNABLE_DELEGATION_TYPED_DATA, toDelegationStruct } from '@metamask/smart-accounts-kit/utils';
import { encodeDelegations, gatePermissionRequests, isExpected7702Code, probeGatePermissions, requestGatePermissions, verifyParentSignatures, type Delegation, type GrantExpectation } from '../src/index.js';
const a = (n: number) => toHex(n, { size: 20 });
const owner = privateKeyToAccount(toHex(1, { size: 32 }));
const e: GrantExpectation = { chainId: 137, owner: owner.address, agent: a(2), manager: a(3), token: a(4), gate: a(5), startTime: 100n, expiry: 1000n, funding: false,
  enforcers: { periodic: a(10), redeemer: a(11), timestamp: a(12), value: a(13), nonce: a(14), transferAmount: a(15), calldata: a(16) } };
function root(): Delegation {
  return { delegate: e.agent, delegator: e.owner, authority: toHex(maxUint256, { size: 32 }), salt: '0x01', signature: toHex(1, { size: 65 }), caveats: [
    { enforcer: e.enforcers.periodic, terms: encodePacked(['address', 'uint256', 'uint256', 'uint256'], [e.token, maxUint256, maxUint256, e.startTime]), args: '0x' },
    { enforcer: e.enforcers.redeemer, terms: e.gate, args: '0x' },
    { enforcer: e.enforcers.timestamp, terms: encodePacked(['uint128', 'uint128'], [0n, e.expiry]), args: '0x' },
    { enforcer: e.enforcers.value, terms: toHex(0, { size: 32 }), args: '0x' },
    { enforcer: e.enforcers.nonce, terms: toHex(0, { size: 32 }), args: '0x' },
  ] };
}
const response = () => ({ chainId: '0x89', from: e.owner, to: e.agent, delegationManager: e.manager, context: encodeDelegations([root()]), dependencies: [],
  permission: { type: 'erc20-token-allowance', isAdjustmentAllowed: false, data: { tokenAddress: e.token, allowanceAmount: toHex(maxUint256), startTime: 100 } },
  rules: [{ type: 'expiry', data: { timestamp: 1000 } }, { type: 'redeemer', data: { addresses: [e.gate] } }],
});
function mockWallet() {
  let chain = '0x89';
  const request = vi.fn(async ({ method }: { method: string; params?: unknown }) => {
    if (method === 'eth_chainId') return chain;
    if (method === 'eth_accounts') return [e.owner];
    if (method === 'wallet_getSupportedExecutionPermissions') return { 'erc20-token-allowance': { chainIds: ['0x89'], ruleTypes: ['expiry', 'redeemer', 'payee'] } };
    if (method === 'wallet_requestExecutionPermissions') return [response()];
    throw new Error('Unexpected RPC method');
  });
  return { provider: { request } as unknown as EIP1193Provider, request, switchChain: () => { chain = '0x1'; } };
}
describe('wallet grant requests and evidence boundary', () => {
  it('never retries a permission prompt after an uncertain wallet error', async () => {
    const w = mockWallet(), original = w.request.getMockImplementation()!;
    w.request.mockImplementation(async args => {
      if (args.method === 'wallet_requestExecutionPermissions') throw new Error('Connection lost after prompt');
      return original(args);
    });
    await expect(requestGatePermissions(w.provider,[e])).rejects.toThrow('wallet_permission_request_failed');
    expect(w.request.mock.calls.filter(([r]) => r.method === 'wallet_requestExecutionPermissions')).toHaveLength(1);
  });
  it.each([
    [4001, 'wallet_rejected'],
    [-32002, 'wallet_permission_pending'],
    [-32601, 'wallet_permission_unsupported'],
  ])('explains a wallet permission RPC failure (%s)', async (code, expected) => {
    const w = mockWallet(), original = w.request.getMockImplementation()!;
    w.request.mockImplementation(async args => {
      if (args.method === 'wallet_requestExecutionPermissions') throw { code, message: 'Wallet request failed' };
      return original(args);
    });
    await expect(requestGatePermissions(w.provider, [e])).rejects.toThrow(expected);
    expect(w.request.mock.calls.filter(([r]) => r.method === 'wallet_requestExecutionPermissions')).toHaveLength(1);
  });
  it.each([-32601, 4200])('distinguishes connection from unsupported permissions (%s)', async code => {
    const w = mockWallet(), original = w.request.getMockImplementation()!;
    w.request.mockImplementation(async args => {
      if (args.method === 'wallet_getSupportedExecutionPermissions') throw {code,message:'Unsupported method'};
      return original(args);
    });
    await expect(probeGatePermissions(w.provider,137,e.owner)).rejects.toThrow('wallet_permission_unsupported');
    expect(w.request.mock.calls.some(([r]) => r.method === 'wallet_requestExecutionPermissions')).toBe(false);
  });
  it('identifies a capability probe error before requesting permissions', async () => {
    const w = mockWallet(), original = w.request.getMockImplementation()!;
    w.request.mockImplementation(async args => {
      if (args.method === 'wallet_getSupportedExecutionPermissions') throw { code: -32603, message: 'Provider failed' };
      return original(args);
    });
    await expect(probeGatePermissions(w.provider, 137, e.owner)).rejects.toThrow('wallet_permission_probe_failed');
    expect(w.request.mock.calls.some(([r]) => r.method === 'wallet_requestExecutionPermissions')).toBe(false);
  });
  it('keeps the business exception compatible with a MaxUint256 root and fixed Gate redemption', () => {
    const [payment, funding] = gatePermissionRequests([e, { ...e, token: a(6), funding: true }]);
    expect(payment?.permission.data.allowanceAmount).toBe(maxUint256); expect(payment?.redeemer).toEqual([e.gate]);
    expect(funding?.payee).toEqual([e.gate]); expect(payment?.payee).toBeUndefined();
    expect(() => gatePermissionRequests([e, { ...e, chainId: 1, token: a(6) }])).toThrow('Inconsistent permission set');
  });
  it('uses the pinned SDK raw format and checks the returned permission context', async () => {
    const { provider, request } = mockWallet();
    expect((await probeGatePermissions(provider, 137, e.owner)).canRequest).toBe(true);
    expect((await requestGatePermissions(provider, [e])).grants).toHaveLength(1);
    const raw = request.mock.calls.find(([r]) => r.method === 'wallet_requestExecutionPermissions')?.[0].params as Record<string, unknown>[];
    expect(raw[0]).toMatchObject({ chainId: '0x89', from: e.owner, to: e.agent, rules: [{ type: 'expiry', data: { timestamp: 1000 } }, { type: 'redeemer', data: { addresses: [e.gate] } }] });
    expect(raw[0]).not.toHaveProperty('expiry');
    expect(raw[0]).toHaveProperty('permission.data.allowanceAmount', toHex(maxUint256));
  });
  it('does not request a permission after a chain switch and requires the exact 7702 code', async () => {
    const w = mockWallet(); w.switchChain();
    await expect(requestGatePermissions(w.provider, [e])).rejects.toThrow('wallet_chain_mismatch');
    expect(w.request.mock.calls.some(([r]) => r.method === 'wallet_requestExecutionPermissions')).toBe(false);
    expect(isExpected7702Code(`0xef0100${a(99).slice(2)}`, a(99))).toBe(true);
    expect(isExpected7702Code(`0xef0100${a(99).slice(2)}00`, a(99))).toBe(false);
  });
  it('verifies real ECDSA signatures and both manager and nonce revocation', async () => {
    const parent = root();
    parent.signature = await owner.signTypedData({ domain: { name: 'DelegationManager', version: '1', chainId: 137, verifyingContract: e.manager },
      types: SIGNABLE_DELEGATION_TYPED_DATA, primaryType: 'Delegation', message: toDelegationStruct(parent) });
    const readContract = vi.fn(async ({ functionName }): Promise<boolean | bigint> => functionName === 'disabledDelegations' ? false : 0n);
    const client = { getChainId: async () => 137, verifyTypedData, readContract } as unknown as PublicClient;
    await expect(verifyParentSignatures(client, [parent], e)).resolves.toBeUndefined();
    await expect(verifyParentSignatures(client, [{ ...parent, delegate: a(66) }], e)).rejects.toThrow('invalid_parent_signature');
    readContract.mockImplementation(async ({ functionName }) => functionName === 'disabledDelegations' ? false : 1n);
    await expect(verifyParentSignatures(client, [parent], e)).rejects.toThrow('parent_nonce_revoked');
    readContract.mockResolvedValue(true);
    await expect(verifyParentSignatures(client, [parent], e)).rejects.toThrow('parent_revoked');
  });
});
