import {zeroHash,type Address} from 'viem';
import {parseEnvelope} from './wire.js';
import {decodeDelegations,buildPaymentLeaf,hashDelegation,type Enforcers} from './permissions.js';
import {delegationTypedData} from './wallet.js';
import {gateDomain,digest,structHash,emptyFunding,requirementsHash} from './protocol.js';
import {gateTypes} from './types.js';

export interface ExternalPaymentBinding {
 chainId:number;gate:Address;manager:Address;owner:Address;agent:Address;
 token:Address;payTo:Address;amount:bigint;enforcers:Enforcers;
}
/** Build the two signing requests locally, after comparing the server quote
 * with the agent's already approved payment terms. Never sign arbitrary typed
 * data returned by an HTTP endpoint. No owner key is required. */
export function externalPaymentTypedData(raw:unknown,b:ExternalPaymentBinding){
 const e=parseEnvelope(raw),o=e.order;
 const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
 if(!same(o.account,b.owner)||!same(o.agent,b.agent)||!same(o.settlementToken,b.token)||!same(o.payTo,b.payTo)||o.settlementAmount!==b.amount)throw new Error('payment_binding_mismatch');
 if(e.fundingContext!=='0x'||e.route!=='0x'||structHash('Funding',e.funding)!==structHash('Funding',emptyFunding)||o.fundingHash!==structHash('Funding',emptyFunding))throw new Error('unexpected_funding');
 const [leaf,...parents]=decodeDelegations(e.paymentContext);
 if(!leaf||!parents.length||!same(parents[0].delegate,b.agent)||!same(parents.at(-1)!.delegator,b.owner))throw new Error('payment_parent_mismatch');
 const expected=buildPaymentLeaf(parents,{agent:b.agent,gate:b.gate,token:b.token,enforcers:b.enforcers},b.amount,b.payTo,o.validUntil,BigInt(leaf.salt));
 if(hashDelegation(leaf)!==hashDelegation(expected))throw new Error('payment_leaf_mismatch');
 const domain=gateDomain(b.chainId,b.gate);
 if(e.intent.orderHash!==digest(domain,'PurchaseOrder',o)||e.intent.paymentLeafHash!==hashDelegation(leaf)||e.intent.fundingLeafHash!==zeroHash||e.intent.validUntil!==o.validUntil)throw new Error('payment_intent_mismatch');
 if(o.requirementsHash!==requirementsHash(b.chainId,b.gate,{settlementToken:b.token,payTo:b.payTo,settlementAmount:b.amount}))throw new Error('payment_requirements_mismatch');
 if(o.validUntil<=BigInt(Math.floor(Date.now()/1000))||o.validUntil>BigInt(Math.floor(Date.now()/1000)+600))throw new Error('payment_signature_expiry_invalid');
 return {leaf:delegationTypedData(b.chainId,b.manager,leaf),intent:{domain,types:gateTypes,primaryType:'ExecutionIntent' as const,message:e.intent}};
}
