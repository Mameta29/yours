import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {externalPaymentTypedData,encodePayment} from '@yours/wallet-sdk';
import {verifyCheckout,verifyHttp,validateSchema,UCP_VERSION} from '@yours/ucp';

const root=fileURLToPath(new URL('../../',import.meta.url));
const keyPath=resolve(process.env.YOURS_AGENT_KEY_FILE??root+'.local/external-agent/keys.json');
const command=process.argv[2];
const json=value=>JSON.stringify(value,(_key,v)=>typeof v==='bigint'?v.toString():v);
function publicRegistration(keys){const {d,...publicJwk}=keys.ap2;return {agentAddress:privateKeyToAccount(keys.evm).address,ap2PublicJwk:publicJwk};}
async function main(){
 if(command==='init'){
  const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const keys={evm:generatePrivateKey(),ap2:{...pair.privateKey.export({format:'jwk'}),kid:'external-'+randomUUID(),alg:'ES256'}};
  await mkdir(dirname(keyPath),{recursive:true,mode:0o700});
  await writeFile(keyPath,json(keys)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify(publicRegistration(keys),null,2));return;
 }
 if(!['tasks','run'].includes(command))throw new Error('Usage: pnpm --filter @yours/external-agent-example init|tasks|run <approved-mandate-id>');
 const keys=JSON.parse(await readFile(keyPath,'utf8')),agent=privateKeyToAccount(keys.evm);
 const origin=new URL(process.env.YOURS_ORIGIN??'https://yours-api-110852561536.asia-northeast1.run.app');
 if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw new Error('YOURS_ORIGIN must be an HTTPS origin');
 const token=process.env.YOURS_AGENT_TOKEN;if(!token)throw new Error('Set YOURS_AGENT_TOKEN to the token issued by your connection');
 const platform=process.env.YOURS_PLATFORM_PROFILE??origin.origin+'/profiles/platform';
 const manifest=JSON.parse(await readFile(new URL('../../deployments/amoy.json',import.meta.url),'utf8'));
 if(manifest.chainId!==80002)throw new Error('Only the checked-in Polygon Amoy deployment is enabled');
 const profileResponse=await fetch(origin.origin+'/.well-known/ucp',{redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!profileResponse.ok)throw new Error('Discovery unavailable');
 const profile=await profileResponse.json();validateSchema('profile.json',profile);
 if(profile.ucp.version!==UCP_VERSION)throw new Error('Unsupported UCP version');
 async function api(path,body,{key,etag,payment,allow=[]}={}){
  const response=await fetch(origin.origin+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(90000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','UCP-Agent':'profile="'+platform+'"',...(key?{'Idempotency-Key':key}:{}),...(etag?{'If-Match':etag}:{}),...(payment?{'PAYMENT-SIGNATURE':encodePayment(payment)}:{})},...(body===undefined?{}:{body:json(body)})});
  const raw=new Uint8Array(await response.arrayBuffer());
  if(path.startsWith('/ucp/checkout-sessions')&&response.ok)await verifyHttp({status:response.status,headers:Object.fromEntries(response.headers)},raw,profile.keys);
  let data;try{data=JSON.parse(new TextDecoder().decode(raw));}catch{throw new Error('API returned a non-JSON response');}
  if(!response.ok&&!allow.includes(response.status))throw new Error(data.error??data.messages?.[0]?.code??'request_failed');
  return {data,status:response.status,etag:response.headers.get('etag')};
 }
 const tasks=(await api('/api/agent/tasks')).data.tasks;
 if(command==='tasks'){console.log(JSON.stringify({tasks},null,2));return;}
 const task=tasks.find(t=>t.id===process.argv[3]);if(!task)throw new Error('Specify a live task that the owner approved for this connection');
 const file=resolve(dirname(keyPath),'task-'+task.id+'.json');
 let saved={};try{saved=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 async function save(){const tmp=file+'.'+randomUUID()+'.tmp';await writeFile(tmp,json(saved)+'\n',{flag:'wx',mode:0o600});await rename(tmp,file);}
 let intentId=task.intent_id??saved.intentId;
 if(!intentId){
  if(!saved.checkout){
   const result=await api('/ucp/checkout-sessions',{line_items:task.task.items.map(item=>({item:{id:item.id},quantity:item.quantity}))},{key:'checkout:'+task.id});
   saved={...saved,checkout:result.data,etag:result.etag};await save();
  }
  const checkout=saved.checkout;await verifyCheckout(checkout,profile.keys);
  if(checkout.status!=='ready_for_complete'||checkout.merchant.id!==task.task.merchant_id||checkout.currency!==task.task.currency||checkout.totals.find(t=>t.type==='total').amount>task.task.max_amount)throw new Error('Checkout is outside the approved task');
  if(checkout.line_items.length!==task.task.items.length||checkout.line_items.some(line=>!task.task.items.some(item=>item.id===line.item.id&&item.quantity===line.quantity)))throw new Error('Checkout line items changed');
  if(!saved.complete){
   const opens=(await api('/api/agent/present',{mandateId:task.id,checkoutId:checkout.id})).data;
   const mandates=JSON.parse(execFileSync('uv',['run','python',root+'examples/external-agent/present.py'],{cwd:root+'services/mandates',env:{...process.env,UV_CACHE_DIR:root+'.local/uv-cache'},input:json({...opens,checkout,private_jwk:keys.ap2,expiresAt:Math.floor(new Date(task.expires_at).getTime()/1000)}),encoding:'utf8',maxBuffer:262144}));
   saved.complete={payment:{instruments:[{id:opens.instrumentId,handler_id:'yours-stablecoin',type:'stablecoin',selected:true,credential:{type:'yours_ap2',mandate_id:task.id}}]},ap2:mandates};await save();
  }
  const result=await api('/ucp/checkout-sessions/'+checkout.id+'/complete',saved.complete,{key:'complete:'+task.id,etag:saved.etag});
  intentId=result.data.yours.intent_id;saved.intentId=intentId;await save();
 }
 for(let attempt=0;attempt<90;attempt++){
  const result=await api('/api/agent/payments/'+intentId,undefined,{allow:[402,409]});
  if(result.data.state==='confirmed'){console.log(JSON.stringify(result.data,null,2));return;}
  if(['failed','canceled'].includes(result.data.state))throw new Error('Payment '+result.data.state+'; no new transfer is attempted');
  const auth=(await api('/api/agent/payments/'+intentId+'/authorization')).data;
  if(auth.signingRequest){
   const request=auth.signingRequest,checkout=saved.checkout;
   if(!checkout)throw new Error('The local checkout journal is required to verify this payment before signing');
   const owner=task.task.instrument_id.split(':')[2];
   const typed=externalPaymentTypedData(request.envelope,{chainId:80002,gate:manifest.gate,manager:manifest.manager,owner,agent:agent.address,token:manifest.jpyc,payTo:checkout.yours.pay_to,amount:BigInt(checkout.totals.find(t=>t.type==='total').amount)*10n**18n,enforcers:manifest.enforcers});
   if(!saved.proof||saved.proof.challenge!==request.challenge){saved.proof={challenge:request.challenge,leaf:await agent.signTypedData(typed.leaf),intent:await agent.signTypedData(typed.intent)};await save();}
   auth.paymentPayload=(await api('/api/agent/payments/'+intentId+'/authorization',saved.proof)).data.paymentPayload;
  }
  if(auth.paymentPayload){
   const paid=await api('/api/agent/payments/'+intentId,{}, {payment:auth.paymentPayload});
   if(paid.data.state==='confirmed'){console.log(JSON.stringify(paid.data,null,2));return;}
   if(paid.data.state==='approval_required'){console.log(JSON.stringify({state:'approval_required',intentId,reviewUrl:origin.origin}));return;}
  }
  await new Promise(resolve=>setTimeout(resolve,2000));
 }
 console.log(JSON.stringify({state:'pending',intentId,message:'Run the same task ID again to reconcile; do not create another purchase.'}));
}
main().catch(error=>{console.error(JSON.stringify({error:error.shortMessage??error.message}));process.exitCode=1;});
