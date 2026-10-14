import {DomainError} from '@yours/domain';
import {transaction,audit,type Db} from '@yours/storage';

/** Acknowledge in the API only after durable receipt, then project in a worker.
 * Notifications never authorize payment or replace chain settlement evidence. */
export async function processOrderWebhook(db:Db,source:string,eventId:string){
 return transaction(db,async tx=>{
  const {rows:[event]}=await tx.query('SELECT * FROM webhook_inbox WHERE source=$1 AND event_id=$2 FOR UPDATE',[source,eventId]);
  if(!event)throw new DomainError('webhook_not_found',404);
  if(event.processed_at)return;
  const {rows:[order]}=await tx.query('SELECT i.account_id,o.id FROM merchant_orders o JOIN intents i ON i.checkout_id=o.session_id::text WHERE o.id=$1 AND o.session_id=$2',[event.payload.id,event.payload.checkout_id]);
  if(!order)throw new DomainError('webhook_order_not_found',409);
  await audit(tx,order.account_id,'merchant:'+source,'order.notification.received',order.id,{eventId,payloadHash:event.payload_hash});
  await tx.query('UPDATE webhook_inbox SET processed_at=now() WHERE source=$1 AND event_id=$2',[source,eventId]);
 });
}
