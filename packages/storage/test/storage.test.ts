import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createDb,migrate,idempotent,enqueue,transaction,claimWork,finishWork,acceptWebhook} from '../src/index.js';
const db=createDb(process.env.TEST_DATABASE_URL??'postgresql://localhost/yours_test');
const scope=randomUUID();
beforeAll(async()=>{await migrate(db);});
afterAll(async()=>{await db.end();});
it('serializes duplicate requests and rejects changed bodies',async()=>{
 let count=0;const run=()=>idempotent(db,scope,'same-request',{amount:'5'},async()=>{count++;return {status:201,body:{id:randomUUID()}};});
 const results=await Promise.all(Array.from({length:12},run));
 expect(count).toBe(1);expect(new Set(results.map(r=>r.body.id)).size).toBe(1);
 await expect(idempotent(db,scope,'same-request',{amount:'6'},async()=>({status:201,body:{}}))).rejects.toThrow('idempotency_conflict');
});
it('rolls back failed commands rather than caching partial success',async()=>{
 await expect(idempotent(db,scope,'retry-request',{},async tx=>{await enqueue(tx,'rollback',scope,{});throw new Error('crash');})).rejects.toThrow('crash');
 const {rows}=await db.query('SELECT id FROM outbox WHERE dedupe_key=$1',[scope]);expect(rows).toHaveLength(0);
 expect((await idempotent(db,scope,'retry-request',{},async()=>({status:200,body:{ok:true}}))).body.ok).toBe(true);
});
it('only one worker claims a job and expired workers cannot finish it',async()=>{
 const topic='test:'+scope;await transaction(db,tx=>enqueue(tx,topic,scope+':work',{ok:true}));
 const claims=await Promise.all(Array.from({length:8},()=>claimWork(db,[topic])));
 const items=claims.filter(v=>v!==null);expect(items).toHaveLength(1);
 const first=items[0]!;
 await db.query('UPDATE outbox SET lease_until=now()-interval \'1 second\' WHERE id=$1',[first.id]);
 const second=await claimWork(db,[topic]);expect(second).not.toBeNull();
 await expect(finishWork(db,first)).rejects.toThrow('lost_work_lease');
 await finishWork(db,second!);expect(await claimWork(db,[topic])).toBeNull();
});
it('deduplicates webhooks but refuses payload substitution',async()=>{
 expect(await acceptWebhook(db,scope,'evt1',{a:1})).toBe(true);
 expect(await acceptWebhook(db,scope,'evt1',{a:1})).toBe(false);
 await expect(acceptWebhook(db,scope,'evt1',{a:2})).rejects.toThrow('webhook_event_conflict');
});
