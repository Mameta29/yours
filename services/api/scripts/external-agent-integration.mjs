import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {toHex,maxUint256,parseEther,encodePacked} from 'viem';
import {encodeDelegations,delegationTypedData,externalPaymentTypedData} from '@yours/wallet-sdk';
import {verifyCheckout} from '@yours/ucp';
import {executePayment} from '../../worker/dist/settlement.js';

export async function externalAgentIntegration({root,db,request,send,client,owner,manifest,runtime,productId,signer,passed}){
 const agent=privateKeyToAccount(generatePrivateKey());
 const holder=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const publicJwk={...holder.publicKey.export({format:'jwk'}),kid:'external-holder',alg:'ES256'};
 const privateJwk={...holder.privateKey.export({format:'jwk'}),kid:'external-holder',alg:'ES256'};
 const before=(await request('/api/owner/me')).json;
 assert.equal(before.usage.accountSpent,parseEther('1200').toString());
 const {json:connection}=await request('/api/owner/connections',{provider:'external',name:'Independent AI',agentAddress:agent.address,ap2PublicJwk:publicJwk},{status:201});
 const agentRequest=(path,body,options={})=>request(path,body,{...options,asAgent:true,headers:{...options.headers,Authorization:'Bearer '+connection.agentToken}});
 const {json:draft}=await request(`/api/owner/permissions/connections/${connection.id}/prepare`,{perOrder:1000,perPeriod:4000,globalPerOrder:2000,globalPerPeriod:2000,days:7,merchants:['yours-lab']},{status:201});
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
}
