import {randomBytes,randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import {z} from 'zod';
import {keccak256,stringToHex,type Address} from 'viem';
import {DomainError,digest} from '@yours/domain';
import {audit,transaction,type Db} from '@yours/storage';
import {consentDomain,taskConsentTypes} from '@yours/wallet-sdk';
import {owner,type Env} from './auth.js';
import type {Config} from './config.js';
import {internalPost} from './internal.js';

const taskRequest=z.object({
 connectionId:z.string().uuid(),merchantId:z.string().min(1),
 items:z.array(z.object({id:z.string().min(1).max(256),quantity:z.number().int().min(1).max(10000)}).strict()).min(1).max(50),
 maxAmount:z.number().int().positive().safe(),minutes:z.number().int().min(5).max(1440).default(60),
}).strict();

export function taskRoutes(db:Db,config:Config){
 const router=new Hono<Env>();
 router.post('/prepare',async c=>{
  const actor=owner(c),request=taskRequest.parse(await c.req.json());
  if(!config.GATE_ADDRESS||!config.MANDATES_URL)throw new DomainError('payments_not_configured',503);
  if(request.merchantId!==config.MERCHANT_ID)throw new DomainError('merchant_not_enrolled',422);
  const ids=request.items.map(i=>i.id);
  if(new Set(ids).size!==ids.length)throw new DomainError('duplicate_line_item',422);
  const result=await transaction(db,async tx=>{
   await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[actor.accountId]);
   const {rows:[connection]}=await tx.query('SELECT c.*,p.document,p.status AS permission_status FROM connections c JOIN permissions p ON p.connection_id=c.id WHERE c.id=$1 AND c.account_id=$2',[request.connectionId,actor.accountId]);
   const {rows:[policy]}=await tx.query('SELECT document FROM policies WHERE account_id=$1',[actor.accountId]);
   if(!connection||!policy||connection.status!=='active'||connection.permission_status!=='active'||policy.document.status!=='active')throw new DomainError('permission_inactive',403);
   const now=Math.floor(Date.now()/1000),expires=Math.min(now+request.minutes*60,connection.document.validUntil,policy.document.validUntil);
   if(expires<=now+120)throw new DomainError('permission_expiring',409);
   const {rows:products}=await tx.query('SELECT id,title,amount_minor,currency FROM merchant_products WHERE merchant_id=$1 AND id=ANY($2) AND active=true',[request.merchantId,ids]);
   if(products.length!==ids.length)throw new DomainError('product_not_found',404);
   let subtotal=0;
   const items=request.items.map(item=>{
    const product=products.find(p=>p.id===item.id)!;
    if(product.currency!=='JPY')throw new DomainError('currency_unsupported',422);
    subtotal+=Number(product.amount_minor)*item.quantity;
    return {...item,title:product.title};
   });
   if(!Number.isSafeInteger(subtotal)||subtotal>request.maxAmount)throw new DomainError('task_budget_too_small',422);
   const task={merchant_id:config.MERCHANT_ID,merchant_name:config.MERCHANT_NAME,currency:'JPY',max_amount:request.maxAmount,items,
    instrument_id:`yours:${config.CHAIN_ID}:${actor.address}:${connection.id}`,expires_at:expires};
   const id=randomUUID(),hash=digest(task),nonce='0x'+randomBytes(32).toString('hex'),validUntil=now+300;
   await tx.query('INSERT INTO task_consents(id,account_id,connection_id,task,task_hash,nonce,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,actor.accountId,connection.id,JSON.stringify(task),hash,nonce,validUntil]);
   await audit(tx,actor.accountId,'owner:'+actor.accountId,'task.consent_requested',id,{taskHash:hash,connectionId:connection.id});
   return {id,task,typedData:{domain:consentDomain(config.CHAIN_ID,config.GATE_ADDRESS as Address),types:{TaskConsent:taskConsentTypes.TaskConsent},primaryType:'TaskConsent',message:{account:actor.address,connectionId:keccak256(stringToHex(connection.id)),taskHash:'0x'+hash,nonce,validUntil:String(validUntil)}}};
  });
  return c.json(result,201);
 });
 router.post('/:id/approve',async c=>{
  const actor=owner(c),id=z.string().uuid().parse(c.req.param('id'));
  const request=z.object({signature:z.string().regex(/^0x[0-9a-fA-F]{130}$/)}).strict().parse(await c.req.json());
  const {rows:[row]}=await db.query('SELECT id FROM task_consents WHERE id=$1 AND account_id=$2',[id,actor.accountId]);
  if(!row)throw new DomainError('task_not_found',404);
  const issued=await internalPost<{id:string;open_checkout:string;open_payment:string}>(config,config.MANDATES_URL,'/v1/issue',{consent_id:id,signature:request.signature});
  return c.json({id:issued.id,status:'authorized'});
 });
 router.get('/',async c=>{
  const actor=owner(c);
  const {rows}=await db.query(`SELECT m.id,m.connection_id,m.task,m.expires_at,m.revoked_at,m.created_at,i.id AS intent_id,i.state,i.transaction_hash FROM mandates m LEFT JOIN mandate_consumptions mc ON mc.mandate_id=m.id LEFT JOIN intents i ON i.id=mc.intent_id WHERE m.account_id=$1 ORDER BY m.created_at DESC LIMIT 50`,[actor.accountId]);
  return c.json({tasks:rows});
 });
 router.post('/:id/revoke',async c=>{
  const actor=owner(c),id=z.string().uuid().parse(c.req.param('id'));
  await transaction(db,async tx=>{
   await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[actor.accountId]);
   const {rowCount}=await tx.query('UPDATE mandates SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 AND account_id=$2',[id,actor.accountId]);
   if(!rowCount)throw new DomainError('task_not_found',404);
   await tx.query("UPDATE intents SET state='canceled',updated_at=now() WHERE id IN (SELECT intent_id FROM mandate_consumptions WHERE mandate_id=$1) AND state IN ('prepared','approval_required','authorized')",[id]);
   await audit(tx,actor.accountId,'owner:'+actor.accountId,'task.revoked',id);
  });
  return c.json({id,status:'revoked'});
 });
 return router;
}
