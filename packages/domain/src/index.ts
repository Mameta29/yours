import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getAddress, type Address } from 'viem';

export const UINT256_MAX = (1n << 256n) - 1n;
export const atomicAmount = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).pipe(z.string().refine(v => BigInt(v) <= UINT256_MAX, 'uint256 overflow'));
export const positiveAtomicAmount = atomicAmount.pipe(z.string().refine(v => BigInt(v) > 0n, 'amount must be positive'));
export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(v => getAddress(v));
export const merchantSchema = z.object({
  id: z.string().min(1).max(128), origin: z.string().url(),
  payTo: addressSchema,
}).strict().superRefine((v,c) => {
  const url = new URL(v.origin);
  if (url.origin !== v.origin || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost'].includes(url.hostname)))) c.addIssue({code:'custom',message:'merchant origin must be an HTTPS origin (loopback HTTP allowed for development)'});
});
export const permissionSchema = z.object({
  connectionId: z.string().uuid(), revision: z.number().int().positive().safe(),
  perOrder: atomicAmount, perPeriod: atomicAmount,
  validUntil: z.number().int().positive().safe(),
  merchants: z.array(merchantSchema).max(64),
}).strict().superRefine((v,c) => {
  const keys = v.merchants.map(m => m.id + ':' + m.payTo.toLowerCase());
  if (new Set(keys).size !== keys.length) c.addIssue({code:'custom',message:'duplicate merchant'});
});
export type Permission = z.infer<typeof permissionSchema>;
export type Merchant = z.infer<typeof merchantSchema>;
export interface Budget {
  perOrder: string; perPeriod: string; periodStart: number; periodSeconds: number;
  validAfter: number; validUntil: number; status: 'active' | 'revoked' | 'pending';
}
export type Rejection = 'inactive' | 'expired' | 'not_started' | 'invalid_period';
export type ApprovalReason = 'per_order' | 'period_budget' | 'merchant';
export type Decision = {kind:'deny'; reason:Rejection} | {kind:'allow'} | {kind:'approval_required'; reasons:ApprovalReason[]};
export function periodIndex(budget: Pick<Budget,'periodStart'|'periodSeconds'>, now:number):number {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(budget.periodStart) || !Number.isSafeInteger(budget.periodSeconds) || budget.periodSeconds <= 0 || now < budget.periodStart) throw new Error('invalid_period');
  return Math.floor((now-budget.periodStart)/budget.periodSeconds);
}
export function authorize(input: {
  budget: Budget; permission: Permission; connectionActive: boolean; now: number;
  amount: string; merchantId: string; payTo: Address;
  accountSpent: string; accountReserved: string; agentSpent: string; agentReserved: string;
}): Decision {
  const {budget:b,permission:p,now} = input;
  const amount = BigInt(positiveAtomicAmount.parse(input.amount));
  if (b.status !== 'active' || !input.connectionActive) return {kind:'deny',reason:'inactive'};
  if (now >= b.validUntil || now >= p.validUntil) return {kind:'deny',reason:'expired'};
  if (now < b.validAfter) return {kind:'deny',reason:'not_started'};
  try { periodIndex(b,now); } catch { return {kind:'deny',reason:'invalid_period'}; }
  const reasons: ApprovalReason[] = [];
  if (amount > BigInt(b.perOrder) || amount > BigInt(p.perOrder)) reasons.push('per_order');
  if (BigInt(input.accountSpent)+BigInt(input.accountReserved)+amount > BigInt(b.perPeriod) ||
      BigInt(input.agentSpent)+BigInt(input.agentReserved)+amount > BigInt(p.perPeriod)) reasons.push('period_budget');
  if (!p.merchants.some(m => m.id === input.merchantId && m.payTo.toLowerCase() === input.payTo.toLowerCase())) reasons.push('merchant');
  return reasons.length ? {kind:'approval_required',reasons} : {kind:'allow'};
}
/** ISO minor units and ERC-20 atomic units are deliberately different types. */
export function minorToAtomic(minor:number, currency:'JPY'|'USD', tokenDecimals:number):string {
  if (!Number.isSafeInteger(minor) || minor <= 0 || !Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 77) throw new Error('invalid_amount');
  const scale = currency === 'JPY' ? 0 : 2;
  if (tokenDecimals < scale) throw new Error('precision_loss');
  return positiveAtomicAmount.parse((BigInt(minor)*10n**BigInt(tokenDecimals-scale)).toString());
}
/** RFC 8785-compatible canonical JSON for I-JSON inputs. Reject unsupported values. */
export function canonicalJson(value:unknown):string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('non_finite_number'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '['+value.map(canonicalJson).join(',')+']';
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return '{'+Object.keys(value).sort().map(k => JSON.stringify(k)+':'+canonicalJson((value as Record<string,unknown>)[k])).join(',')+'}';
  throw new Error('not_json');
}
export function sha256(value:string):string { return createHash('sha256').update(value).digest('hex'); }
export function digest(value:unknown):string { return sha256(canonicalJson(value)); }
export class DomainError extends Error {
  constructor(public code:string,public status:number=400,public details?:unknown) { super(code); }
}
export const intentStates = ['prepared','approval_required','authorized','signing','submitted','confirmed','failed','canceled'] as const;
export type IntentState = typeof intentStates[number];
const transitions: Record<IntentState,readonly IntentState[]> = {
  prepared:['approval_required','authorized','canceled'],
  approval_required:['authorized','canceled'], authorized:['signing','canceled'],
  signing:['submitted','failed'], submitted:['confirmed','failed'], confirmed:[], failed:[], canceled:[],
};
export function assertTransition(from:IntentState,to:IntentState):void {
  if (!transitions[from].includes(to)) throw new DomainError('invalid_state_transition',409,{from,to});
}
