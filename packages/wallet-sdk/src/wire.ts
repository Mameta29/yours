import { z } from 'zod';
import { maxUint256, type Address, type Hex } from 'viem';
import { gateTypes } from './types.js';
import type { Policy, Merchant, AssetLimit, GrantBinding } from './types.js';
import { LIMITS, type ExecutionEnvelope } from './protocol.js';

export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(v => v.toLowerCase() as Address);
export const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v => v.toLowerCase() as Hex);
export const hexSchema = (maxBytes: number) => z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/).max(maxBytes * 2 + 2).transform(v => v.toLowerCase() as Hex);
export const amountSchema = z.string().regex(/^(0|[1-9][0-9]*)$/).max(78).refine(v => /^(0|[1-9][0-9]*)$/.test(v) && v.length <= 78 && BigInt(v) <= maxUint256, 'uint256 overflow');
const uint64 = z.union([amountSchema, z.number().int().nonnegative().safe()]).transform(BigInt).refine(v => v < 2n ** 64n, 'uint64 overflow');
function structSchema(name: keyof typeof gateTypes) {
  return z.object(Object.fromEntries(gateTypes[name].map(f => [f.name,
    f.type === 'address' ? addressSchema : f.type === 'bytes32' ? bytes32Schema : f.type === 'bytes' ? hexSchema(4096) :
      f.type === 'uint32' ? z.number().int().min(0).max(2 ** 32 - 1) : f.type === 'uint64' ? uint64 : amountSchema.transform(BigInt),
  ]))).strict();
}
export function parseEnvelope(input: unknown): ExecutionEnvelope {
  return z.object({ order: structSchema('PurchaseOrder'), funding: structSchema('Funding'), intent: structSchema('ExecutionIntent'),
    paymentContext: hexSchema(LIMITS.contextBytes), fundingContext: hexSchema(LIMITS.contextBytes),
    risk: structSchema('RiskStamp'), price: structSchema('PriceStamp'), human: structSchema('HumanApproval'),
    signatures: structSchema('Signatures'), route: hexSchema(43),
  }).strict().parse(input) as ExecutionEnvelope;
}
/** Dedicated lifecycle relay input; never arbitrary calldata or an arbitrary target. */
export type GateAction =
  | { kind: 'register' | 'update'; policy: Policy; merchants: Merchant[]; assets: AssetLimit[]; grants: GrantBinding[]; relayers: Address[]; nonce: bigint; validUntil: bigint; signature: Hex }
  | { kind: 'revoke'; account: Address; policyId: Hex; nonce: bigint; validUntil: bigint; signature: Hex }
  | { kind: 'cancel'; account: Address; orderId: Hex; nonce: bigint; validUntil: bigint; signature: Hex };
export function parseGateAction(input: unknown): GateAction {
  const common = { nonce: uint64, validUntil: uint64, signature: hexSchema(65).refine(v => v.length === 132, '65-byte owner signature required') };
  const policy = { ...common, policy: structSchema('Policy'), merchants: z.array(structSchema('Merchant')).max(32),
    assets: z.array(structSchema('AssetLimit')).max(1), grants: z.array(structSchema('GrantBinding')).min(1).max(2),
    relayers: z.array(addressSchema).min(1).max(4) };
  return z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('register'), ...policy }).strict(), z.object({ kind: z.literal('update'), ...policy }).strict(),
    z.object({ kind: z.literal('revoke'), ...common, account: addressSchema, policyId: bytes32Schema }).strict(),
    z.object({ kind: z.literal('cancel'), ...common, account: addressSchema, orderId: bytes32Schema }).strict(),
  ]).parse(input) as GateAction;
}
export const erc7710RequirementsSchema = z.object({
  scheme: z.literal('exact'), network: z.string().regex(/^eip155:[1-9][0-9]*$/), asset: addressSchema,
  amount: amountSchema.refine(v => BigInt(v) > 0n), payTo: addressSchema, maxTimeoutSeconds: z.number().int().positive().max(300),
  extra: z.object({ assetTransferMethod: z.literal('erc7710'), facilitatorAddresses: z.array(addressSchema).length(1), jpycPurchaseVersion: z.literal(1) }).passthrough(),
}).passthrough();
export const purchaseExtensionSchema = z.object({ version: z.literal(1), orderHash: bytes32Schema, intentHash: bytes32Schema, executionRef: bytes32Schema }).strict();
export const erc7710PayloadSchema = z.object({
  x402Version: z.literal(2), accepted: erc7710RequirementsSchema,
  payload: z.object({ delegationManager: addressSchema, permissionContext: hexSchema(LIMITS.contextBytes), delegator: addressSchema }).strict(),
  extensions: z.object({ 'jpyc.purchase': purchaseExtensionSchema }).strict(),
}).strict();
export type Erc7710Payload = z.infer<typeof erc7710PayloadSchema>;
export type Erc7710Requirements = z.infer<typeof erc7710RequirementsSchema>;
export const paymentKeySchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('eip3009'), network: z.string().regex(/^eip155:[1-9][0-9]*$/), payer: addressSchema, nonce: bytes32Schema }).strict(),
  z.object({ method: z.literal('erc7710'), network: z.string().regex(/^eip155:[1-9][0-9]*$/), payer: addressSchema, gate: addressSchema, orderId: bytes32Schema }).strict(),
]);
export type PaymentKey = z.infer<typeof paymentKeySchema>;
export function paymentKeyId(value: PaymentKey): string {
  const k = paymentKeySchema.parse(value);
  return k.method === 'eip3009' ? `${k.method}:${k.network}:${k.payer}:${k.nonce}` : `${k.method}:${k.network}:${k.payer}:${k.gate}:${k.orderId}`;
}
export function decodePaymentHeader(header: string): Erc7710Payload {
  if (header.length > LIMITS.headerBytes) throw new Error('payment_header_too_large');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(header)) throw new Error('invalid_payment_encoding');
  return erc7710PayloadSchema.parse(JSON.parse(atob(header)));
}
