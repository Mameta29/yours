import {readFile} from 'node:fs/promises';
import {serve} from '@hono/node-server';
import {Hono} from 'hono';
import {processOrderWebhook} from './webhooks.js';
import {z} from 'zod';
import {bodyLimit} from 'hono/body-limit';
import {createPublicClient,http,keccak256,getAddress,type Address,type Hex} from 'viem';
import {polygonAmoy} from 'viem/chains';
import {GoogleAuth} from 'google-auth-library';
import {KmsEvmSigner} from '@yours/signing';
import {createDb,claimWork,finishWork} from '@yours/storage';
import {DomainError} from '@yours/domain';
import {executePayment,type SettlementRuntime} from './settlement.js';
import {parseMerchants} from '@yours/jpyc-ec';
import {settleEcOrder} from './ec-settlement.js';

const required=(key:string)=>{const value=process.env[key];if(!value)throw new Error('Missing '+key);return value;};
const db=createDb(required('DATABASE_URL'));
const manifest=JSON.parse(await readFile(process.env.CHAIN_MANIFEST_PATH??'deployments/amoy.json','utf8'));
if(manifest.chainId!==80002)throw new Error('amoy_required');
const client=createPublicClient({chain:polygonAmoy,transport:http(required('RPC_URL'),{timeout:10000,retryCount:1})});
if(await client.getChainId()!==80002)throw new Error('rpc_chain_mismatch');
for(const pin of manifest.contracts){const code=await client.getCode({address:pin.address});if(!code||keccak256(code)!==pin.codeHash)throw new Error('deployment_code_changed');}
for(const pin of manifest.proxyImplementations??[]){
 const slot=await client.getStorageAt({address:pin.proxy,slot:pin.slot});
 if(!slot||getAddress('0x'+slot.slice(-40))!==getAddress(pin.implementation))throw new Error('proxy_changed');
 const code=await client.getCode({address:pin.implementation});if(!code||keccak256(code)!==pin.codeHash)throw new Error('implementation_changed');
}
const signers={} as SettlementRuntime['signers'];
for(const role of ['relayer','agent','merchant','risk'] as const){
 const signer=await KmsEvmSigner.create(required(role.toUpperCase()+'_KEY'));
 if(getAddress(signer.address)!==getAddress(manifest.addresses[role]))throw new Error('signing_key_mismatch');
 signers[role]=signer.account();
}
const authority=new URL(required('MANDATES_URL'));if(authority.protocol!=='https:'||authority.pathname!=='/'||authority.search||authority.hash)throw new Error('invalid_authority_origin');
const auth=new GoogleAuth();
async function privatePost(path:string,body:unknown,origin=authority.origin){
 const tokenClient=await auth.getIdTokenClient(origin),token=await tokenClient.idTokenProvider.fetchIdToken(origin);
 const response=await fetch(origin+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new DomainError('authority_rejected',response.status);return await response.json() as any;
}
const runtime:SettlementRuntime={client,chainId:80002,gate:manifest.gate,manager:manifest.manager,token:manifest.jpyc,enforcers:manifest.enforcers,merchantId:required('MERCHANT_ID'),payTo:getAddress(required('MERCHANT_PAY_TO')),origin:required('PUBLIC_ORIGIN'),signers,verifyIntent:id=>privatePost('/v1/verify-execution',{intent_id:id}),endorseIntent:id=>privatePost('/v1/endorse-order',{intent_id:id})};
runtime.ecMerchants=parseMerchants(process.env.EC_MERCHANTS_JSON);
const app=new Hono();
app.use('*',bodyLimit({maxSize:4096}));
app.get('/health',c=>c.json({ok:true,service:'yours-worker'}));
// This service has no allUsers invoker binding. Only the API and scheduler can wake persisted, authorized work.
app.post('/run',async c=>{
 const {intentId}=z.object({intentId:z.string().uuid().optional()}).strict().parse(await c.req.json());
 let processed=0,pending=0;
 for(let i=0;i<8;i++){
  const item=await claimWork(db,['payment.execute','order.receipts','order.webhook','order.webhook.received','ec.settle'],180,intentId);if(!item)break;
  try{
   const id=String(item.payload.intentId);
   if(item.topic==='payment.execute'){
    const result=await executePayment(db,id,runtime);
    if(['submitted','confirming','approval_required','payment_required','agent_signature_required'].includes(result.state)){await finishWork(db,item,'awaiting_'+result.state);pending++;continue;}
   }else if(item.topic==='ec.settle'){
    await settleEcOrder(db,id,{merchants:runtime.ecMerchants!,chainId:runtime.chainId,token:runtime.token});
   }else if(item.topic==='order.webhook.received'){
    await processOrderWebhook(db,String(item.payload.source),String(item.payload.eventId));
   }else if(item.topic==='order.webhook'){
    await privatePost('/internal/webhooks/deliver',{workId:item.id,leaseToken:item.lease_token},runtime.origin);
   }else{
    const receipt=await privatePost('/v1/receipts',{intent_id:id});
    await db.query('INSERT INTO order_receipts(intent_id,document) VALUES($1,$2) ON CONFLICT(intent_id) DO NOTHING',[id,JSON.stringify(receipt)]);
   }
   await finishWork(db,item);processed++;
  }catch(error){
   const code=error instanceof DomainError?error.code:'worker_dependency_error';
   await finishWork(db,item,code);pending++;
   console.error(JSON.stringify({severity:'WARNING',event:'work_retry',workId:item.id,code}));
  }
 }
 return c.json({processed,pending});
});
app.onError((_error,c)=>c.json({error:'worker_unavailable'},503));
const server=serve({fetch:app.fetch,port:Number(process.env.PORT??8080),hostname:'0.0.0.0'});
process.on('SIGTERM',()=>server.close(()=>void db.end()));
