// Run after the SDK's local integration. No public RPC and no exported keys.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {generateKeyPairSync,sign} from 'node:crypto';
import {createPublicClient,createWalletClient,http,parseEther,toHex,encodePacked,maxUint256} from 'viem';
import {foundry} from 'viem/chains';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {createDb,migrate} from '@yours/storage';
import {encodeDelegations,delegationTypedData} from '@yours/wallet-sdk';
import {createApp} from '../dist/app.js';
import {readConfig} from '../dist/config.js';
import {chainRuntime} from '../dist/chain.js';

const root=new URL('../../../',import.meta.url);
const m=JSON.parse(await readFile(new URL('.local/local-chain.json',root),'utf8'));
const rpc='http://127.0.0.1:18812';
const client=createPublicClient({chain:foundry,transport:http(rpc)});
assert.equal(await client.getChainId(),31337);assert.match(await client.request({method:'web3_clientVersion'}),/anvil/i);
const owner=privateKeyToAccount(generatePrivateKey()),relayer=privateKeyToAccount(generatePrivateKey()),agent=privateKeyToAccount(generatePrivateKey());
await client.request({method:'anvil_setBalance',params:[relayer.address,toHex(parseEther('10'))]});
const wallet=createWalletClient({account:relayer,chain:foundry,transport:http(rpc)});
const authorization=await owner.signAuthorization({contractAddress:m.accountImplementation,chainId:31337,nonce:0});
await client.waitForTransactionReceipt({hash:await wallet.sendTransaction({to:owner.address,data:'0x',authorizationList:[authorization],gas:150000n})});
const db=createDb(process.env.TEST_DATABASE_URL??'postgresql://localhost/yours_test');await migrate(db);
const config=readConfig({NODE_ENV:'test',DATABASE_URL:'postgresql://localhost/yours_test',PUBLIC_ORIGIN:'http://localhost:8080',RPC_URL:rpc,CHAIN_ID:'31337',MERCHANT_PAY_TO:'0x0000000000000000000000000000000000000100',GATE_ADDRESS:m.gate});
const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const signer={kid:'merchant',publicJwk:{...pair.publicKey.export({format:'jwk'}),kid:'merchant',alg:'ES256',use:'sig'},sign:async data=>new Uint8Array(sign('sha256',data,{key:pair.privateKey,dsaEncoding:'ieee-p1363'}))};
const app=createApp(db,config,signer,chainRuntime(config,m));
let cookie='';
async function request(path,body,expected=200){
 const response=await app.request(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Origin:config.PUBLIC_ORIGIN,...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const json=await response.json();assert.equal(response.status,expected,JSON.stringify(json));
 return {response,json};
}
try{
 const {json:challenge}=await request('/api/auth/challenge',{address:owner.address});
 const login=await request('/api/auth/verify',{nonce:challenge.nonce,signature:await owner.signMessage({message:challenge.message})});
 cookie=login.response.headers.get('set-cookie').split(';')[0];
 const {json:connection}=await request('/api/owner/connections',{provider:'external',name:'Integration agent',agentAddress:agent.address},201);
 const {json:prepared}=await request(`/api/owner/permissions/connections/${connection.id}/prepare`,{perOrder:1000,perPeriod:2000,globalPerOrder:3000,globalPerPeriod:5000,days:7,merchants:['yours-lab']},201);
 const e=prepared.expectation;
 const parent={delegate:agent.address,delegator:owner.address,authority:toHex(maxUint256,{size:32}),salt:toHex(1n),signature:'0x',caveats:[
  {enforcer:m.enforcers.periodic,terms:encodePacked(['address','uint256','uint256','uint256'],[m.jpyc,maxUint256,maxUint256,BigInt(e.startTime)]),args:'0x'},
  {enforcer:m.enforcers.redeemer,terms:m.gate,args:'0x'},
  {enforcer:m.enforcers.timestamp,terms:encodePacked(['uint128','uint128'],[0n,BigInt(e.expiry)]),args:'0x'},
  {enforcer:m.enforcers.value,terms:toHex(0n,{size:32}),args:'0x'},
  {enforcer:m.enforcers.nonce,terms:toHex(0n,{size:32}),args:'0x'},
 ]};
 parent.signature=await owner.signTypedData(delegationTypedData(31337,m.manager,parent));
 const base='/api/owner/permissions/drafts/'+prepared.id;
 const {json:terms}=await request(base+'/parents',{context:encodeDelegations([parent])});
 const bad=await agent.signTypedData(terms.typedData.policy);
 await request(base+'/transactions',{policy:bad,permission:await owner.signTypedData(terms.typedData.permission)},401);
 const signatures={policy:await owner.signTypedData(terms.typedData.policy),permission:await owner.signTypedData(terms.typedData.permission)};
 const {json:transactions}=await request(base+'/transactions',signatures);
 assert.equal((await request('/api/owner/me')).json.connections[0].status,'pending');
 const hashes=[];
 for(const call of transactions.calls){const hash=await wallet.sendTransaction(call);assert.equal((await client.waitForTransactionReceipt({hash})).status,'success');hashes.push(hash);}
 await request(base+'/activate',{policy:hashes[0],permission:hashes[1]},409);
 await client.request({method:'anvil_mine',params:['0x5']});
 await request(base+'/activate',{policy:hashes[0],permission:hashes[1]});
 await request(base+'/activate',{policy:hashes[0],permission:hashes[1]});
 const active=(await request('/api/owner/me')).json;
 assert.equal(active.connections[0].status,'active');assert.equal(active.policy.document.perPeriod,parseEther('5000').toString());
 const {json:revocation}=await request(`/api/owner/permissions/connections/${connection.id}/revoke/prepare`,{});
 assert.equal((await request('/api/owner/me')).json.connections[0].status,'paused');
 const {json:revokeCall}=await request(`/api/owner/permissions/connections/${connection.id}/revoke/transaction`,{nonce:revocation.typedData.message.nonce,deadline:revocation.typedData.message.deadline,signature:await owner.signTypedData(revocation.typedData)});
 const hash=await wallet.sendTransaction(revokeCall);assert.equal((await client.waitForTransactionReceipt({hash})).status,'success');await client.request({method:'anvil_mine',params:['0x5']});
 await request(`/api/owner/permissions/connections/${connection.id}/revoke/confirm`,{transactionHash:hash});
 assert.equal((await request('/api/owner/me')).json.connections[0].permission_status,'revoked');
 const evidence={scope:'Local Anvil and real PostgreSQL. Actual owner signatures, official MetaMask delegation, policy/permission registration and revocation through the API. No browser-extension or public Amoy claim.',passed:['SIWE owner login','owner-signed restricted delegation','wrong policy signer rejected','no activation from signatures alone','five confirmations required','exact registration calls verified','idempotent activation','immediate API pause','confirmed onchain revocation'],policyTransaction:hashes[0],permissionTransaction:hashes[1],revocationTransaction:hash};
 await writeFile(new URL('docs/evidence/permissions-api.json',root),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({passed:evidence.passed.length,evidence:'docs/evidence/permissions-api.json'}));
}finally{await db.end();}
