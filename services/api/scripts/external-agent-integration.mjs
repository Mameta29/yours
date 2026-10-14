import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {toHex,maxUint256,parseEther,encodePacked} from 'viem';
import {encodeDelegations,delegationTypedData,externalPaymentTypedData} from '@yours/wallet-sdk';
import {verifyCheckout} from '@yours/ucp';
import {executePayment} from '../../worker/dist/settlement.js';

export async function externalAgentIntegration({root,db,request,send,client,owner,manifest,runtime,productId,signer,fixture,passed}){
 const agentKey=generatePrivateKey(),agent=privateKeyToAccount(agentKey);
 const holder=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const publicJwk={...holder.publicKey.export({format:'jwk'}),kid:'external-holder',alg:'ES256'};
 const privateJwk={...holder.privateKey.export({format:'jwk'}),kid:'external-holder',alg:'ES256'};
 const before=(await request('/api/owner/me')).json;
 assert.equal(before.usage.accountSpent,parseEther('1200').toString());
 const {json:connection}=await request('/api/owner/connections',{provider:'external',name:'Independent AI',agentAddress:agent.address,ap2PublicJwk:publicJwk},{status:201});
 const agentRequest=(path,body,options={})=>request(path,body,{...options,asAgent:true,headers:{...options.headers,Authorization:'Bearer '+connection.agentToken}});
 async function configure(globalPerPeriod){
 const {json:draft}=await request(`/api/owner/permissions/connections/${connection.id}/prepare`,{perOrder:1000,perPeriod:4000,globalPerOrder:2000,globalPerPeriod,days:7,merchants:['yours-lab']},{status:201});
 const e=draft.expectation;
 const parent={delegate:agent.address,delegator:owner.address,authority:toHex(maxUint256,{size:32}),salt:toHex(7n),signature:'0x',caveats:[
  {enforcer:manifest.enforcers.periodic,terms:encodePacked(['address','uint256','uint256','uint256'],[manifest.jpyc,maxUint256,maxUint256,BigInt(e.startTime)]),args:'0x'},
  {enforcer:manifest.enforcers.redeemer,terms:manifest.gate,args:'0x'},
  {enforcer:manifest.enforcers.timestamp,terms:encodePacked(['uint128','uint128'],[0n,BigInt(e.expiry)]),args:'0x'},
  {enforcer:manifest.enforcers.value,terms:toHex(0n,{size:32}),args:'0x'},
  {enforcer:manifest.enforcers.nonce,terms:toHex(0n,{size:32}),args:'0x'},
 ]};parent.signature=await owner.signTypedData(delegationTypedData(31337,manifest.manager,parent));
 const base='/api/owner/permissions/drafts/'+draft.id;
 const terms=(await request(base+'/parents',{context:encodeDelegations([parent])})).json.typedData;
 const calls=(await request(base+'/transactions',{policy:await owner.signTypedData(terms.policy),permission:await owner.signTypedData(terms.permission)})).json.calls;
 const policy=await send(calls[0]),permission=await send(calls[1]);await client.request({method:'anvil_mine',params:['0x5']});
 await request(base+'/activate',{policy,permission});
 }
 await configure(2000);
 const updated=(await request('/api/owner/me')).json;
 assert.equal(updated.usage.accountSpent,before.usage.accountSpent);assert.equal(updated.policy.document.periodStart,before.policy.document.periodStart);
 assert.equal(updated.connections.filter(c=>c.status==='active').length,2);
 const isolatedRuntime={...runtime,signers:{...runtime.signers,agent:{...runtime.signers.agent,signTypedData:()=>{throw new Error('Hosted agent must not sign for an external AI');}}}};
 async function checkout(){
  const {json:task}=await request('/api/owner/tasks/prepare',{connectionId:connection.id,merchantId:'yours-lab',items:[{id:productId,quantity:1}],maxAmount:650},{status:201});
  const {json:mandate}=await request('/api/owner/tasks/'+task.id+'/approve',{signature:await owner.signTypedData(task.typedData)});
  const {json:checkout}=await agentRequest('/ucp/checkout-sessions',{line_items:[{item:{id:productId},quantity:1}]},{status:201,headers:{'Idempotency-Key':randomUUID()}});
  await verifyCheckout(checkout,[signer.publicJwk]);
  const {json:opens}=await agentRequest('/api/agent/present',{mandateId:mandate.id,checkoutId:checkout.id});
  assert.ok(opens.open_checkout);assert.equal(opens.mandates,undefined);
  // Client-side P-256 key is fed only to a separate SDK process through stdin;
  // neither the API nor the HSM holder ever sees that private key.
  const presentation=JSON.parse(execFileSync('uv',['run','python',root+'examples/external-agent/present.py'],{cwd:root+'services/mandates',env:{...process.env,UV_CACHE_DIR:root+'.local/uv-cache'},input:JSON.stringify({...opens,private_jwk:privateJwk,checkout,expiresAt:Math.floor(Date.now()/1000)+600}),encoding:'utf8'}));
  const body={payment:{instruments:[{id:opens.instrumentId,handler_id:'yours-stablecoin',type:'stablecoin',selected:true,credential:{type:'yours_ap2',mandate_id:mandate.id}}]},ap2:presentation};
  const result=await agentRequest('/ucp/checkout-sessions/'+checkout.id+'/complete',body,{status:202,headers:{'Idempotency-Key':randomUUID(),'If-Match':'"1"'}});
  return result.json.yours.intent_id;
 }
 const id=await checkout();
 assert.equal((await executePayment(db,id,isolatedRuntime)).state,'agent_signature_required');
 const {json:{signingRequest}}=await agentRequest('/api/agent/payments/'+id+'/authorization');
 const binding={chainId:31337,gate:manifest.gate,manager:manifest.manager,owner:owner.address,agent:agent.address,token:manifest.jpyc,payTo:runtime.payTo,amount:parseEther('600'),enforcers:manifest.enforcers};
 assert.throws(()=>externalPaymentTypedData(signingRequest.envelope,{...binding,amount:1n}),/payment_binding_mismatch/);
 const typed=externalPaymentTypedData(signingRequest.envelope,binding);
 const proof={challenge:signingRequest.challenge,leaf:await agent.signTypedData(typed.leaf),intent:await agent.signTypedData(typed.intent)};
 const unsigned=(await db.query('SELECT payload FROM payment_envelopes WHERE intent_id=$1',[id])).rows[0].payload;
 await agentRequest('/api/agent/payments/'+id,{}, {status:409,headers:{'PAYMENT-SIGNATURE':Buffer.from(JSON.stringify(unsigned)).toString('base64')}});
 await agentRequest('/api/agent/payments/'+id+'/authorization',{...proof,leaf:await owner.signTypedData(typed.leaf)},{status:401});
 await agentRequest('/api/agent/payments/'+id+'/authorization',{...proof,challenge:'0'.repeat(64)},{status:409});
 const authorized=(await agentRequest('/api/agent/payments/'+id+'/authorization',proof)).json;
 assert.deepEqual((await agentRequest('/api/agent/payments/'+id+'/authorization',proof)).json,authorized);
 assert.equal((await executePayment(db,id,isolatedRuntime)).state,'payment_required');
 await agentRequest('/api/agent/payments/'+id,{}, {status:202,headers:{'PAYMENT-SIGNATURE':Buffer.from(JSON.stringify(authorized.paymentPayload)).toString('base64')}});
 assert.equal((await executePayment(db,id,isolatedRuntime)).state,'submitted');
 await client.request({method:'anvil_mine',params:['0x5']});
 assert.equal((await executePayment(db,id,isolatedRuntime)).state,'confirmed');
 assert.equal((await request('/api/owner/me')).json.usage.accountSpent,parseEther('1800').toString());
 assert.equal(await client.readContract({address:manifest.jpyc,abi:[{type:'function',name:'balanceOf',stateMutability:'view',inputs:[{name:'who',type:'address'}],outputs:[{type:'uint256'}]}],functionName:'balanceOf',args:[agent.address]}),0n);
 const blocked=await checkout();
 assert.equal((await executePayment(db,blocked,isolatedRuntime)).state,'approval_required');
 const held=(await db.query('SELECT reasons FROM intents WHERE id=$1',[blocked])).rows[0];assert.deepEqual(held.reasons,['period_budget']);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM signed_transactions WHERE intent_id=$1',[blocked])).rows[0].n,0);
 passed.push('second AI registration preserves shared spent and period anchor','external holder presents AP2 with the official SDK','external EVM agent signs its own delegation and intent','wrong signer and changed challenge rejected','unsigned external payload cannot be accepted','agent signatures are idempotent','external AI completes a real ERC-7710 transfer without hosted-agent signing','both AIs share the same onchain spending budget','external AI holds no token balance');

 // Exercise the published CLI itself over real HTTP, including its own
 // checkout, official AP2 presentation and EVM signing. Only test AI keys are
 // written to this temporary directory; owner keys remain in memory.
 await configure(3000);
 assert.equal((await request('/api/owner/me')).json.usage.accountSpent,parseEther('1800').toString());
 const {json:cliTask}=await request('/api/owner/tasks/prepare',{connectionId:connection.id,merchantId:'yours-lab',items:[{id:productId,quantity:1}],maxAmount:650},{status:201});
 const {json:cliMandate}=await request('/api/owner/tasks/'+cliTask.id+'/approve',{signature:await owner.signTypedData(cliTask.typedData)});
 const directory=root+'.local/external-cli-'+randomUUID();await mkdir(directory,{mode:0o700});
 const keyFile=directory+'/keys.json';await writeFile(keyFile,JSON.stringify({evm:agentKey,ap2:privateJwk}),{mode:0o600,flag:'wx'});
 let pumping=true,pumpError;
 const pump=(async()=>{try{while(pumping){
  const {rows}=await db.query("SELECT id FROM intents WHERE connection_id=$1 AND state IN ('authorized','signing','submitted') ORDER BY created_at",[connection.id]);
  for(const row of rows)await executePayment(db,row.id,isolatedRuntime);
  await client.request({method:'anvil_mine',params:['0x1','0x0']});
  await new Promise(resolve=>setTimeout(resolve,250));
 }}catch(error){pumpError=error;}})();
 const runCli=(mandateId=cliMandate.id)=>new Promise((resolve,reject)=>{
  const child=spawn('node',[root+'examples/external-agent/client.mjs','run',mandateId],{cwd:root,env:{...process.env,NODE_ENV:'test',YOURS_LOCAL_TEST:'1',YOURS_ORIGIN:runtime.origin,YOURS_AGENT_KEY_FILE:keyFile,YOURS_AGENT_TOKEN:connection.agentToken},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk.toString();});child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-4000);});
  const timeout=setTimeout(()=>child.kill('SIGTERM'),120000);
  child.on('error',error=>{clearTimeout(timeout);reject(error);});
  child.on('close',code=>{clearTimeout(timeout);if(code!==0){reject(new Error('External client failed: '+stderr));return;}try{resolve(JSON.parse(stdout));}catch(error){reject(error);}});
 });
 try{
  const paid=await runCli();assert.equal(paid.state,'confirmed');
  const replay=await runCli();assert.equal(replay.payment.transaction,paid.payment.transaction);
  const consumed=(await db.query('SELECT intent_id FROM mandate_consumptions WHERE mandate_id=$1',[cliMandate.id])).rows[0];
  assert.equal((await db.query('SELECT count(*)::int AS n FROM signed_transactions WHERE intent_id=$1',[consumed.intent_id])).rows[0].n,1);
  assert.equal((await request('/api/owner/me')).json.usage.accountSpent,parseEther('2400').toString());
  assert.equal((await request('/api/owner/me')).json.policy.document.periodStart,before.policy.document.periodStart);
  const ecTask=(await request('/api/owner/tasks/prepare',{requestId:randomUUID(),connectionId:connection.id,merchantId:fixture.merchant.id,items:[{id:fixture.merchant.id+'/'+fixture.productId,quantity:1}],email:'buyer@example.test',maxAmount:800,minutes:60},{status:201})).json;
  const ecMandate=(await request('/api/owner/tasks/'+ecTask.id+'/approve',{signature:await owner.signTypedData(ecTask.typedData),transferSignature:await owner.signMessage({message:ecTask.transferAuthorization.message})})).json;
  const ecResult=await runCli(ecMandate.id);assert.equal(ecResult.state,'approval_required');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM signed_transactions WHERE intent_id=$1',[ecResult.intentId])).rows[0].n,0);
  passed.push('published external client verifies a prepared EC checkout and stops for missing owner permission');
  if(pumpError)throw pumpError;
  passed.push('published external client creates and verifies its own UCP checkout over HTTP','external client presents AP2 and signs its own payment with zero hosted-key use','external client retry reconciles one transaction','owner budget update preserves shared spent and period anchor');
 }finally{pumping=false;await pump;await rm(directory,{recursive:true,force:true});}
}
