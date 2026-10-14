// Actual browser -> API -> EIP-712 -> local chain. The EIP-1193 provider is a
// disposable in-process test signer, not a claim about a wallet extension.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {serve} from '@hono/node-server';
import {serveStatic} from '@hono/node-server/serve-static';
import {createPublicClient,createWalletClient,http,toHex,parseEther,encodeFunctionData,encodeAbiParameters,parseAbi} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {foundry} from 'viem/chains';
import {createDb,migrate} from '@yours/storage';
import {createApp} from '../dist/app.js';
import {readConfig} from '../dist/config.js';
import {chainRuntime} from '../dist/chain.js';

const rpc='http://127.0.0.1:18812',origin='http://localhost:18816';
const client=createPublicClient({chain:foundry,transport:http(rpc)});
assert.equal(await client.getChainId(),31337);
assert.match(await client.request({method:'web3_clientVersion'}),/anvil/i);
const m=JSON.parse(await readFile('.local/local-chain.json','utf8'));
const owner=privateKeyToAccount(generatePrivateKey());
await client.request({method:'anvil_setBalance',params:[owner.address,toHex(parseEther('10'))]});
const wallet=createWalletClient({account:owner,chain:foundry,transport:http(rpc)});
assert.equal(await client.getCode({address:owner.address}),undefined);
const db=createDb('postgresql://localhost/yours_test');await migrate(db);
const config=readConfig({NODE_ENV:'test',DATABASE_URL:'postgresql://localhost/yours_test',PUBLIC_ORIGIN:origin,PORT:'18816',CHAIN_ID:'31337',RPC_URL:rpc,GATE_ADDRESS:m.gate,JPYC_ADDRESS:m.jpyc,AGENT_ADDRESS:m.addresses.agent,MERCHANT_ID:randomUUID(),MERCHANT_PAY_TO:m.addresses.merchant,MANDATES_URL:'http://127.0.0.1:18813'});
const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const signer={kid:'browser-test',publicJwk:{...pair.publicKey.export({format:'jwk'}),kid:'browser-test',alg:'ES256',use:'sig'},sign:async data=>new Uint8Array(sign('sha256',data,{key:pair.privateKey,dsaEncoding:'ieee-p1363'}))};
const app=createApp(db,config,signer,chainRuntime(config,m));
app.use('/*',serveStatic({root:'apps/console/dist'}));app.get('*',serveStatic({path:'apps/console/dist/index.html'}));
const server=serve({fetch:app.fetch,port:18816,hostname:'127.0.0.1'});
const mine=setInterval(()=>void client.request({method:'anvil_mine',params:['0x1']}),800);
let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1100}});page.setDefaultTimeout(30000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let rejectSecond=true,loseUpgradeStatus=true,upgradeHash,upgradeRequests=0;
 let visibleAccounts=true,selectedOwner=owner,rejectLogin=false,accountRequests=0,loginSignatures=0;
 const transactions=[];
 await page.exposeFunction('yoursTestProvider',async({method,params=[]})=>{
  if(method==='eth_requestAccounts'){accountRequests++;visibleAccounts=true;return [selectedOwner.address];}
  if(method==='eth_accounts')return visibleAccounts?[selectedOwner.address]:[];
  if(method==='eth_chainId')return toHex(31337);
  if(method==='wallet_getCapabilities')return {[toHex(31337)]:{atomic:{status:'ready'}}};
  if(method==='wallet_sendCalls'){
   const batch=params[0];
   assert.equal(batch.from.toLowerCase(),owner.address.toLowerCase());assert.equal(batch.chainId,toHex(31337));assert.equal(batch.atomicRequired,true);
   assert.deepEqual(batch.calls,[{to:owner.address.toLowerCase(),value:'0x0',data:'0x'},{to:owner.address.toLowerCase(),value:'0x0',data:'0x'}]);
   const upgrade=await owner.signAuthorization({contractAddress:m.accountImplementation,chainId:31337,nonce:await client.getTransactionCount({address:owner.address})+1});
   const data=encodeFunctionData({abi:parseAbi(['function execute(bytes32 mode,bytes executionCalldata) payable']),functionName:'execute',args:['0x01'+'00'.repeat(31),encodeAbiParameters([{type:'tuple[]',components:[{name:'target',type:'address'},{name:'value',type:'uint256'},{name:'callData',type:'bytes'}]}],[batch.calls.map(call=>({target:call.to,value:0n,callData:call.data}))])]});
   upgradeHash=await wallet.sendTransaction({to:owner.address,authorizationList:[upgrade],data,gas:200000n});upgradeRequests++;
   assert.equal((await client.waitForTransactionReceipt({hash:upgradeHash})).status,'success');
   return {id:upgradeHash};
  }
  if(method==='wallet_getCallsStatus'){
   assert.equal(params[0],upgradeHash);
   if(loseUpgradeStatus){loseUpgradeStatus=false;throw new Error('Lost wallet status response');}
   return {id:upgradeHash,version:'2.0.0',chainId:toHex(31337),status:200,atomic:true,receipts:[{transactionHash:upgradeHash,status:'0x1'}]};
  }
  if(method==='personal_sign'){
   if(rejectLogin){rejectLogin=false;throw new Error('User rejected request');}
   loginSignatures++;return selectedOwner.signMessage({message:{raw:params[0]}});
  }
  if(method==='eth_signTypedData_v4'){assert.equal(params[0].toLowerCase(),owner.address.toLowerCase());return owner.signTypedData(JSON.parse(params[1]));}
  if(method==='eth_sendTransaction'){
   const tx=params[0];assert.equal(tx.from.toLowerCase(),owner.address.toLowerCase());
   assert.ok([m.gate,m.registry].some(to=>to.toLowerCase()===tx.to.toLowerCase()));
   if(tx.to.toLowerCase()===m.registry.toLowerCase()&&rejectSecond){rejectSecond=false;throw new Error('User rejected request');}
   const hash=await wallet.sendTransaction({to:tx.to,data:tx.data,value:BigInt(tx.value??0)});
   transactions.push({to:tx.to,hash});return hash;
  }
  throw new Error('unsupported_test_method:'+method);
 });
 await page.addInitScript(()=>{
  const listeners=new Map();
  window.ethereum={request:args=>window.yoursTestProvider(args),on(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeListener(name,fn){listeners.get(name)?.delete(fn);}};
  window.yoursTestWalletEvent=(name,value)=>{for(const fn of listeners.get(name)??[])fn(value);};
 });
 const login=async()=>{await page.locator('.wallet-button').click();await page.getByRole('button',{name:'ブラウザのウォレット',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);};
 await page.goto(origin);await login();
 await page.getByRole('button',{name:'AIを追加する',exact:true}).first().click();
 await page.getByRole('button',{name:'登録して権限を設定'}).click();
 await page.getByLabel('この条件で購入を任せることを確認しました').check();
 await page.getByRole('button',{name:'ウォレットで承認する'}).click();
 await expect(page.getByRole('dialog')).toContainText('MetaMaskでウォレット設定を続行できませんでした。',{timeout:60000});
 await page.getByRole('dialog').getByText('エラーの詳細',{exact:true}).click();
 await expect(page.getByRole('dialog').locator('pre')).toContainText('wallet_getCallsStatus');
 await expect(page.getByRole('dialog').locator('pre')).toContainText('Lost wallet status response');
 assert.equal(upgradeRequests,1);assert.equal(transactions.length,0);
 // A valid SIWE cookie survives reload, but a locked wallet needs reconnection.
 // Reconnecting must return to the form, not silently finish on the home page.
 visibleAccounts=false;await page.reload();
 await page.getByRole('button',{name:'権限を設定',exact:true}).first().click();
 await page.getByLabel(/このAI：1回の上限/).fill('1700');
 await page.getByLabel(/このAI：24時間の上限/).fill('4900');
 await page.getByLabel('この条件で購入を任せることを確認しました').check();
 await page.getByRole('button',{name:'ウォレットで承認する'}).click();
 await expect(page.getByRole('heading',{name:'あなたのウォレットを接続'})).toBeVisible();
 rejectLogin=true;
 await page.getByRole('button',{name:'ブラウザのウォレット',exact:true}).click();
 await expect(page.getByRole('dialog')).toContainText('ウォレットでの操作をキャンセルしました。');
 await page.getByRole('button',{name:'ブラウザのウォレット',exact:true}).click();
 await expect(page.getByRole('heading',{name:'My Geminiに任せる範囲'})).toBeVisible({timeout:5000});
 await expect(page.getByLabel(/このAI：1回の上限/)).toHaveValue('1700');
 await expect(page.getByLabel(/このAI：24時間の上限/)).toHaveValue('4900');
 await expect(page.getByLabel('この条件で購入を任せることを確認しました')).not.toBeChecked();
 assert.equal(transactions.length,0);assert.equal(upgradeRequests,1);
 await page.getByLabel('この条件で購入を任せることを確認しました').check();
 await page.getByRole('button',{name:'ウォレットで承認する'}).click();
 await expect(page.getByRole('dialog')).toContainText('ウォレットでの操作をキャンセルしました。',{timeout:60000});
 assert.equal(transactions.length,1);assert.equal(upgradeRequests,1);
 assert.equal((await client.getCode({address:owner.address})).toLowerCase(),'0xef0100'+m.accountImplementation.slice(2).toLowerCase());
 // A different account must never inherit the original owner's pending action.
 visibleAccounts=false;await page.reload();
 await page.getByRole('button',{name:'登録を再開',exact:true}).first().click();
 await page.getByLabel('この条件で購入を任せることを確認しました').check();
 await page.getByRole('button',{name:'残りの登録を進める'}).click();
 await expect(page.getByRole('heading',{name:'あなたのウォレットを接続'})).toBeVisible();
 selectedOwner=privateKeyToAccount(generatePrivateKey());
 await page.getByRole('button',{name:'ブラウザのウォレット',exact:true}).click();
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect(page.getByRole('alert')).toContainText('別のウォレットに接続しました');
 await expect.poll(async()=>page.evaluate(()=>fetch('/api/owner/me').then(r=>r.json()).then(me=>me.account.address.toLowerCase()))).toBe(selectedOwner.address.toLowerCase());
 assert.equal(transactions.length,1);assert.equal(upgradeRequests,1);
 // Return to the owner, then verify passive account restoration after reload:
 // no new wallet-connect request or login signature is required.
 selectedOwner=owner;await login();
 const requestsBeforeReload=accountRequests,signaturesBeforeReload=loginSignatures;
 await page.reload();
 await page.getByRole('button',{name:'登録を再開',exact:true}).first().click();
 await expect(page.getByRole('dialog')).toContainText('前回確認した条件で登録を再開');
 await page.getByLabel('この条件で購入を任せることを確認しました').check();
 await page.getByRole('button',{name:'残りの登録を進める'}).click();
 await expect(page.getByRole('dialog')).toHaveCount(0,{timeout:60000});
 await expect(page.getByRole('alert')).toContainText('購入権限を登録しました');
 assert.equal(transactions.length,2);assert.equal(transactions[0].to.toLowerCase(),m.gate.toLowerCase());assert.equal(transactions[1].to.toLowerCase(),m.registry.toLowerCase());
 assert.equal(accountRequests,requestsBeforeReload);assert.equal(loginSignatures,signaturesBeforeReload);
 assert.deepEqual(errors,[]);
 const state=await page.evaluate(()=>fetch('/api/owner/me').then(r=>r.json()));
 assert.equal(state.connections[0].status,'active');assert.equal(state.connections[0].pending_draft,null);
 await page.screenshot({path:'.local/console-permission-active.png',fullPage:true});
 await page.evaluate(({owner,chain})=>{window.yoursTestWalletEvent('accountsChanged',[owner]);window.yoursTestWalletEvent('chainChanged',chain);},{owner:owner.address,chain:toHex(31337)});
 assert.equal(await page.evaluate(()=>fetch('/api/owner/me').then(r=>r.status)),200);
 await page.getByRole('button',{name:'権限を編集',exact:true}).first().click();
 selectedOwner=privateKeyToAccount(generatePrivateKey());
 await page.evaluate(account=>window.yoursTestWalletEvent('accountsChanged',[account]),selectedOwner.address);
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect.poll(()=>page.evaluate(()=>fetch('/api/owner/me').then(r=>r.status))).toBe(401);
 assert.equal(transactions.length,2);
 assert.deepEqual(errors,[]);
 const evidence={scope:'Headless Chrome with a disposable EIP-1193 test provider. Real EIP-7702 owner upgrade, EIP-712 signatures, real HTTP API/PostgreSQL and official MetaMask contracts on local Anvil. No wallet-extension or public Amoy claim.',passed:['browser SIWE login','ordinary EOA initiates EIP-5792 upgrade from the permission button','two zero-value self calls apply the pinned EIP-7702 implementation','interrupted upgrade status survives reload without a second batch','wallet errors show the failing method and provider reason','wallet reconnect cancellation preserves the pending form','same-owner reconnect restores edited limits without sending a transaction','reconnected owner explicitly reviews conditions before registration','different-wallet login discards the previous owner action without sending','reload passively restores an authorized account without new login signatures','actual policy transaction succeeds','second wallet transaction intentionally canceled','reloaded page restores the same permission conditions','only the missing registry transaction is sent','five confirmations activate the AI','same account and chain notifications keep the session','account change closes the pending form and logs out without sending','no JavaScript errors'],upgradeTransaction:upgradeHash,transactions};
 await writeFile('docs/evidence/browser-permissions.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({passed:evidence.passed.length,evidence:'docs/evidence/browser-permissions.json'}));
}finally{clearInterval(mine);await browser?.close();await new Promise(resolve=>server.close(resolve));await db.end();}
