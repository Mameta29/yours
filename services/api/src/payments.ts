import {merchantFor} from './merchants.js';
import {Hono} from 'hono';
import {z} from 'zod';
import {DomainError,digest} from '@yours/domain';
import {idempotent,preparePurchaseTx,type Db} from '@yours/storage';
import {verifyCheckout,validateRequest,validateSchema,authorizeCheckout} from '@yours/ucp';
import type {P256Signer} from '@yours/signing';
import type {Config} from './config.js';
import {internalPost,wakeSettlement} from './internal.js';

const requestSchema=z.object({
 payment:z.object({instruments:z.array(z.object({id:z.string(),handler_id:z.literal('yours-stablecoin'),type:z.literal('stablecoin'),selected:z.literal(true),credential:z.object({type:z.literal('yours_ap2'),mandate_id:z.string().uuid()}).strict()}).strict()).length(1)}).strict(),
 ap2:z.object({checkout_mandate:z.string().min(20).max(65536),payment_mandate:z.string().min(20).max(65536)}).strict(),
}).strict();
/** Called after UCP profile negotiation and agent authentication. */
export function paymentRoutes(router:Hono<any>,db:Db,config:Config,signer:P256Signer){
 router.post('/checkout-sessions/:id/complete',async c=>{
  const actor=c.get('actor');if(actor.kind!=='agent')throw new DomainError('agent_required',403);
  if(!config.MANDATES_URL||!config.MERCHANT_PAY_TO||!config.JPYC_ADDRESS||!config.GATE_ADDRESS)throw new DomainError('payments_not_configured',503);
  const id=z.string().uuid().parse(c.req.param('id'));
  const raw=await c.req.json();validateRequest('checkout','complete',raw);const body=requestSchema.parse(raw);
  const instrument=body.payment.instruments[0],mandateId=instrument.credential.mandate_id;
  if(actor.mandateId&&actor.mandateId!==mandateId)throw new DomainError('task_outside_run',403);
  const key=c.req.header('Idempotency-Key')??'',etag=c.req.header('If-Match')??null;
  const scope='agent:'+actor.connectionId+':complete:'+id,request={body,etag};
  const result=await idempotent(db,scope,key,request,async tx=>{
   // Serialize retries before verifying a checkout which advances on commit.
   await tx.query("SET LOCAL idle_in_transaction_session_timeout='30000'");
  const {rows:[checkout]}=await tx.query("SELECT * FROM merchant_sessions WHERE id=$1 AND kind='checkout' AND actor=$2 AND platform_profile=$3",[id,'agent:'+actor.connectionId,c.get('platform')]);
  if(!checkout)throw new DomainError('session_not_found',404);
  if(checkout.status!=='ready_for_complete'||new Date(checkout.expires_at).getTime()<=Date.now())throw new DomainError('checkout_not_ready',409);
  if(etag!=='"'+checkout.revision+'"')throw new DomainError('revision_conflict',412);
  const jwt=await verifyCheckout(checkout.document,[signer.publicJwk]);
  const verified=await internalPost<any>(config,config.MANDATES_URL,'/v1/verify',{mandate_id:mandateId,checkout_id:id,checkout_jwt:jwt,mandates:body.ap2});
   await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[actor.accountId]);
   const {rows:[current]}=await tx.query('SELECT * FROM merchant_sessions WHERE id=$1 FOR UPDATE',[id]);
   if(current.status!=='ready_for_complete'||current.revision!==checkout.revision||digest(current.document)!==digest(checkout.document))throw new DomainError('checkout_changed',409);
   const {rows:[mandate]}=await tx.query('SELECT * FROM mandates WHERE id=$1 AND connection_id=$2 FOR UPDATE',[mandateId,actor.connectionId]);
   const now=Math.floor(Date.now()/1000);
   if(!mandate||mandate.revoked_at||new Date(mandate.expires_at).getTime()<=Date.now()||!Number.isSafeInteger(verified.expires_at)||verified.expires_at<=now)throw new DomainError('mandate_inactive',403);
   if(instrument.id!==mandate.task.instrument_id||verified.payment.payment_instrument.id!==instrument.id)throw new DomainError('instrument_mismatch',422);
   if((await tx.query('SELECT 1 FROM mandate_consumptions WHERE mandate_id=$1',[mandateId])).rowCount)throw new DomainError('mandate_already_used',409);
   const doc=current.document,total=doc.totals.find((t:any)=>t.type==='total')?.amount;
   const merchant=merchantFor(config,current.merchant_id);
   if(doc.merchant.id!==merchant.id||doc.yours.pay_to.toLowerCase()!==merchant.payTo.toLowerCase()||doc.yours.asset.toLowerCase()!==config.JPYC_ADDRESS!.toLowerCase()||verified.payment.payment_amount.amount!==total||verified.payment.payment_amount.currency!==doc.currency)throw new DomainError('settlement_binding_mismatch',422);
   if(merchant.adapter==='jpyc-ec'){
    const {rows:[reservation]}=await tx.query('SELECT * FROM ec_reservations WHERE checkout_id=$1 AND account_id=$2 AND connection_id=$3',[id,actor.accountId,actor.connectionId]);
    if(!reservation?.authorized_at||reservation.quote.expiresAt<=Date.now()||mandate.task.checkout_id!==id||doc.yours.ec?.requirements_hash!==reservation.quote.requirementsHash)throw new DomainError('ec_reservation_binding_mismatch',409);
   }
   const expires=Math.min(verified.expires_at,Math.floor(new Date(current.expires_at).getTime()/1000),Math.floor(new Date(mandate.expires_at).getTime()/1000));
   const intent=await preparePurchaseTx(tx,actor.connectionId,{merchantId:merchant.id,checkoutId:id,revision:String(current.revision),currency:doc.currency,amountMinor:total,payTo:merchant.payTo as `0x${string}`,expiresAt:expires,snapshot:{checkout:doc,checkoutJwt:jwt,mandates:body.ap2,mandateId,instrumentId:instrument.id}});
   await tx.query('INSERT INTO mandate_consumptions(mandate_id,intent_id,checkout_id,amount_minor,verified) VALUES($1,$2,$3,$4,$5)',[mandateId,intent.id,id,total,JSON.stringify(verified)]);
   // Keep stock held until settlement is resolved, even past checkout expiry.
   const document={...doc,status:'complete_in_progress',yours:{...doc.yours,revision:current.revision+1,intent_id:intent.id,payment_status:intent.state}};
   delete document.ap2;document.ap2={merchant_authorization:await authorizeCheckout(document,signer)};
   validateSchema('shopping/checkout.json',document);
   await tx.query("UPDATE merchant_sessions SET status='complete_in_progress',revision=revision+1,document=$2,updated_at=now() WHERE id=$1",[id,JSON.stringify(document)]);
   return {status:202,body:document};
  });
  await wakeSettlement(config,result.body.yours.intent_id);
  c.header('ETag','"'+result.body.yours.revision+'"');return c.json(result.body,result.status as 202);
 });
}
