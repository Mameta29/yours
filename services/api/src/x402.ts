import {Hono} from 'hono';
import {z} from 'zod';
import {DomainError,digest} from '@yours/domain';
import {transaction,audit,type Db} from '@yours/storage';
import {decodeYoursPayment,encodePayment,externalPaymentTypedData,decodeDelegations,encodeDelegations,parseEnvelope,paymentPayload} from '@yours/wallet-sdk';
import {keccak256,stringToHex,type Address,type Hex} from 'viem';
import {jsonSafe,type ChainRuntime} from './chain.js';
import {wakeSettlement} from './internal.js';
import type {Config} from './config.js';

export function x402Routes(router:Hono<any>,db:Db,config:Config,chain?:ChainRuntime){
 async function load(c:any){
  const actor=c.get('actor');if(actor.kind!=='agent')throw new DomainError('agent_required',403);
  const id=z.string().uuid().parse(c.req.param('id'));
  const {rows:[row]}=await db.query('SELECT i.*,a.address,c.agent_address,c.provider,e.envelope,e.signing_challenge,e.payload,e.payload_hash,e.accepted_at FROM intents i JOIN accounts a ON a.id=i.account_id JOIN connections c ON c.id=i.connection_id LEFT JOIN payment_envelopes e ON e.intent_id=i.id WHERE i.id=$1 AND i.connection_id=$2',[id,actor.connectionId]);
  if(!row)throw new DomainError('payment_not_found',404);
  if(actor.mandateId&&row.snapshot.mandateId!==actor.mandateId)throw new DomainError('task_outside_run',403);
  return row;
 }
 router.get('/payments/:id/authorization',async c=>{
  const row=await load(c);
  if(['failed','canceled'].includes(row.state)||new Date(row.expires_at).getTime()<=Date.now())throw new DomainError('payment_inactive',409);
  if(!row.payload)return c.json({state:'preparing'},202);
  if(row.envelope.signatures.agent==='0x')return c.json({state:'agent_signature_required',signingRequest:{challenge:row.signing_challenge,envelope:row.envelope}});
  // This is a signed, order-limited child delegation, created only after AP2
  // consent. The agent receives no owner key or unconstrained signing access.
  return c.json({paymentPayload:row.payload});
 });
 router.post('/payments/:id/authorization',async c=>{
  if(!chain)throw new DomainError('payments_not_configured',503);
  const row=await load(c),sig=z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/).max(8194);
  const body=z.object({challenge:z.string().regex(/^[0-9a-f]{64}$/),leaf:sig,intent:sig}).strict().parse(await c.req.json());
  if(row.provider!=='external'||!row.envelope)throw new DomainError('external_authorization_unavailable',409);
  if(body.challenge!==row.signing_challenge)throw new DomainError('payment_challenge_changed',409);
  const envelope=parseEnvelope(row.envelope),[leaf,...parents]=decodeDelegations(envelope.paymentContext);
  if(envelope.signatures.agent!=='0x'){
   if(envelope.signatures.agent!==body.intent.toLowerCase()||leaf.signature!==body.leaf.toLowerCase())throw new DomainError('payment_already_signed',409);
   return c.json({paymentPayload:row.payload});
  }
  const typed=externalPaymentTypedData(row.envelope,{chainId:config.CHAIN_ID,gate:chain.manifest.gate,manager:chain.manifest.manager,owner:row.address,agent:row.agent_address,token:chain.manifest.jpyc,payTo:row.snapshot.checkout.yours.pay_to,amount:BigInt(row.amount_atomic),enforcers:chain.manifest.enforcers});
  for(const part of ['leaf','intent'] as const){
   if(!await chain.client.verifyTypedData({...typed[part],address:row.agent_address as Address,signature:body[part] as Hex}))throw new DomainError('agent_signature_invalid',401);
  }
  leaf.signature=body.leaf.toLowerCase() as Hex;envelope.paymentContext=encodeDelegations([leaf,...parents]);envelope.signatures.agent=body.intent.toLowerCase() as Hex;
  const payload=paymentPayload(envelope,config.CHAIN_ID,chain.manifest.gate,chain.manifest.manager,config.PUBLIC_ORIGIN+'/api/agent/payments/'+row.id,keccak256(stringToHex(row.id)));
  await transaction(db,async tx=>{
   await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[row.account_id]);
   const {rows:[current]}=await tx.query('SELECT i.state,i.expires_at,c.status,e.payload_hash FROM intents i JOIN connections c ON c.id=i.connection_id JOIN payment_envelopes e ON e.intent_id=i.id WHERE i.id=$1 FOR UPDATE OF i,e',[row.id]);
   if(!['authorized','approval_required'].includes(current.state)||current.status!=='active'||new Date(current.expires_at).getTime()<=Date.now())throw new DomainError('payment_inactive',409);
   if(current.payload_hash===digest(payload))return;
   if(current.payload_hash!==row.payload_hash)throw new DomainError('payment_challenge_changed',409);
   await tx.query('UPDATE payment_envelopes SET envelope=$2,payload=$3,payload_hash=$4 WHERE intent_id=$1 AND accepted_at IS NULL',[row.id,JSON.stringify(jsonSafe(envelope)),JSON.stringify(payload),digest(payload)]);
   await audit(tx,row.account_id,'agent:'+row.connection_id,'payment.agent_signed',row.id,{agent:row.agent_address,challenge:body.challenge});
  });
  return c.json({paymentPayload:payload});
 });
 router.on(['GET','POST'],'/payments/:id',async c=>{
  let row=await load(c);
  if(['authorized','submitted','signing'].includes(row.state)){await wakeSettlement(config,row.id);row=await load(c);}
  if(row.state==='confirmed'){
   const response={success:true,transaction:row.transaction_hash,network:'eip155:'+config.CHAIN_ID,payer:row.address,amount:row.amount_atomic};
   c.header('PAYMENT-RESPONSE',encodePayment(response));
   const {rows:[order]}=await db.query('SELECT document FROM merchant_orders WHERE session_id=$1',[row.checkout_id]);
   return c.json({state:'confirmed',payment:response,order:order?.document});
  }
  if(['failed','canceled'].includes(row.state))return c.json({state:row.state},409);
  if(!row.payload)return c.json({state:row.state==='approval_required'?'approval_required':'preparing'},202);
  if(new Date(row.expires_at).getTime()<=Date.now())throw new DomainError('payment_expired',409);
  const header=c.req.header('PAYMENT-SIGNATURE');
  if(row.accepted_at&&!header)return c.json({state:row.state,intentId:row.id},202);
  if(!header){
   const required={x402Version:2,resource:row.payload.resource,accepts:[row.payload.accepted],extensions:row.payload.extensions};
   c.header('PAYMENT-REQUIRED',encodePayment(required));return c.json(required,402);
  }
  let payload;try{payload=decodeYoursPayment(header);}catch{throw new DomainError('invalid_payment_signature',422);}
  if(row.envelope.signatures.agent==='0x')throw new DomainError('agent_signature_required',409);
  if(digest(payload)!==row.payload_hash)throw new DomainError('payment_payload_mismatch',422);
  if(row.accepted_at)return c.json({state:row.state,intentId:row.id},202);
  await transaction(db,async tx=>{
   await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[row.account_id]);
   const {rows:[current]}=await tx.query('SELECT i.state,i.expires_at,c.status FROM intents i JOIN connections c ON c.id=i.connection_id WHERE i.id=$1 FOR UPDATE OF i',[row.id]);
   if(!['authorized','approval_required'].includes(current.state)||current.status!=='active'||new Date(current.expires_at).getTime()<=Date.now())throw new DomainError('payment_inactive',409);
   await tx.query('UPDATE payment_envelopes SET accepted_at=coalesce(accepted_at,now()) WHERE intent_id=$1 AND payload_hash=$2',[row.id,row.payload_hash]);
   await tx.query("UPDATE outbox SET available_at=now() WHERE dedupe_key=$1 AND completed_at IS NULL",['payment:'+row.id]);
   await audit(tx,row.account_id,'agent:'+row.connection_id,'x402.accepted',row.id,{payloadHash:row.payload_hash});
  });
  await wakeSettlement(config,row.id);
  return c.json({state:row.state,intentId:row.id},202);
 });
}
