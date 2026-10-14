import { encodeAbiParameters, hashStruct, hashTypedData, keccak256, stringToHex, zeroAddress, zeroHash, type Address, type Hex } from 'viem';
import { gateTypes, type Merchant, type AssetLimit, type GrantBinding, type Funding, type PurchaseOrder, type ExecutionIntent, type RiskStamp, type PriceStamp, type HumanApproval, type Signatures } from './types.js';

export const LIMITS = Object.freeze({ headerBytes: 12 * 1024, contextBytes: 8 * 1024, chainLength: 8, authSkew: 30, approvalTtl: 120, riskTtl: 60, priceSourceMaxAge: 96 * 3600 });
export const REASON = Object.freeze({ ORDER_JPYC_LIMIT: 1, PERIOD_JPYC_LIMIT: 2, NEW_MERCHANT: 4, ORDER_INPUT_LIMIT: 8, PERIOD_INPUT_LIMIT: 16, PRICE_PREMIUM: 32, COUNTERPARTY_RISK: 64, TOKEN_REPUTATION_RISK: 128 });
export type GateDomain = ReturnType<typeof gateDomain>;
export const gateDomain = (chainId: number, gate: Address) => ({ name: 'JPYC PurchaseGate', version: '1', chainId, verifyingContract: gate } as const);
export function structHash<T extends keyof typeof gateTypes>(primaryType: T, data: Record<string, unknown>): Hex {
  return hashStruct({ types: gateTypes, primaryType, data } as Parameters<typeof hashStruct>[0]);
}
export function digest<T extends keyof typeof gateTypes>(domain: GateDomain, primaryType: T, message: Record<string, unknown>): Hex {
  return hashTypedData({ domain, types: gateTypes, primaryType, message } as Parameters<typeof hashTypedData>[0]);
}
function assertAscending(values: bigint[]) {
  if (values.some((v, i) => v === 0n || (i > 0 && v <= values[i - 1]!))) throw new Error('Sets must be sorted, unique and nonzero');
}
export function merchantSetHash(shops: Merchant[]): Hex {
  assertAscending(shops.map(s => (BigInt(s.shopIdHash) << 160n) | BigInt(s.payTo)));
  if (shops.some(s => s.payTo === zeroAddress || s.shopIdHash === zeroHash)) throw new Error('Invalid merchant');
  return keccak256(encodeAbiParameters([{ type: 'tuple[]', components: gateTypes.Merchant }], [shops]));
}
export function assetLimitsHash(assets: AssetLimit[]): Hex {
  assertAscending(assets.map(a => BigInt(a.token)));
  return keccak256(encodeAbiParameters([{ type: 'tuple[]', components: gateTypes.AssetLimit }], [assets]));
}
export function relayerSetHash(relayers: Address[]): Hex {
  assertAscending(relayers.map(a => BigInt(a)));
  if (!relayers.length) throw new Error('A relayer is required');
  return keccak256(encodeAbiParameters([{ type: 'address[]' }], [relayers]));
}
export function grantsHash(grants: GrantBinding[]): Hex {
  assertAscending(grants.map(g => (BigInt(g.agent) << 160n) | BigInt(g.token)));
  return keccak256(encodeAbiParameters([{ type: 'bytes32[]' }], [grants.map(g => structHash('GrantBinding', g))]));
}
export function requirementsHash(chainId: number, gate: Address, o: Pick<PurchaseOrder, 'settlementToken' | 'payTo' | 'settlementAmount'>): Hex {
  return keccak256(encodeAbiParameters([
    { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' },
    { type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' }, { type: 'uint32' },
  ], [BigInt(chainId), o.settlementToken, o.payTo, o.settlementAmount, keccak256(stringToHex('exact')), keccak256(stringToHex('erc7710')), gate, 1]));
}
export const emptyFunding: Funding = Object.freeze({ token: zeroAddress, maxInput: 0n, outputJpyc: 0n, adapter: zeroAddress, routeHash: zeroHash, quoteDeadline: 0n });
export const emptyPrice: PriceStamp = Object.freeze({ orderHash: zeroHash, token: zeroAddress, fairInputAtomic: 0n, sourceDigest: zeroHash, observedAt: 0n, validUntil: 0n });
export const emptyApproval: HumanApproval = Object.freeze({ approvalId: zeroHash, intentHash: zeroHash, riskDigest: zeroHash, identityBindingId: zeroHash, overrideMask: 0, authenticatedAt: 0n, validUntil: 0n });
export type ExecutionEnvelope = { order: PurchaseOrder; funding: Funding; intent: ExecutionIntent; paymentContext: Hex; fundingContext: Hex; risk: RiskStamp; price: PriceStamp; human: HumanApproval; signatures: Signatures; route: Hex };

/** Stable JSON for private snapshots/evidence. Arrays keep semantic order. */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') {
    if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Non-JSON value');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k])).join(',') + '}';
}
export const evidenceDigest = (value: unknown): Hex => keccak256(stringToHex(canonicalJson(value)));
/** Salt must be random and retained only in the private snapshot store. */
export const basketCommitment = (snapshot: unknown, salt: Hex): Hex => keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [evidenceDigest(snapshot), salt]));
export function fairInputAtomic(outputJpyc: bigint, inputDecimals: number, usdPerEur: bigint, jpyPerEur: bigint, inputUsd: bigint, inputUsdScale: bigint): bigint {
  if (outputJpyc <= 0n || usdPerEur <= 0n || jpyPerEur <= 0n || inputUsd <= 0n || inputUsdScale <= 0n || !Number.isInteger(inputDecimals) || inputDecimals < 0 || inputDecimals > 18) throw new Error('Invalid price reference');
  const n = outputJpyc * usdPerEur * 10n ** BigInt(inputDecimals) * inputUsdScale;
  const d = 10n ** 18n * jpyPerEur * inputUsd;
  return (n + d - 1n) / d;
}
