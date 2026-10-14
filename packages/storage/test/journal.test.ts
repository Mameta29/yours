import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {createDb,migrate,claimTransaction,saveSignedTransaction,markBroadcast,recordChainReceipt} from '../src/index.js';
const db=createDb(process.env.TEST_DATABASE_URL??'postgresql://localhost/yours_test');
const account=randomUUID(),connection=randomUUID(),intent=randomUUID(),signer='0x'+randomBytes(20).toString('hex');
beforeAll(async()=>{
 await migrate(db);
 await db.query('INSERT INTO accounts(id,address,chain_id) VALUES($1,$2,80002)',[account,'0x'+randomBytes(20).toString('hex')]);
 await db.query("INSERT INTO connections(id,account_id,name,provider,status) VALUES($1,$2,'test','external','active')",[connection,account]);
 await db.query("INSERT INTO intents(id,account_id,connection_id,merchant_id,checkout_id,revision,currency,amount_minor,amount_atomic,period_index,state,snapshot,snapshot_hash,expires_at) VALUES($1,$2,$3,'test',$4,'1','JPY',1,1,0,'authorized','{}','test',now()+interval '1 hour')",[intent,account,connection,randomUUID()]);
});afterAll(()=>db.end());
it('persists one nonce and one winning signed payload across a signing crash',async()=>{
 const input={intentId:intent,chainId:80002,signer,pendingNonce:7,unsigned:{to:signer,data:'0x1234'}};
 const first=await claimTransaction(db,input);expect(first.nonce).toBe('7');
 await expect(claimTransaction(db,input)).rejects.toThrow('transaction_busy');
 await db.query("UPDATE signed_transactions SET lease_until=now()-interval '1 second' WHERE id=$1",[first.id]);
 const second=await claimTransaction(db,{...input,pendingNonce:99});
 expect(second.nonce).toBe('7');expect(second.id).toBe(first.id);
 await expect(saveSignedTransaction(db,first,'0x1234','0x'+'ab'.repeat(32))).rejects.toThrow('lost_transaction_lease');
 await saveSignedTransaction(db,second,'0x5678','0x'+'cd'.repeat(32));
 const retry=await claimTransaction(db,input);expect(retry.raw_transaction).toBe('0x5678');expect(retry.nonce).toBe('7');
 await markBroadcast(db,retry.id);await markBroadcast(db,retry.id);
 const receipt={transactionHash:retry.transaction_hash,blockNumber:'10',blockHash:'0x'+'ef'.repeat(32)};
 await recordChainReceipt(db,retry.id,receipt,true);
 await recordChainReceipt(db,retry.id,receipt,true);
 const {rows:[row]}=await db.query('SELECT state FROM intents WHERE id=$1',[intent]);expect(row.state).toBe('confirmed');
 await expect(recordChainReceipt(db,retry.id,{...receipt,blockNumber:'11'},true)).rejects.toThrow('receipt_conflict');
});
