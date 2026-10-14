import {z} from 'zod';
import {addressSchema,amountSchema,bytes32Schema,hexSchema} from './wire.js';
import {LIMITS,type ExecutionEnvelope,gateDomain,digest} from './protocol.js';
import type {Address,Hex} from 'viem';
export const purchaseExtensionInfoSchema={type:'object',required:['version','orderHash','intentHash','executionRef'],properties:{version:{const:1},orderHash:{type:'string',pattern:'^0x[0-9a-f]{64}$'},intentHash:{type:'string',pattern:'^0x[0-9a-f]{64}$'},executionRef:{type:'string',pattern:'^0x[0-9a-f]{64}$'}},additionalProperties:false} as const;
export const yoursRequirementsSchema=z.object({scheme:z.literal('exact'),network:z.string().regex(/^eip155:[1-9][0-9]*$/),asset:addressSchema,amount:amountSchema,payTo:addressSchema,maxTimeoutSeconds:z.number().int().min(1).max(300),extra:z.object({assetTransferMethod:z.literal('erc7710'),facilitatorAddresses:z.array(addressSchema).length(1),yoursPurchaseVersion:z.literal(1)}).strict()}).strict();
export const yoursPaymentPayloadSchema=z.object({
 x402Version:z.literal(2),resource:z.object({url:z.string().url(),description:z.string(),mimeType:z.literal('application/json')}).strict(),accepted:yoursRequirementsSchema,
 payload:z.object({delegationManager:addressSchema,permissionContext:hexSchema(LIMITS.contextBytes),delegator:addressSchema}).strict(),
 extensions:z.object({'yours.purchase':z.object({info:z.object({version:z.literal(1),orderHash:bytes32Schema,intentHash:bytes32Schema,executionRef:bytes32Schema}).strict(),schema:z.record(z.unknown())}).strict()}).strict(),
}).strict();
export function paymentPayload(e:ExecutionEnvelope,chainId:number,gate:Address,manager:Address,resourceUrl:string,executionRef:Hex){
 return yoursPaymentPayloadSchema.parse({x402Version:2,resource:{url:resourceUrl,description:'yours delegated checkout settlement',mimeType:'application/json'},accepted:{scheme:'exact',network:'eip155:'+chainId,asset:e.order.settlementToken,amount:e.order.settlementAmount.toString(),payTo:e.order.payTo,maxTimeoutSeconds:120,extra:{assetTransferMethod:'erc7710',facilitatorAddresses:[gate],yoursPurchaseVersion:1}},payload:{delegationManager:manager,permissionContext:e.paymentContext,delegator:e.order.account},extensions:{'yours.purchase':{info:{version:1,orderHash:e.intent.orderHash,intentHash:digest(gateDomain(chainId,gate),'ExecutionIntent',e.intent),executionRef},schema:purchaseExtensionInfoSchema}}});
}
export function encodePayment(value:unknown):string{return btoa(JSON.stringify(value));}
export function decodeYoursPayment(header:string){
 if(header.length>LIMITS.headerBytes||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(header))throw new Error('invalid_payment_header');
 return yoursPaymentPayloadSchema.parse(JSON.parse(atob(header)));
}
