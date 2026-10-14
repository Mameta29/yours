import {Hono} from 'hono';
import {z} from 'zod';
import {OAuth2Client} from 'google-auth-library';
import {DomainError} from '@yours/domain';
import {acceptWebhook,type Db} from '@yours/storage';
import {profile,parseAgentHeader,fetchProfile,signHttp,verifyHttp,safeRequest,validateSchema,UCP_VERSION} from '@yours/ucp';
import type {P256Signer} from '@yours/signing';
import type {Config} from './config.js';
const identity=new OAuth2Client();

async function requireWorker(c:any,config:Config){
 if(config.NODE_ENV!=='production')return; // Local integration only; Cloud deployment always uses production.
 if(!config.WORKER_IDENTITY)throw new DomainError('worker_identity_not_configured',503);
 const token=c.req.header('Authorization')?.match(/^Bearer (\S+)$/)?.[1];
 if(!token)throw new DomainError('service_identity_required',401);
 try{
  const ticket=await identity.verifyIdToken({idToken:token,audience:config.PUBLIC_ORIGIN});
  const claims=ticket.getPayload();
  if(claims?.email!==config.WORKER_IDENTITY||claims.email_verified!==true)throw new Error('wrong_caller');
 }catch{throw new DomainError('service_identity_invalid',403);}
}
export function webhookRoutes(db:Db,config:Config,signer:P256Signer){
 const router=new Hono();
 router.post('/api/webhooks/orders',async c=>{
  const source=parseAgentHeader(c.req.header('UCP-Agent'));
  const raw=new Uint8Array(await c.req.arrayBuffer());
  // The platform currently accepts events only for orders it actually created
  // with the enrolled business. A valid signature alone never creates an order.
  if(source!==config.PUBLIC_ORIGIN+'/.well-known/ucp')throw new DomainError('order_business_mismatch',403);
  await verifyHttp({method:c.req.method,url:config.PUBLIC_ORIGIN+new URL(c.req.url).pathname,headers:Object.fromEntries(c.req.raw.headers)},raw,[signer.publicJwk]);
  const id=z.string().min(1).max(128).parse(c.req.header('Webhook-Id'));
  const timestamp=Number(c.req.header('Webhook-Timestamp'));
  if(!Number.isSafeInteger(timestamp)||timestamp<=0||timestamp>Math.floor(Date.now()/1000)+30)throw new DomainError('webhook_timestamp_invalid',422);
  const document=JSON.parse(Buffer.from(raw).toString('utf8'));validateSchema('shopping/order.json',document);
  const orderId=z.string().uuid().parse(document.id);
  const {rows:[order]}=await db.query('SELECT o.id,o.session_id,s.merchant_id,i.id AS intent_id FROM merchant_orders o JOIN merchant_sessions s ON s.id=o.session_id JOIN intents i ON i.checkout_id=s.id::text WHERE o.id=$1',[orderId]);
  if(!order||order.merchant_id!==config.MERCHANT_ID||document.checkout_id!==order.session_id)throw new DomainError('order_business_mismatch',403);
  const accepted=await acceptWebhook(db,source,id,document,order.intent_id);
  return c.json({ucp:{version:UCP_VERSION,status:'success'},received:true,duplicate:!accepted});
 });
 router.post('/internal/webhooks/deliver',async c=>{
  await requireWorker(c,config);
  const {workId,leaseToken}=z.object({workId:z.string().uuid(),leaseToken:z.string().uuid()}).strict().parse(await c.req.json());
  const {rows:[work]}=await db.query("SELECT * FROM outbox WHERE id=$1 AND topic='order.webhook' AND lease_token=$2 AND lease_until>now() AND completed_at IS NULL",[workId,leaseToken]);
  if(!work)throw new DomainError('webhook_work_not_leased',409);
  const payload=work.payload,localProfile=config.PUBLIC_ORIGIN+'/.well-known/ucp';
  const platform=payload.platformProfile===localProfile||payload.platformProfile===config.PUBLIC_ORIGIN+'/profiles/platform'
   ?profile(config.PUBLIC_ORIGIN,'platform',[signer.publicJwk])
   :await fetchProfile(payload.platformProfile,new Set(config.TRUSTED_PROFILE_ORIGINS.split(',').filter(Boolean)),config.NODE_ENV!=='production');
  const url=platform.ucp.capabilities['dev.ucp.shopping.order']?.find(c=>c.version===UCP_VERSION)?.config?.webhook_url;
  if(typeof url!=='string')return c.json({delivered:false,reason:'platform_did_not_request_order_events'});
  const destination=new URL(url),enrolled=new URL(payload.platformProfile);
  if(destination.origin!==enrolled.origin||destination.username||destination.password||destination.hash)throw new DomainError('webhook_destination_not_enrolled',403);
  if(destination.protocol!=='https:'&&!(config.NODE_ENV!=='production'&&['localhost','127.0.0.1'].includes(destination.hostname)))throw new DomainError('webhook_https_required',403);
  validateSchema('shopping/order.json',payload.document);
  const body=Buffer.from(JSON.stringify(payload.document));
  const signed=await signHttp({method:'POST',url,headers:{'Content-Type':'application/json','UCP-Agent':'profile="'+localProfile+'"','Webhook-Id':payload.eventId,'Webhook-Timestamp':String(payload.occurredAt),'Idempotency-Key':payload.eventId}},body,signer);
  const response=await safeRequest(url,{allowedOrigins:new Set([enrolled.origin]),allowLoopback:config.NODE_ENV!=='production',method:'POST',headers:signed.headers as Record<string,string>,body,timeout:10000,maxBytes:65536});
  if(response.status<200||response.status>=300)throw new DomainError('webhook_delivery_failed',502);
  if(!response.headers['content-type']?.includes('application/json'))throw new DomainError('webhook_ack_invalid',502);
  const ack=JSON.parse(response.body.toString('utf8'));validateSchema('ucp.json#/$defs/base',ack.ucp);
  if(ack.ucp.version!==UCP_VERSION||ack.ucp.status==='error')throw new DomainError('webhook_ack_invalid',502);
  return c.json({delivered:true,eventId:payload.eventId});
 });
 return router;
}
