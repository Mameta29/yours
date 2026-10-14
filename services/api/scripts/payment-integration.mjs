import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {writeFile,mkdir,rm} from 'node:fs/promises';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {toHex,maxUint256,parseEther,encodePacked} from 'viem';
import {sha256} from '@yours/domain';
import {createDb,migrate} from '@yours/storage';
import {encodeDelegations,delegationTypedData} from '@yours/wallet-sdk';
import {verifyCheckout,validateSchema} from '@yours/ucp';
import {createApp} from '../dist/app.js';
import {readConfig} from '../dist/config.js';
import {chainRuntime} from '../dist/chain.js';
import {executePayment} from '../../worker/dist/settlement.js';

export async function paymentIntegration({root,client,wallet,accounts,manifest,jpyc,humanKey}){
 const db=createDb('postgresql://localhost/yours_test');await migrate(db);
 const owner=privateKeyToAccount(generatePrivateKey()),payTo='0x0000000000000000000000000000000000000200';
 const keydir=root+'.local/payment-e2e-'+randomUUID();await mkdir(keydir,{recursive:true,mode:0o700});
 const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const signer={kid:'ucp-merchant',publicJwk:{...pair.publicKey.export({format:'jwk'}),kid:'ucp-merchant',alg:'ES256',use:'sig'},sign:async bytes=>new Uint8Array(sign('sha256',bytes,{key:pair.privateKey,dsaEncoding:'ieee-p1363'}))};
 const authority=spawn('uv',['run','uvicorn','yours_mandates.service:from_environment','--factory','--host','127.0.0.1','--port','18813','--no-access-log'],{cwd:root+'services/mandates',env:{...process.env,UV_CACHE_DIR:root+'.local/uv-cache',DATABASE_URL:'postgresql://localhost/yours_test',CHAIN_ID:'31337',GATE_ADDRESS:manifest.gate,PUBLIC_ORIGIN:'http://localhost:8080',MERCHANT_PUBLIC_JWK:JSON.stringify(signer.publicJwk),LOCAL_KEY_DIR:keydir,LOCAL_HUMAN_PRIVATE_KEY:humanKey,ENVIRONMENT:'test'},stdio:['ignore','ignore','pipe']});
 let stderr='';authority.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-2000);});
 const config=readConfig({NODE_ENV:'test',DATABASE_URL:'postgresql://localhost/yours_test',PUBLIC_ORIGIN:'http://localhost:8080',RPC_URL:'http://127.0.0.1:18812',CHAIN_ID:'31337',MERCHANT_PAY_TO:payTo,JPYC_ADDRESS:manifest.jpyc,GATE_ADDRESS:manifest.gate,AGENT_ADDRESS:accounts.agent.address,MANDATES_URL:'http://127.0.0.1:18813'});
 const app=createApp(db,config,signer,chainRuntime(config,manifest));let cookie='',token='';
 async function request(path,body,{status=200,asAgent=false,method,headers={}}={}){
  const response=await app.request(path,{method:method??(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json',Origin:config.PUBLIC_ORIGIN,...(asAgent?{Authorization:'Bearer '+token,'UCP-Agent':'profile="'+config.PUBLIC_ORIGIN+'/.well-known/ucp"'}:cookie?{Cookie:cookie}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const json=await response.json();assert.equal(response.status,status,JSON.stringify({path,response:json}));return {json,response};
 }
 async function send(call){const hash=await wallet.sendTransaction(call);assert.equal((await client.waitForTransactionReceipt({hash})).status,'success');return hash;}
 async function privatePost(path,body){const res=await fetch(config.MANDATES_URL+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const value=await res.json();assert.equal(res.status,200,JSON.stringify(value));return value;}
 try{
  for(let i=0;i<100;i++){
   try{if((await fetch(config.MANDATES_URL+'/health')).ok)break;}catch{}
   if(authority.exitCode!==null)throw new Error('AP2 process failed: '+stderr);
   if(i===99)throw new Error('AP2 process start timeout');await new Promise(resolve=>setTimeout(resolve,100));
  }
  await send({to:owner.address,data:'0x',authorizationList:[await owner.signAuthorization({contractAddress:manifest.accountImplementation,chainId:31337,nonce:0})],gas:150000n});
  const {json:challenge}=await request('/api/auth/challenge',{address:owner.address});
  const login=await request('/api/auth/verify',{nonce:challenge.nonce,signature:await owner.signMessage({message:challenge.message})});cookie=login.response.headers.get('set-cookie').split(';')[0];
  const {json:connection}=await request('/api/owner/connections',{provider:'gemini',name:'Payment integration'},{status:201});token=connection.agentToken;
  const {json:draft}=await request(`/api/owner/permissions/connections/${connection.id}/prepare`,{perOrder:1000,perPeriod:1000,globalPerOrder:2000,globalPerPeriod:2000,days:7,merchants:['yours-lab']},{status:201});
  const e=draft.expectation,parent={delegate:accounts.agent.address,delegator:owner.address,authority:toHex(maxUint256,{size:32}),salt:toHex(1n),signature:'0x',caveats:[
   {enforcer:manifest.enforcers.periodic,terms:encodePacked(['address','uint256','uint256','uint256'],[manifest.jpyc,maxUint256,maxUint256,BigInt(e.startTime)]),args:'0x'},
   {enforcer:manifest.enforcers.redeemer,terms:manifest.gate,args:'0x'},
   {enforcer:manifest.enforcers.timestamp,terms:encodePacked(['uint128','uint128'],[0n,BigInt(e.expiry)]),args:'0x'},
   {enforcer:manifest.enforcers.value,terms:toHex(0n,{size:32}),args:'0x'},
   {enforcer:manifest.enforcers.nonce,terms:toHex(0n,{size:32}),args:'0x'},
  ]};parent.signature=await owner.signTypedData(delegationTypedData(31337,manifest.manager,parent));
  const base='/api/owner/permissions/drafts/'+draft.id;
  const {json:terms}=await request(base+'/parents',{context:encodeDelegations([parent])});
  const {json:calls}=await request(base+'/transactions',{policy:await owner.signTypedData(terms.typedData.policy),permission:await owner.signTypedData(terms.typedData.permission)});
  const hashes=[];for(const call of calls.calls)hashes.push(await send(call));await client.request({method:'anvil_mine',params:['0x5']});
  await request(base+'/activate',{policy:hashes[0],permission:hashes[1]});
  await client.waitForTransactionReceipt({hash:await wallet.writeContract({...jpyc,functionName:'mint',args:[owner.address,parseEther('5000')]})});
  const productId='e2e-'+randomUUID();await db.query("INSERT INTO merchant_products(merchant_id,id,title,description,currency,amount_minor,stock) VALUES('yours-lab',$1,'yours integration item','Anvil test only','JPY',600,5)",[productId]);
  const {json:task}=await request('/api/owner/tasks/prepare',{connectionId:connection.id,merchantId:'yours-lab',items:[{id:productId,quantity:1}],maxAmount:650},{status:201});
  const {json:mandate}=await request('/api/owner/tasks/'+task.id+'/approve',{signature:await owner.signTypedData(task.typedData)});
  const {json:checkout}=await request('/ucp/checkout-sessions',{line_items:[{item:{id:productId},quantity:1}]},{asAgent:true,status:201,headers:{'Idempotency-Key':randomUUID()}});
  await verifyCheckout(checkout,[signer.publicJwk]);
  const {json:presentation}=await request('/api/agent/present',{mandateId:mandate.id,checkoutId:checkout.id},{asAgent:true});
  const body={payment:{instruments:[{id:presentation.instrumentId,handler_id:'yours-stablecoin',type:'stablecoin',selected:true,credential:{type:'yours_ap2',mandate_id:mandate.id}}]},ap2:presentation.mandates};
  const headers={'Idempotency-Key':randomUUID(),'If-Match':'"1"'};
  const simultaneous=await Promise.all([request('/ucp/checkout-sessions/'+checkout.id+'/complete',body,{asAgent:true,status:202,headers}),request('/ucp/checkout-sessions/'+checkout.id+'/complete',body,{asAgent:true,status:202,headers})]);
  const pending=simultaneous[0].json;assert.deepEqual(simultaneous[1].json,pending);
  assert.equal(pending.status,'complete_in_progress');
  const replay=await request('/ucp/checkout-sessions/'+checkout.id+'/complete',body,{asAgent:true,status:202,headers});assert.deepEqual(replay.json,pending);
  const intentId=pending.yours.intent_id;
  assert.equal((await db.query('SELECT count(*)::int AS n FROM mandate_consumptions WHERE mandate_id=$1',[mandate.id])).rows[0].n,1);
  const merchantBefore=await client.readContract({...jpyc,functionName:'balanceOf',args:[payTo]});
  const runtime={client:new Proxy(client,{get(target,key){if(key==='sendRawTransaction')return async params=>{await target.sendRawTransaction(params);throw new Error('Injected lost broadcast response');};return target[key];}}),chainId:31337,gate:manifest.gate,manager:manifest.manager,token:manifest.jpyc,enforcers:manifest.enforcers,merchantId:'yours-lab',payTo,origin:config.PUBLIC_ORIGIN,signers:{relayer:accounts.relayer,agent:accounts.agent,merchant:accounts.merchantSigner,risk:accounts.riskSigner},verifyIntent:id=>privatePost('/v1/verify-execution',{intent_id:id})};
  const prepared=await executePayment(db,intentId,runtime);assert.equal(prepared.state,'payment_required');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM signed_transactions WHERE intent_id=$1',[intentId])).rows[0].n,0);
  const required=await request('/api/agent/payments/'+intentId,undefined,{asAgent:true,status:402});
  assert.equal(JSON.parse(Buffer.from(required.response.headers.get('PAYMENT-REQUIRED'),'base64').toString()).accepts[0].amount,parseEther('600').toString());
  const authorization=(await request('/api/agent/payments/'+intentId+'/authorization',undefined,{asAgent:true})).json.paymentPayload;
  const altered=structuredClone(authorization);altered.accepted.amount='1';
  await request('/api/agent/payments/'+intentId,{}, {asAgent:true,status:422,headers:{'PAYMENT-SIGNATURE':Buffer.from(JSON.stringify(altered)).toString('base64')}});
  await request('/api/agent/payments/'+intentId,{}, {asAgent:true,status:202,headers:{'PAYMENT-SIGNATURE':Buffer.from(JSON.stringify(authorization)).toString('base64')}});
  await request('/api/agent/payments/'+intentId,{}, {asAgent:true,status:422,headers:{'PAYMENT-SIGNATURE':Buffer.from(JSON.stringify(altered)).toString('base64')}});
  runtime.endorseIntent=id=>privatePost('/v1/endorse-order',{intent_id:id});
  const submitted=await executePayment(db,intentId,runtime);assert.equal(submitted.state,'submitted');
  const journal=(await db.query('SELECT * FROM signed_transactions WHERE intent_id=$1',[intentId])).rows[0];assert.ok(journal.raw_transaction);assert.equal(journal.transaction_hash,submitted.transactionHash);
  const confirming=await executePayment(db,intentId,runtime);assert.equal(confirming.state,'confirming');
  await client.request({method:'anvil_mine',params:['0x5']});
  const settled=await executePayment(db,intentId,runtime);assert.equal(settled.state,'confirmed');
  const settledAgain=await executePayment(db,intentId,runtime);assert.deepEqual(settledAgain,settled);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM merchant_orders WHERE session_id=$1',[checkout.id])).rows[0].n,1);
  assert.equal((await db.query('SELECT stock FROM merchant_products WHERE merchant_id=$1 AND id=$2',['yours-lab',productId])).rows[0].stock,4);
  assert.equal((await client.readContract({...jpyc,functionName:'balanceOf',args:[payTo]}))-merchantBefore,parseEther('600'));
  assert.equal(await client.readContract({...jpyc,functionName:'balanceOf',args:[accounts.agent.address]}),0n);
  const completed=(await request('/ucp/checkout-sessions/'+checkout.id,undefined,{asAgent:true})).json;assert.equal(completed.status,'completed');await verifyCheckout(completed,[signer.publicJwk]);
  const order=(await request('/ucp/orders/'+completed.order.id,undefined,{asAgent:true})).json;validateSchema('shopping/order.json',order);
  const receipts=await privatePost('/v1/receipts',{intent_id:intentId});assert.ok(receipts.payment_receipt);assert.ok(receipts.checkout_receipt);
  const paid=await request('/api/agent/payments/'+intentId,undefined,{asAgent:true});
  assert.equal(JSON.parse(Buffer.from(paid.response.headers.get('PAYMENT-RESPONSE'),'base64').toString()).transaction,settled.transactionHash);
  const passed=['owner SIWE and real signed wallet delegation','fresh owner task consent issues AP2','signed UCP checkout and real AP2 presentation','atomic mandate consumption and budget reservation','idempotent complete','raw transaction persisted before broadcast','lost broadcast response recovered by same hash','five confirmations before order creation','idempotent chain reconciliation','inventory decremented exactly once','merchant receives 600 test JPYC','AI token balance stays zero','official UCP order schema','signed AP2 payment and checkout receipts'];
  passed.push('simultaneous complete retries return one committed response','altered x402 retry rejected after acceptance','x402 HTTP 402 requirements','no transaction before payment acceptance','altered x402 amount rejected','real ERC-7710 PAYMENT-SIGNATURE accepted','PAYMENT-RESPONSE only after settlement');
  const {json:secondTask}=await request('/api/owner/tasks/prepare',{connectionId:connection.id,merchantId:'yours-lab',items:[{id:productId,quantity:1}],maxAmount:650},{status:201});
  const {json:secondMandate}=await request('/api/owner/tasks/'+secondTask.id+'/approve',{signature:await owner.signTypedData(secondTask.typedData)});
  const {json:secondCheckout}=await request('/ucp/checkout-sessions',{line_items:[{item:{id:productId},quantity:1}]},{asAgent:true,status:201,headers:{'Idempotency-Key':randomUUID()}});
  const {json:secondPresentation}=await request('/api/agent/present',{mandateId:secondMandate.id,checkoutId:secondCheckout.id},{asAgent:true});
  const secondBody={payment:{instruments:[{id:secondPresentation.instrumentId,handler_id:'yours-stablecoin',type:'stablecoin',selected:true,credential:{type:'yours_ap2',mandate_id:secondMandate.id}}]},ap2:secondPresentation.mandates};
  const {json:held}=await request('/ucp/checkout-sessions/'+secondCheckout.id+'/complete',secondBody,{asAgent:true,status:202,headers:{'Idempotency-Key':randomUUID(),'If-Match':'"1"'}});
  const secondId=held.yours.intent_id;assert.equal(held.yours.payment_status,'approval_required');
  assert.equal((await executePayment(db,secondId,runtime)).state,'approval_required');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM signed_transactions WHERE intent_id=$1',[secondId])).rows[0].n,0);
  const {json:approval}=await request('/api/owner/approvals/'+secondId+'/prepare',{}, {status:201});
  assert.equal(approval.typedData.message.overrideMask,2);
  await request('/api/owner/approvals/'+approval.id+'/approve',{signature:await accounts.agent.signTypedData(approval.typedData)},{status:401});
  const ownerSignature=await owner.signTypedData(approval.typedData);
  await request('/api/owner/approvals/'+approval.id+'/approve',{signature:ownerSignature});
  const secondAuthorization=(await request('/api/agent/payments/'+secondId+'/authorization',undefined,{asAgent:true})).json.paymentPayload;
  await request('/api/agent/payments/'+secondId,{}, {asAgent:true,status:202,headers:{'PAYMENT-SIGNATURE':Buffer.from(JSON.stringify(secondAuthorization)).toString('base64')}});
  assert.equal((await executePayment(db,secondId,runtime)).state,'submitted');await client.request({method:'anvil_mine',params:['0x5']});
  const secondSettled=await executePayment(db,secondId,runtime);assert.equal(secondSettled.state,'confirmed');
  const totals=(await db.query("SELECT sum(amount_minor)::text AS amount FROM intents WHERE account_id=$1 AND state='confirmed'",[login.json.id])).rows[0];assert.equal(totals.amount,'1200');
  assert.equal((await client.readContract({...jpyc,functionName:'balanceOf',args:[payTo]}))-merchantBefore,parseEther('1200'));
  await request('/api/owner/approvals/'+approval.id+'/approve',{signature:ownerSignature},{status:403});
  passed.push('agent period-budget excess waits without broadcasting','wrong wallet cannot approve an exception','fresh owner proof permits exactly one 600 JPYC exception','shared usage includes approved excess','used exception cannot be authorized again');
  const fullToken=token;token=randomUUID()+randomUUID();
  const runId=randomUUID();
  await db.query("INSERT INTO agent_runs(id,account_id,connection_id,mandate_id,client_request_id,token_hash,message,status,expires_at) VALUES($1,$2,$3,$4,$5,$6,'scope test','running',now()+interval '5 minutes')",[runId,login.json.id,connection.id,mandate.id,randomUUID(),sha256(token)]);
  const visible=(await request('/api/agent/tasks',undefined,{asAgent:true})).json.tasks;
  assert.deepEqual(visible.map(t=>t.id),[mandate.id]);
  await request('/api/agent/payments/'+intentId,undefined,{asAgent:true});
  await request('/api/agent/payments/'+secondId,undefined,{asAgent:true,status:403});
  await request('/api/agent/payments/'+secondId+'/authorization',undefined,{asAgent:true,status:403});
  await request('/api/agent/present',{mandateId:secondMandate.id,checkoutId:secondCheckout.id},{asAgent:true,status:403});
  await db.query("UPDATE agent_runs SET expires_at=now()-interval '1 second' WHERE id=$1",[runId]);
  await request('/api/agent/tasks',undefined,{asAgent:true,status:401});token=fullToken;
  passed.push('Gemini task-scoped token cannot access another payment or presentation','expired Gemini run token is rejected');
  await writeFile(root+'docs/evidence/payment-pipeline.json',JSON.stringify({scope:'Local Anvil, official MetaMask contracts, test ERC20 and real PostgreSQL/AP2 HTTP authority. Production worker logic with random in-memory signing keys. No browser wallet or public Amoy purchase claim.',passed,transactionHash:settled.transactionHash,gate:manifest.gate},null,2)+'\n');
  console.log(JSON.stringify({passed:passed.length,evidence:'docs/evidence/payment-pipeline.json'}));
 }finally{authority.kill('SIGTERM');await db.end();await rm(keydir,{recursive:true,force:true});}
}
