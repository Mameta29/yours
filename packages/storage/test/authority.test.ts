import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {createDb,migrate,preparePurchase,pauseConnection,transaction,transitionIntent} from '../src/index.js';
const db=createDb(process.env.TEST_DATABASE_URL??'postgresql://localhost/yours_test');
const account=randomUUID(),connection=randomUUID(),second=randomUUID(),now=Math.floor(Date.now()/1000);
const payTo='0x0000000000000000000000000000000000000001' as const;
beforeAll(async()=>{
 await migrate(db);
 await db.query('INSERT INTO accounts(id,address,chain_id) VALUES($1,$2,80002)',[account,'0x'+randomBytes(20).toString('hex')]);
 for(const id of [connection,second]){
  await db.query("INSERT INTO connections(id,account_id,name,provider,status) VALUES($1,$2,'test','external','active')",[id,account]);
  await db.query("INSERT INTO permissions(connection_id,revision,document,owner_signature,status) VALUES($1,1,$2,'test fixture only','active')",[id,JSON.stringify({connectionId:id,revision:1,perOrder:'800',perPeriod:'1200',validUntil:now+1000,merchants:[{id:'shop',origin:'https://shop.example',payTo}]})]);
 }
 await db.query('INSERT INTO policies(account_id,policy_id,revision,gate_address,token_address,token_decimals,currency,document) VALUES($1,$2,1,$3,$3,0,\'JPY\',$4)',[account,randomUUID(),payTo,JSON.stringify({perOrder:'1000',perPeriod:'1000',periodStart:now,periodSeconds:3600,validAfter:now,validUntil:now+1000,status:'active'})]);
});
afterAll(()=>db.end());
it('reserves a shared budget atomically across two agents',async()=>{
 const proposal=(id:string)=>({merchantId:'shop',checkoutId:id,revision:'1',currency:'JPY' as const,amountMinor:600,payTo,snapshot:{id,amount:600},expiresAt:now+100});
 const results=await Promise.all([preparePurchase(db,connection,randomUUID(),proposal(randomUUID()),now),preparePurchase(db,second,randomUUID(),proposal(randomUUID()),now)]);
 expect(results.filter(r=>r.body.state==='authorized')).toHaveLength(1);
 expect(results.filter(r=>r.body.state==='approval_required')).toHaveLength(1);
 const approved=results.find(r=>r.body.state==='authorized')!.body;
 await transaction(db,async tx=>{await transitionIntent(tx,approved.id,'authorized','signing','test');});
 await pauseConnection(db,account,approved.connection_id);
 const {rows:[after]}=await db.query('SELECT state FROM intents WHERE id=$1',[approved.id]);
 expect(after.state).toBe('signing');
 await expect(preparePurchase(db,approved.connection_id,randomUUID(),proposal(randomUUID()),now)).rejects.toThrow('permission_inactive');
});
