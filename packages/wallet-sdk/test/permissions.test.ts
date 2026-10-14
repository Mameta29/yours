import { it, expect } from 'vitest';
import { encodePacked, maxUint256, toHex, type Address } from 'viem';
import { validateParents, validatePermissionResponse, encodeDelegations, parentChainHash, type GrantExpectation, type Delegation } from '../src/index.js';

const address = (n: number) => toHex(n, { size: 20 });
const e: GrantExpectation = { chainId: 11155111, owner: address(1), agent: address(2), manager: address(3), token: address(4), gate: address(5), startTime: 100n, expiry: 1000n, funding: false,
  enforcers: { periodic: address(10), redeemer: address(11), timestamp: address(12), value: address(13), nonce: address(14), transferAmount: address(15), calldata: address(16) } };
function root(): Delegation {
  return { delegate: e.agent, delegator: e.owner, authority: toHex(maxUint256, { size: 32 }), salt: '0x01', signature: toHex(1, { size: 65 }), caveats: [
    { enforcer: e.enforcers.periodic, terms: encodePacked(['address', 'uint256', 'uint256', 'uint256'], [e.token, maxUint256, maxUint256, e.startTime]), args: '0x' },
    { enforcer: e.enforcers.redeemer, terms: e.gate, args: '0x' },
    { enforcer: e.enforcers.timestamp, terms: encodePacked(['uint128', 'uint128'], [0n, e.expiry]), args: '0x' },
    { enforcer: e.enforcers.value, terms: toHex(0, { size: 32 }), args: '0x' },
  ] };
}
it('validates the signed chain restrictions and commits hashes, not signatures', () => {
  const r = root();
  expect(validateParents(encodeDelegations([r]), e).grantChainHash).toBe(parentChainHash([r]));
  expect(parentChainHash([r])).toBe(parentChainHash([{ ...r, signature: toHex(2, { size: 65 }) }]));
});
for (const [name, mutate] of Object.entries({
  'gate restriction removed': r => { r.caveats.splice(1, 1); },
  'gate changed to agent': r => { r.caveats[1]!.terms = e.agent; },
  'extra redeemer': r => { r.caveats[1]!.terms = encodePacked(['address', 'address'], [e.gate, e.agent]); },
  'token changed': r => { r.caveats[0]!.terms = encodePacked(['address', 'uint256', 'uint256', 'uint256'], [address(99), maxUint256, maxUint256, e.startTime]); },
  'expiry expanded': r => { r.caveats[2]!.terms = encodePacked(['uint128', 'uint128'], [0n, e.expiry + 1n]); },
  'unknown enforcer': r => { r.caveats.push({ enforcer: address(99), terms: '0x', args: '0x' }); },
  'mutable args': r => { r.caveats[0]!.args = '0x00'; },
  'agent-controlled parent': r => { r.delegator = e.agent; },
  'another owner': r => { r.delegator = address(88); },
  'another agent': r => { r.delegate = address(88); },
  'unsigned parent': r => { r.signature = '0x'; },
} satisfies Record<string, (r: Delegation) => void>)) {
  it(`rejects ${name}`, () => { const r = root(); mutate(r); expect(() => validateParents(encodeDelegations([r]), e)).toThrow(); });
}
it('requires an input grant to fix payee to Gate', () => {
  const r = root();
  expect(() => validateParents(encodeDelegations([r]), { ...e, funding: true })).toThrow();
  r.caveats.push({ enforcer: e.enforcers.calldata, terms: encodePacked(['uint256', 'uint256'], [4n, BigInt(e.gate)]), args: '0x' });
  expect(validateParents(encodeDelegations([r]), { ...e, funding: true }).parents).toHaveLength(1);
});
it('rejects wrong response chain and manager even if context is valid', () => {
  const response = { chainId: e.chainId, from: e.owner, to: e.agent, delegationManager: e.manager, context: encodeDelegations([root()]), dependencies: [],
    permission: { type: 'erc20-token-allowance', isAdjustmentAllowed: false, data: { tokenAddress: e.token, allowanceAmount: maxUint256, startTime: Number(e.startTime) } },
    rules: [{ type: 'expiry', data: { timestamp: Number(e.expiry) } }, { type: 'redeemer', data: { addresses: [e.gate] } }],
  };
  expect(validatePermissionResponse(response, e).parents).toHaveLength(1);
  expect(() => validatePermissionResponse({ ...response, rules: [] }, e)).toThrow();
  expect(() => validatePermissionResponse({ ...response, chainId: 1 }, e)).toThrow();
  expect(() => validatePermissionResponse({ ...response, delegationManager: address(99) }, e)).toThrow();
});
