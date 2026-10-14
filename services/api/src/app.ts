import {randomUUID,randomBytes} from 'node:crypto';
import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {secureHeaders} from 'hono/secure-headers';
import {z,ZodError} from 'zod';
import {DomainError,sha256,addressSchema,periodIndex} from '@yours/domain';
import {transaction,audit,pauseConnection,budgetUsage,type Db} from '@yours/storage';
import {profile,UCP_VERSION,validateSchema} from '@yours/ucp';
import type {P256Signer} from '@yours/signing';
import type {Config} from './config.js';
import {authRoutes,authenticate,owner,type Env} from './auth.js';
import {merchantRoutes} from './merchant.js';
import {taskRoutes} from './tasks.js';
import {permissionRoutes} from './permissions.js';
import {agentRoutes} from './agents.js';
import {approvalRoutes} from './approvals.js';
import {purchaseRoutes} from './purchases.js';
import {demoRoutes} from './demo.js';
import {publicRoutes} from './public.js';
import {runRoutes} from './runs.js';
import type {ChainRuntime} from './chain.js';

export function createApp(db:Db,config:Config,signer:P256Signer,chain?:ChainRuntime){
 const app=new Hono<Env>();
 app.use('*',bodyLimit({maxSize:262144,onError:c=>c.json({error:'body_too_large'},413)}));
 app.use('*',secureHeaders({crossOriginEmbedderPolicy:false}));
 app.use('*',async(c,next)=>{const id=randomUUID();c.header('X-Request-Id',id);c.header('Cache-Control','no-store');await next();});
 const failure=(c:any,code:string,status:number,details?:unknown)=>{
  if(c.req.path.startsWith('/ucp/')){
   const result={ucp:{version:UCP_VERSION,status:'error'},messages:[{type:'error',code,content:code,content_type:'plain',severity:status===401||status===403?'requires_buyer_input':status===409||status===412?'recoverable':'unrecoverable'}]};
   validateSchema('common/types/error_response.json',result);return c.json(result,status);
  }
  return c.json({error:code,...(details?{details}:{})},status);
 };
 app.onError((error,c)=>{
  if(error instanceof ZodError)return failure(c,'invalid_request',422,error.issues.map(e=>({path:e.path,message:e.message})));
  if(error instanceof DomainError)return failure(c,error.code,error.status,error.details);
  if(error instanceof SyntaxError)return failure(c,'invalid_json',400);
  console.error(JSON.stringify({severity:'ERROR',event:'request_failed',requestId:c.res.headers.get('X-Request-Id'),error:error instanceof Error?error.name:'unknown'}));
  return failure(c,'internal_error',500);
 });
 app.route('/',publicRoutes());
 app.get('/health',c=>c.json({ok:true,service:'yours-api'}));
 app.get('/ready',async c=>{await db.query('SELECT 1');return c.json({ok:true});});
 app.get('/api/config',c=>c.json({name:'yours',chainId:config.CHAIN_ID,network:config.CHAIN_ID===80002?'Polygon Amoy':'Local test chain',ucpVersion:UCP_VERSION,merchant:{id:config.MERCHANT_ID,name:config.MERCHANT_NAME},paymentsConfigured:Boolean(chain&&config.MANDATES_URL&&config.GATE_ADDRESS&&config.JPYC_ADDRESS&&config.MERCHANT_PAY_TO),gate:config.GATE_ADDRESS,token:config.JPYC_ADDRESS,geminiConfigured:Boolean(config.AGENT_URL)}));
 for(const path of ['/.well-known/ucp','/profiles/platform'])app.get(path,c=>{
  const document=profile(config.PUBLIC_ORIGIN,'platform',[signer.publicJwk],{network:'eip155:'+config.CHAIN_ID,asset:config.JPYC_ADDRESS,gate:config.GATE_ADDRESS});
  c.header('Cache-Control','public, max-age=300');c.header('ETag','"'+sha256(JSON.stringify(document))+'"');return c.json(document);
 });
 app.route('/api/demo',demoRoutes(db,config));
 app.route('/api/auth',authRoutes(db,config));
 app.route('/ucp',merchantRoutes(db,config,signer));
 app.route('/api/agent',agentRoutes(db,config,signer));
 app.use('/api/owner/*',async(c,next)=>{c.set('actor',await authenticate(c,db,config));owner(c);await next();});
 app.route('/api/owner/purchases',purchaseRoutes(db,config));
 app.route('/api/owner/tasks',taskRoutes(db,config));
 app.route('/api/owner/approvals',approvalRoutes(db,config));
 app.route('/api/owner/runs',runRoutes(db,config));
 if(chain)app.route('/api/owner/permissions',permissionRoutes(db,config,chain));
 app.get('/api/owner/me',async c=>{
  const actor=owner(c);
  const {rows:connections}=await db.query('SELECT c.id,c.name,c.provider,c.agent_address,c.status,c.created_at,p.document AS permission,p.status AS permission_status FROM connections c LEFT JOIN permissions p ON p.connection_id=c.id WHERE c.account_id=$1 ORDER BY c.created_at',[actor.accountId]);
  const {rows:[policy]}=await db.query('SELECT document,gate_address,token_address,currency,activation_tx FROM policies WHERE account_id=$1',[actor.accountId]);
  const {rows:intents}=await db.query('SELECT id,connection_id,merchant_id,currency,amount_minor,amount_atomic,state,reasons,transaction_hash,created_at FROM intents WHERE account_id=$1 ORDER BY created_at DESC LIMIT 50',[actor.accountId]);
  const usage=policy?await transaction(db,tx=>budgetUsage(tx,actor.accountId,connections[0]?.id??'00000000-0000-0000-0000-000000000000',periodIndex(policy.document,Math.floor(Date.now()/1000)))):null;
  return c.json({account:{id:actor.accountId,address:actor.address,chainId:config.CHAIN_ID},connections,policy:policy??null,intents,usage});
 });
 app.post('/api/owner/connections',async c=>{
  const actor=owner(c);
  const body=z.object({name:z.string().trim().min(1).max(80),provider:z.enum(['gemini','external']),agentAddress:addressSchema.optional(),ap2PublicJwk:z.record(z.unknown()).optional()}).strict().parse(await c.req.json());
  const address=body.provider==='gemini'?config.AGENT_ADDRESS:body.agentAddress;
  if(!address)throw new DomainError('agent_key_not_configured',409);
  if(body.ap2PublicJwk&&['d','k','p','q'].some(k=>k in body.ap2PublicJwk!))throw new DomainError('private_key_forbidden',422);
  const id=randomUUID(),token=randomBytes(32).toString('base64url');
  await transaction(db,async tx=>{
   await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[actor.accountId]);
   const {rows}=await tx.query("SELECT id FROM connections WHERE account_id=$1 AND agent_address=$2 AND status<>'revoked'",[actor.accountId,address.toLowerCase()]);
   if(rows.length)throw new DomainError('agent_already_connected',409);
   await tx.query("INSERT INTO connections(id,account_id,name,provider,agent_address,ap2_public_jwk,token_hash,status) VALUES($1,$2,$3,$4,$5,$6,$7,'pending')",[id,actor.accountId,body.name,body.provider,address.toLowerCase(),JSON.stringify(body.ap2PublicJwk??null),sha256(token)]);
   await audit(tx,actor.accountId,'owner:'+actor.accountId,'connection.created',id,{provider:body.provider,agentAddress:address});
  });
  return c.json({id,name:body.name,provider:body.provider,agentAddress:address,status:'pending',agentToken:token},201);
 });
 app.post('/api/owner/connections/:id/pause',async c=>{
  const actor=owner(c);const id=z.string().uuid().parse(c.req.param('id'));
  await pauseConnection(db,actor.accountId,id);return c.json({id,status:'paused',onchainRevocationRequired:true});
 });
 app.get('/api/owner/audit',async c=>{
  const actor=owner(c);const {rows}=await db.query('SELECT sequence,actor,action,resource_id,data,created_at FROM audit_events WHERE account_id=$1 ORDER BY sequence DESC LIMIT 100',[actor.accountId]);return c.json({events:rows});
 });
 return app;
}
