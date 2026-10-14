import { decodeDelegations, encodeDelegations, hashDelegation } from '@metamask/smart-accounts-kit/utils';
import { encodeAbiParameters, encodePacked, keccak256, maxUint256, size, slice, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { LIMITS } from './protocol.js';
import { hexSchema } from './wire.js';
import { z } from 'zod';
import { addressSchema } from './wire.js';

export type Enforcers = { periodic: Address; redeemer: Address; timestamp: Address; value: Address; nonce: Address; transferAmount: Address; calldata: Address };
export type GrantExpectation = { chainId: number; manager: Address; owner: Address; agent: Address; token: Address; gate: Address; expiry: bigint; startTime: bigint; enforcers: Enforcers; funding: boolean };
export type Delegation = ReturnType<typeof decodeDelegations>[number];
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export function parentChainHash(parents: Delegation[]): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes32[]' }], [parents.map(hashDelegation)]));
}
/** Validate the actual signed parent chain, independently of wallet UI metadata. */
export function validateParents(context: Hex, e: GrantExpectation): { parents: Delegation[]; grantChainHash: Hex } {
  hexSchema(LIMITS.contextBytes).parse(context);
  const parents = decodeDelegations(context);
  if (!parents.length || parents.length >= LIMITS.chainLength || !same(encodeDelegations(parents), context)) throw new Error('Invalid parent chain encoding');
  if (!same(parents[0]!.delegate, e.agent) || !same(parents.at(-1)!.delegator, e.owner) || parents.at(-1)!.authority !== toHex(maxUint256, { size: 32 })) throw new Error('Wrong grant authority');
  let gateBound = false, tokenBound = false, expiryBound = false, valueBound = false, fundingPayee = false;
  for (let index = 0; index < parents.length; index++) {
    const parent = parents[index]!;
    if (same(parent.delegator, e.agent) || parent.signature === '0x') throw new Error('Unsigned or agent-controlled parent');
    if (index < parents.length - 1 && (!same(parent.authority, hashDelegation(parents[index + 1]!)) || !same(parent.delegator, parents[index + 1]!.delegate))) throw new Error('Broken parent authority');
    if (parent.caveats.length > 16) throw new Error('Too many caveats');
    for (const c of parent.caveats) {
      if (c.args !== '0x') throw new Error('Mutable caveat args are unsupported');
      const n = size(c.terms);
      if (same(c.enforcer, e.enforcers.redeemer)) {
        if (n !== 20 || !same(c.terms, e.gate)) throw new Error('Root must restrict redemption to PurchaseGate');
        gateBound = true;
      } else if (same(c.enforcer, e.enforcers.periodic)) {
        if (n !== 116 || !same(slice(c.terms, 0, 20), e.token) || BigInt(slice(c.terms, 20, 52)) !== maxUint256 || BigInt(slice(c.terms, 52, 84)) !== maxUint256 || BigInt(slice(c.terms, 84, 116)) !== e.startTime) throw new Error('Wallet changed token allowance');
        tokenBound = true;
      } else if (same(c.enforcer, e.enforcers.timestamp)) {
        if (n !== 32 || BigInt(slice(c.terms, 0, 16)) > e.startTime || BigInt(slice(c.terms, 16)) !== e.expiry) throw new Error('Wallet changed expiry');
        expiryBound = true;
      } else if (same(c.enforcer, e.enforcers.value)) {
        if (n !== 32 || BigInt(c.terms) !== 0n) throw new Error('Native value is forbidden');
        valueBound = true;
      } else if (same(c.enforcer, e.enforcers.nonce)) {
        if (n !== 32) throw new Error('Invalid nonce caveat');
      } else if (same(c.enforcer, e.enforcers.calldata) && e.funding) {
        if (n !== 64 || BigInt(slice(c.terms, 0, 32)) !== 4n || !same(slice(c.terms, 32), toHex(BigInt(e.gate), { size: 32 }))) throw new Error('Funding payee must be Gate');
        fundingPayee = true;
      } else throw new Error('Unsupported parent enforcer');
    }
  }
  if (!gateBound || !tokenBound || !expiryBound || !valueBound || (e.funding && !fundingPayee)) throw new Error('Missing immutable grant restriction');
  return { parents, grantChainHash: parentChainHash(parents) };
}
export function validatePermissionResponse(input: unknown, e: GrantExpectation) {
  // SAK 2.0.0 returns expiry in rules, not a top-level response.expiry.
  const response = z.object({ chainId: z.number().int().positive(), from: addressSchema, to: addressSchema,
    delegationManager: addressSchema, context: hexSchema(LIMITS.contextBytes), dependencies: z.array(z.unknown()).length(0),
    permission: z.object({ type: z.literal('erc20-token-allowance'), isAdjustmentAllowed: z.literal(false),
      data: z.object({ tokenAddress: addressSchema, allowanceAmount: z.union([z.bigint(), z.string().regex(/^(0x[0-9a-fA-F]+|[0-9]+)$/)]).transform(BigInt), startTime: z.number().int().nonnegative().safe() }).passthrough(),
    }).passthrough(), rules: z.array(z.object({ type: z.enum(['expiry', 'redeemer', 'payee']), data: z.record(z.unknown()) }).strict()).max(3),
  }).passthrough().parse(input);
  const expiry = response.rules.filter(r => r.type === 'expiry');
  const redeemer = response.rules.filter(r => r.type === 'redeemer');
  const payee = response.rules.filter(r => r.type === 'payee');
  const onlyGate = (addresses: unknown) => Array.isArray(addresses) && addresses.length === 1 && typeof addresses[0] === 'string' && same(addresses[0], e.gate);
  if (expiry.length !== 1 || expiry[0]!.data.timestamp !== Number(e.expiry) || redeemer.length !== 1 || !onlyGate(redeemer[0]!.data.addresses) || (e.funding ? payee.length !== 1 || !onlyGate(payee[0]!.data.addresses) : payee.length !== 0)) throw new Error('Wallet changed permission rules');
  if (response.chainId !== e.chainId || !same(response.from, e.owner) || !same(response.to, e.agent) || !same(response.delegationManager, e.manager) || !same(response.permission.data.tokenAddress, e.token) || response.permission.data.allowanceAmount !== maxUint256 || BigInt(response.permission.data.startTime) !== e.startTime) throw new Error('Wallet response does not match requested permission');
  return validateParents(response.context, e);
}
/** Construct once, inspect, then sign these exact bytes; never regenerate after consent. */
export function buildPaymentLeaf(parents: Delegation[], e: Pick<GrantExpectation, 'agent' | 'gate' | 'token' | 'enforcers'>, amount: bigint, payTo: Address, expiry: bigint, salt: bigint): Delegation {
  if (!parents.length || amount <= 0n || payTo === zeroAddress || expiry <= 0n) throw new Error('Invalid leaf');
  return { delegate: e.gate, delegator: e.agent, authority: hashDelegation(parents[0]!), salt: toHex(salt), signature: '0x', caveats: [
    { enforcer: e.enforcers.transferAmount, terms: encodePacked(['address', 'uint256'], [e.token, amount]), args: '0x' },
    { enforcer: e.enforcers.calldata, terms: encodePacked(['uint256', 'uint256'], [4n, BigInt(payTo)]), args: '0x' },
    { enforcer: e.enforcers.timestamp, terms: encodePacked(['uint128', 'uint128'], [0n, expiry]), args: '0x' },
    { enforcer: e.enforcers.redeemer, terms: e.gate, args: '0x' },
    { enforcer: e.enforcers.value, terms: toHex(0n, { size: 32 }), args: '0x' },
  ] };
}
export { decodeDelegations, encodeDelegations, hashDelegation };
