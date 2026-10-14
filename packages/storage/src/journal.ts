import {randomUUID} from 'node:crypto';
import {DomainError,digest} from '@yours/domain';
import {keccak256,parseTransaction,recoverTransactionAddress,type Hex} from 'viem';
import {transaction,audit,type Db,type Tx} from './index.js';
export interface TransactionClaim {id:string;intent_id:string;chain_id:number;signer:string;nonce:string;unsigned_payload:Record<string,unknown>;raw_transaction:string|null;transaction_hash:string|null;state:string;lease_token:string}
export async function claimTransaction(db:Db,input:{intentId:string;chainId:number;signer:string;pendingNonce:number;unsigned:Record<string,unknown>;leaseSeconds?:number}):Promise<TransactionClaim>{
 if(!Number.isSafeInteger(input.pendingNonce)||input.pendingNonce<0||!/^0x[0-9a-f]{40}$/i.test(input.signer))throw new DomainError('invalid_transaction_claim',422);
 return transaction(db,async tx=>{
  // Lock ordering: account -> intent -> signer lane. Matches pause and reservation.
  const {rows:[identity]}=await tx.query('SELECT account_id FROM intents WHERE id=$1',[input.intentId]);if(!identity)throw new DomainError('intent_not_found',404);
  const {rows:[account]}=await tx.query('SELECT id,chain_id FROM accounts WHERE id=$1 FOR UPDATE',[identity.account_id]);
  if(account.chain_id!==input.chainId)throw new DomainError('transaction_chain_mismatch',422);
  const {rows:[intent]}=await tx.query('SELECT * FROM intents WHERE id=$1 FOR UPDATE',[input.intentId]);
  const {rows:[old]}=await tx.query('SELECT * FROM signed_transactions WHERE intent_id=$1 FOR UPDATE',[input.intentId]);
  if(old){
   if(old.chain_id!==input.chainId||old.signer!==input.signer.toLowerCase())throw new DomainError('signer_binding_changed',409);
   if(old.raw_transaction)return old;
   if(new Date(old.lease_until).getTime()>Date.now())throw new DomainError('transaction_busy',409);
   const {rows:[claimed]}=await tx.query('UPDATE signed_transactions SET lease_token=$2,lease_until=now()+($3::int*interval \'1 second\'),attempts=attempts+1 WHERE id=$1 RETURNING *',[old.id,randomUUID(),input.leaseSeconds??60]);return claimed;
  }
  if(intent.state!=='authorized')throw new DomainError('intent_not_authorized',409);
  const {rows:[connection]}=await tx.query('SELECT status FROM connections WHERE id=$1',[intent.connection_id]);
  if(connection.status!=='active'||new Date(intent.expires_at).getTime()<=Date.now())throw new DomainError('permission_inactive_or_expired',403);
  await tx.query('INSERT INTO signer_lanes(chain_id,signer,next_nonce) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[input.chainId,input.signer.toLowerCase(),input.pendingNonce]);
  const {rows:[lane]}=await tx.query('SELECT * FROM signer_lanes WHERE chain_id=$1 AND signer=$2 FOR UPDATE',[input.chainId,input.signer.toLowerCase()]);
  const nonce=Math.max(Number(lane.next_nonce),input.pendingNonce);if(!Number.isSafeInteger(nonce))throw new Error('nonce_overflow');
  await tx.query('UPDATE signer_lanes SET next_nonce=$3 WHERE chain_id=$1 AND signer=$2',[input.chainId,input.signer.toLowerCase(),nonce+1]);
  const {rows:[claim]}=await tx.query(`INSERT INTO signed_transactions(id,intent_id,chain_id,signer,nonce,unsigned_payload,state,lease_token,lease_until) VALUES($1,$2,$3,$4,$5,$6,'reserved',$7,now()+($8::int*interval '1 second')) RETURNING *`,[randomUUID(),input.intentId,input.chainId,input.signer.toLowerCase(),nonce,JSON.stringify({...input.unsigned,nonce,chainId:input.chainId}),randomUUID(),input.leaseSeconds??60]);
  await tx.query("UPDATE intents SET state='signing',updated_at=now() WHERE id=$1",[input.intentId]);
  await audit(tx,intent.account_id,'worker','transaction.reserved',claim.id,{intentId:input.intentId,nonce,chainId:input.chainId});
  return claim;
 });
}
/** Check the signed bytes against the durable reservation before accepting them. */
export async function saveSignedTransaction(db:Db,claim:TransactionClaim,raw:string,hash:string):Promise<void>{
 if(!/^0x(?:[0-9a-f]{2})+$/i.test(raw)||!/^0x[0-9a-f]{64}$/i.test(hash)||keccak256(raw as Hex)!==hash.toLowerCase())throw new DomainError('invalid_signed_transaction',422);
 await transaction(db,async tx=>{
  const {rows:[row]}=await tx.query("SELECT * FROM signed_transactions WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND state='reserved' FOR UPDATE",[claim.id,claim.lease_token]);
  if(!row)throw new DomainError('lost_transaction_lease',409);
  try{
   const signed=parseTransaction(raw as Hex),expected=row.unsigned_payload;
   if(signed.type!=='eip1559'||signed.chainId!==row.chain_id||BigInt(signed.nonce!)!==BigInt(row.nonce)||(await recoverTransactionAddress({serializedTransaction:raw as `0x02${string}`})).toLowerCase()!==row.signer)throw new Error('signer_or_nonce_mismatch');
   for(const field of ['to','data'] as const)if((signed[field]??(field==='data'?'0x':'')).toLowerCase()!==(expected[field]??(field==='data'?'0x':'')).toLowerCase())throw new Error('call_mismatch');
   for(const field of ['gas','value','maxFeePerGas','maxPriorityFeePerGas'] as const)if(BigInt(signed[field]??0)!==BigInt(expected[field]??0))throw new Error('transaction_terms_mismatch');
   if(digest(signed.accessList??[])!==digest(expected.accessList??[]))throw new Error('access_list_mismatch');
  }catch{throw new DomainError('signed_transaction_mismatch',422);}
  await tx.query("UPDATE signed_transactions SET raw_transaction=$2,transaction_hash=$3,state='signed',updated_at=now() WHERE id=$1",[claim.id,raw,hash.toLowerCase()]);
 });
}
export async function markBroadcast(db:Db,id:string):Promise<void>{
 await transaction(db,async tx=>{
  const {rows:[row]}=await tx.query("UPDATE signed_transactions SET state='broadcast',updated_at=now() WHERE id=$1 AND state IN ('signed','broadcast') AND raw_transaction IS NOT NULL RETURNING *",[id]);
  if(!row)throw new DomainError('transaction_not_signed',409);
  await tx.query("UPDATE intents SET state='submitted',transaction_hash=$2,updated_at=now() WHERE id=$1 AND state IN ('signing','submitted')",[row.intent_id,row.transaction_hash]);
 });
}
export async function recordChainReceipt(db:Db,id:string,receipt:Record<string,unknown>,success:boolean,finalize?:(tx:Tx,intent:any)=>Promise<void>):Promise<void>{
 await transaction(db,async tx=>{
  const {rows:[identity]}=await tx.query('SELECT i.account_id FROM signed_transactions t JOIN intents i ON i.id=t.intent_id WHERE t.id=$1',[id]);
  if(!identity)throw new DomainError('transaction_not_found',404);
  await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[identity.account_id]);
  const {rows:[row]}=await tx.query('SELECT * FROM signed_transactions WHERE id=$1 FOR UPDATE',[id]);if(!row)throw new DomainError('transaction_not_found',404);
  if(['confirmed','reverted'].includes(row.state)){
   if(digest(row.receipt)!==digest(receipt))throw new DomainError('receipt_conflict',409);return;
  }
  if(!['signed','broadcast'].includes(row.state))throw new DomainError('transaction_not_signed',409);
  await tx.query('UPDATE signed_transactions SET state=$2,receipt=$3,updated_at=now() WHERE id=$1',[id,success?'confirmed':'reverted',JSON.stringify(receipt)]);
  const {rows:[intent]}=await tx.query('UPDATE intents SET state=$2,transaction_hash=$3,updated_at=now() WHERE id=$1 RETURNING *',[row.intent_id,success?'confirmed':'failed',row.transaction_hash]);
  if(finalize)await finalize(tx,intent);
  await audit(tx,intent.account_id,'worker','transaction.'+(success?'confirmed':'reverted'),id,{intentId:row.intent_id,transactionHash:row.transaction_hash});
 });
}
