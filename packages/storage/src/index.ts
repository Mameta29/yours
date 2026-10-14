import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {DomainError,digest} from '@yours/domain';
export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export function createDb(url:string):Db {
 return new pg.Pool({connectionString:url,max:4,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,
  application_name:'yours',options:'-c statement_timeout=15000 -c idle_in_transaction_session_timeout=15000'});
}
export async function transaction<T>(db:Db,fn:(tx:Tx)=>Promise<T>):Promise<T>{
 const tx=await db.connect();
 try {await tx.query('BEGIN');const result=await fn(tx);await tx.query('COMMIT');return result;}
 catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
}
export async function audit(tx:Tx,accountId:string|null,actor:string,action:string,resourceId:string,data:unknown={}){
 await tx.query('INSERT INTO audit_events(account_id,actor,action,resource_id,data) VALUES($1,$2,$3,$4,$5)',[accountId,actor,action,resourceId,JSON.stringify(data)]);
}
/** No external side effects in this transaction. Bounded signing of a response
 * is allowed; payments and delivery always use the outbox after commit. */
export async function idempotent<T>(db:Db,scope:string,key:string,request:unknown,fn:(tx:Tx)=>Promise<{status:number;body:T}>):Promise<{status:number;body:T}>{
 if(!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new DomainError('invalid_idempotency_key');
 return transaction(db,async tx=>{
  const hash=digest(request);
  await tx.query('INSERT INTO idempotency(scope,key,request_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[scope,key,hash]);
  const {rows:[row]}=await tx.query('SELECT * FROM idempotency WHERE scope=$1 AND key=$2 FOR UPDATE',[scope,key]);
  if(row.request_hash!==hash)throw new DomainError('idempotency_conflict',409);
  if(row.status!==null)return {status:row.status,body:row.response as T};
  const result=await fn(tx);
  await tx.query('UPDATE idempotency SET status=$3,response=$4 WHERE scope=$1 AND key=$2',[scope,key,result.status,JSON.stringify(result.body)]);
  return result;
 });
}
export async function enqueue(tx:Tx,topic:string,dedupeKey:string,payload:unknown):Promise<void>{
 await tx.query('INSERT INTO outbox(id,topic,dedupe_key,payload) VALUES($1,$2,$3,$4) ON CONFLICT(dedupe_key) DO NOTHING',[randomUUID(),topic,dedupeKey,JSON.stringify(payload)]);
}
export interface WorkItem {id:string;topic:string;payload:Record<string,unknown>;lease_token:string;attempts:number}
export async function claimWork(db:Db,topics:string[],leaseSeconds=60,intentId?:string):Promise<WorkItem|null>{
 return transaction(db,async tx=>{
  const {rows:[row]}=await tx.query(`SELECT id FROM outbox WHERE topic=ANY($1) AND ($2::text IS NULL OR payload->>'intentId'=$2) AND completed_at IS NULL AND available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,[topics,intentId??null]);
  if(!row)return null;
  const {rows:[claimed]}=await tx.query('UPDATE outbox SET lease_token=$2,lease_until=now()+($3::int*interval \'1 second\'),attempts=attempts+1 WHERE id=$1 RETURNING *',[row.id,randomUUID(),leaseSeconds]);
  return claimed;
 });
}
export async function finishWork(db:Db,item:WorkItem,error?:string):Promise<void>{
 const result=error
 ? await db.query('UPDATE outbox SET lease_until=NULL,lease_token=NULL,last_error=$3,available_at=now()+(LEAST(300,power(2,LEAST(attempts,8))) * interval \'1 second\') WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND completed_at IS NULL',[item.id,item.lease_token,error.slice(0,500)])
 : await db.query('UPDATE outbox SET completed_at=now(),lease_until=NULL WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND completed_at IS NULL',[item.id,item.lease_token]);
 if(result.rowCount!==1)throw new DomainError('lost_work_lease',409);
}
export async function acceptWebhook(db:Db,source:string,eventId:string,payload:unknown,intentId?:string):Promise<boolean>{
 return transaction(db,async tx=>{
  const hash=digest(payload);
  const result=await tx.query('INSERT INTO webhook_inbox(source,event_id,payload_hash,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[source,eventId,hash,JSON.stringify(payload)]);
  if(result.rowCount===1){
   if(intentId)await enqueue(tx,'order.webhook.received','webhook-received:'+digest([source,eventId]),{source,eventId,intentId});
   return true;
  }
  const {rows:[row]}=await tx.query('SELECT payload_hash FROM webhook_inbox WHERE source=$1 AND event_id=$2',[source,eventId]);
  if(row.payload_hash!==hash)throw new DomainError('webhook_event_conflict',409);
  return false;
 });
}
export * from './migrations.js';
export * from './authority.js';
export * from './journal.js';
