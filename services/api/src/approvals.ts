import {randomUUID,randomBytes} from 'node:crypto';
import {Hono} from 'hono';
import {z} from 'zod';
import {DomainError} from '@yours/domain';
import {transaction,audit,type Db} from '@yours/storage';
import {consentDomain,taskConsentTypes} from '@yours/wallet-sdk';
import type {Address} from 'viem';
import {owner,type Env} from './auth.js';
import type {Config} from './config.js';
import {internalPost} from './internal.js';

export function approvalRoutes(db:Db,config:Config){
 const router=new Hono<Env>();
 router.post('/:id/prepare',async c=>{
  const actor=owner(c),intentId=z.string().uuid().parse(c.req.param('id'));
  if(!config.GATE_ADDRESS)throw new DomainError('payments_not_configured',503);
  const result=await transaction(db,async tx=>{
   await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[actor.accountId]);
   const {rows:[row]}=await tx.query('SELECT i.*,e.payload,e.envelope,c.status FROM intents i JOIN connections c ON c.id=i.connection_id LEFT JOIN payment_envelopes e ON e.intent_id=i.id WHERE i.id=$1 AND i.account_id=$2 FOR UPDATE OF i',[intentId,actor.accountId]);
   if(!row||row.state!=='approval_required'||row.status!=='active')throw new DomainError('order_not_approvable',409);
   if(!row.envelope)throw new DomainError('order_proof_preparing',409);
   const now=Math.floor(Date.now()/1000),validUntil=Math.min(now+120,Math.floor(new Date(row.expires_at).getTime()/1000));
   if(validUntil<=now+10)throw new DomainError('order_expiring',409);
   const masks:Record<string,number>={per_order:1,period_budget:2,merchant:4};
   const mask=(row.reasons as string[]).reduce((mask,reason)=>mask|(masks[reason]??0),0);
   if(!mask||mask&~7)throw new DomainError('order_cannot_be_overridden',403);
   const id=randomUUID(),proof={nonce:'0x'+randomBytes(32).toString('hex'),validUntil,overrideMask:mask,intentHash:row.payload.extensions['yours.purchase'].info.intentHash,riskDigest:row.envelope.risk.riskDigest};
   await tx.query('INSERT INTO approvals(id,intent_id,snapshot_hash,proof,expires_at) VALUES($1,$2,$3,$4,to_timestamp($5))',[id,intentId,row.snapshot_hash,JSON.stringify(proof),validUntil]);
   await audit(tx,actor.accountId,'owner:'+actor.accountId,'order.consent_requested',id,{intentId,overrideMask:mask});
   return {id,intentId,amount:Number(row.amount_minor),currency:row.currency,merchant:row.snapshot.checkout.merchant,reasons:row.reasons,typedData:{domain:consentDomain(config.CHAIN_ID,config.GATE_ADDRESS as Address),types:{OrderConsent:taskConsentTypes.OrderConsent},primaryType:'OrderConsent',message:{account:actor.address,...proof}}};
  });return c.json(result,201);
 });
 router.post('/:id/approve',async c=>{
  const actor=owner(c),id=z.string().uuid().parse(c.req.param('id'));
  const {signature}=z.object({signature:z.string().regex(/^0x[0-9a-fA-F]{130}$/)}).strict().parse(await c.req.json());
  const {rows:[row]}=await db.query('SELECT a.id FROM approvals a JOIN intents i ON i.id=a.intent_id WHERE a.id=$1 AND i.account_id=$2',[id,actor.accountId]);if(!row)throw new DomainError('approval_not_found',404);
  return c.json(await internalPost(config,config.MANDATES_URL,'/v1/approve-order',{approval_id:id,signature}));
 });
 return router;
}
