import {Hono} from 'hono';
import {z} from 'zod';
import {DomainError,digest} from '@yours/domain';
import {transaction,audit,type Db} from '@yours/storage';
import {decodeYoursPayment,encodePayment} from '@yours/wallet-sdk';
import type {Config} from './config.js';

export function x402Routes(router:Hono<any>,db:Db,config:Config){
 async function load(c:any){
  const actor=c.get('actor');if(actor.kind!=='agent')throw new DomainError('agent_required',403);
  const id=z.string().uuid().parse(c.req.param('id'));
  const {rows:[row]}=await db.query('SELECT i.*,a.address,e.payload,e.payload_hash,e.accepted_at FROM intents i JOIN accounts a ON a.id=i.account_id LEFT JOIN payment_envelopes e ON e.intent_id=i.id WHERE i.id=$1 AND i.connection_id=$2',[id,actor.connectionId]);
  if(!row)throw new DomainError('payment_not_found',404);return row;
 }
 router.get('/payments/:id/authorization',async c=>{
  const row=await load(c);
  if(['failed','canceled'].includes(row.state)||new Date(row.expires_at).getTime()<=Date.now())throw new DomainError('payment_inactive',409);
  if(!row.payload)return c.json({state:'preparing'},202);
  // This is a signed, order-limited child delegation, created only after AP2
  // consent. The agent receives no owner key or unconstrained signing access.
  return c.json({paymentPayload:row.payload});
 });
 router.on(['GET','POST'],'/payments/:id',async c=>{
  const row=await load(c);
  if(row.state==='confirmed'){
   const response={success:true,transaction:row.transaction_hash,network:'eip155:'+config.CHAIN_ID,payer:row.address,amount:row.amount_atomic};
   c.header('PAYMENT-RESPONSE',encodePayment(response));
   const {rows:[order]}=await db.query('SELECT document FROM merchant_orders WHERE session_id=$1',[row.checkout_id]);
   return c.json({state:'confirmed',payment:response,order:order?.document});
  }
  if(['failed','canceled'].includes(row.state))return c.json({state:row.state},409);
  if(!row.payload)return c.json({state:row.state==='approval_required'?'approval_required':'preparing'},202);
  if(row.accepted_at)return c.json({state:row.state,intentId:row.id},202);
  if(new Date(row.expires_at).getTime()<=Date.now())throw new DomainError('payment_expired',409);
  const header=c.req.header('PAYMENT-SIGNATURE');
  if(!header){
   const required={x402Version:2,resource:row.payload.resource,accepts:[row.payload.accepted],extensions:row.payload.extensions};
   c.header('PAYMENT-REQUIRED',encodePayment(required));return c.json(required,402);
  }
  let payload;try{payload=decodeYoursPayment(header);}catch{throw new DomainError('invalid_payment_signature',422);}
  if(digest(payload)!==row.payload_hash)throw new DomainError('payment_payload_mismatch',422);
  await transaction(db,async tx=>{
   await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[row.account_id]);
   const {rows:[current]}=await tx.query('SELECT i.state,i.expires_at,c.status FROM intents i JOIN connections c ON c.id=i.connection_id WHERE i.id=$1 FOR UPDATE OF i',[row.id]);
   if(!['authorized','approval_required'].includes(current.state)||current.status!=='active'||new Date(current.expires_at).getTime()<=Date.now())throw new DomainError('payment_inactive',409);
   await tx.query('UPDATE payment_envelopes SET accepted_at=coalesce(accepted_at,now()) WHERE intent_id=$1 AND payload_hash=$2',[row.id,row.payload_hash]);
   await tx.query("UPDATE outbox SET available_at=now() WHERE dedupe_key=$1 AND completed_at IS NULL",['payment:'+row.id]);
   await audit(tx,row.account_id,'agent:'+row.connection_id,'x402.accepted',row.id,{payloadHash:row.payload_hash});
  });
  return c.json({state:row.state,intentId:row.id},202);
 });
}
