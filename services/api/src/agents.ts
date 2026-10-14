import {Hono} from 'hono';
import {z} from 'zod';
import {DomainError} from '@yours/domain';
import type {Db} from '@yours/storage';
import {verifyCheckout} from '@yours/ucp';
import type {P256Signer} from '@yours/signing';
import type {Config} from './config.js';
import {authenticate,type Env} from './auth.js';
import {internalPost} from './internal.js';
import {x402Routes} from './x402.js';

export function agentRoutes(db:Db,config:Config,signer:P256Signer){
 const router=new Hono<Env>();
 router.use('*',async(c,next)=>{const actor=await authenticate(c,db,config);if(actor.kind!=='agent')throw new DomainError('agent_required',403);c.set('actor',actor);await next();});
 router.get('/tasks',async c=>{
  const actor=c.get('actor');if(actor.kind!=='agent')throw new DomainError('agent_required',403);
  const {rows}=await db.query('SELECT m.id,m.task,m.expires_at,mc.intent_id,i.state FROM mandates m LEFT JOIN mandate_consumptions mc ON mc.mandate_id=m.id LEFT JOIN intents i ON i.id=mc.intent_id WHERE m.connection_id=$1 AND m.revoked_at IS NULL AND m.expires_at>now() ORDER BY m.created_at DESC LIMIT 20',[actor.connectionId]);return c.json({tasks:rows});
 });
 router.post('/present',async c=>{
  const actor=c.get('actor');if(actor.kind!=='agent')throw new DomainError('agent_required',403);
  const body=z.object({mandateId:z.string().uuid(),checkoutId:z.string().uuid()}).strict().parse(await c.req.json());
  const {rows:[mandate]}=await db.query('SELECT m.*,c.provider FROM mandates m JOIN connections c ON c.id=m.connection_id WHERE m.id=$1 AND m.connection_id=$2',[body.mandateId,actor.connectionId]);if(!mandate)throw new DomainError('task_not_found',404);
  const {rows:[session]}=await db.query("SELECT document FROM merchant_sessions WHERE id=$1 AND actor=$2 AND kind='checkout'",[body.checkoutId,'agent:'+actor.connectionId]);if(!session)throw new DomainError('checkout_not_found',404);
  const checkoutJwt=await verifyCheckout(session.document,[signer.publicJwk]);
  if(mandate.provider!=='gemini')return c.json({checkoutJwt,open_checkout:mandate.open_checkout,open_payment:mandate.open_payment,instrumentId:mandate.task.instrument_id});
  const result=await internalPost(config,config.MANDATES_URL,'/v1/present',{mandate_id:body.mandateId,checkout_id:body.checkoutId,checkout_jwt:checkoutJwt});
  return c.json({mandates:result,instrumentId:mandate.task.instrument_id});
 });
 x402Routes(router,db,config);
 return router;
}
