import {randomUUID} from 'node:crypto';
import {authorize,digest,DomainError,minorToAtomic,periodIndex,permissionSchema,assertTransition,type Budget,type IntentState,type Permission} from '@yours/domain';
import {audit,enqueue,idempotent,transaction,type Db,type Tx} from './index.js';

export interface PurchaseProposal {
 merchantId:string;checkoutId:string;revision:string;currency:'JPY'|'USD';
 amountMinor:number;payTo:`0x${string}`;snapshot:Record<string,unknown>;expiresAt:number;
}
export async function budgetUsage(tx:Tx,accountId:string,connectionId:string,period:number){
 const {rows:[row]}=await tx.query(`SELECT
 COALESCE(sum(amount_atomic) FILTER(WHERE state='confirmed'),0)::text AS account_spent,
 COALESCE(sum(amount_atomic) FILTER(WHERE state IN ('authorized','signing','submitted')),0)::text AS account_reserved,
 COALESCE(sum(amount_atomic) FILTER(WHERE state='confirmed' AND connection_id=$2),0)::text AS agent_spent,
 COALESCE(sum(amount_atomic) FILTER(WHERE state IN ('authorized','signing','submitted') AND connection_id=$2),0)::text AS agent_reserved
 FROM intents WHERE account_id=$1 AND period_index=$3`,[accountId,connectionId,period]);
 return {accountSpent:row.account_spent,accountReserved:row.account_reserved,agentSpent:row.agent_spent,agentReserved:row.agent_reserved};
}
export async function preparePurchase(db:Db,connectionId:string,key:string,proposal:PurchaseProposal,now=Math.floor(Date.now()/1000)){
 return idempotent(db,'purchase:'+connectionId,key,proposal,async tx=>{
  const {rows:[connection]}=await tx.query('SELECT * FROM connections WHERE id=$1',[connectionId]);
  if(!connection)throw new DomainError('connection_not_found',404);
  // All budget and permission mutations lock this same owner row first.
  await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[connection.account_id]);
  const {rows:[current]}=await tx.query('SELECT * FROM connections WHERE id=$1',[connectionId]);
  const {rows:[policy]}=await tx.query('SELECT * FROM policies WHERE account_id=$1',[connection.account_id]);
  const {rows:[grant]}=await tx.query('SELECT * FROM permissions WHERE connection_id=$1',[connectionId]);
  if(!policy||!grant||grant.status!=='active'||current.status!=='active')throw new DomainError('permission_inactive',403);
  const budget=policy.document as Budget;const permission=permissionSchema.parse(grant.document);
  if(proposal.currency!==policy.currency)throw new DomainError('currency_mismatch',422);
  if(proposal.expiresAt<=now||proposal.expiresAt>Math.min(budget.validUntil,permission.validUntil))throw new DomainError('checkout_expired_or_outlives_permission',422);
  const period=periodIndex(budget,now),amount=minorToAtomic(proposal.amountMinor,proposal.currency,policy.token_decimals);
  const decision=authorize({budget,permission,connectionActive:true,now,amount,merchantId:proposal.merchantId,payTo:proposal.payTo,...await budgetUsage(tx,connection.account_id,connectionId,period)});
  if(decision.kind==='deny')throw new DomainError(decision.reason,403);
  const state=decision.kind==='allow'?'authorized':'approval_required';
  const id=randomUUID();const hash=digest(proposal.snapshot);
  const {rows:[intent]}=await tx.query(`INSERT INTO intents(id,account_id,connection_id,merchant_id,checkout_id,revision,currency,amount_minor,amount_atomic,period_index,state,snapshot,snapshot_hash,reasons,expires_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,to_timestamp($15)) RETURNING *`,[id,connection.account_id,connectionId,proposal.merchantId,proposal.checkoutId,proposal.revision,proposal.currency,proposal.amountMinor,amount,period,state,JSON.stringify(proposal.snapshot),hash,JSON.stringify(decision.kind==='approval_required'?decision.reasons:[]),proposal.expiresAt]);
  if(state==='authorized')await enqueue(tx,'payment.execute','payment:'+id,{intentId:id});
  await audit(tx,connection.account_id,'agent:'+connectionId,'purchase.'+state,id,{amount,currency:proposal.currency,merchantId:proposal.merchantId,snapshotHash:hash});
  return {status:201,body:intent};
 });
}
export async function transitionIntent(tx:Tx,id:string,from:IntentState,to:IntentState,actor:string){
 assertTransition(from,to);
 const {rows:[row]}=await tx.query('UPDATE intents SET state=$3,updated_at=now() WHERE id=$1 AND state=$2 RETURNING *',[id,from,to]);
 if(!row)throw new DomainError('intent_state_conflict',409);
 await audit(tx,row.account_id,actor,'purchase.'+to,id);
 return row;
}
export async function pauseConnection(db:Db,accountId:string,connectionId:string){
 return transaction(db,async tx=>{
  await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[accountId]);
  const {rowCount}=await tx.query("UPDATE connections SET status='paused',control_revision=control_revision+1 WHERE id=$1 AND account_id=$2 AND status<>'revoked'",[connectionId,accountId]);
  if(!rowCount)throw new DomainError('connection_not_found',404);
  // Signed/broadcast transactions remain reconcilable. Never report them canceled.
  await tx.query("UPDATE intents SET state='canceled',updated_at=now() WHERE account_id=$1 AND connection_id=$2 AND state IN ('prepared','approval_required','authorized')",[accountId,connectionId]);
  await audit(tx,accountId,'owner:'+accountId,'connection.paused',connectionId);
 });
}
