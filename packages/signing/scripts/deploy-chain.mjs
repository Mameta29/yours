// Explicit Amoy-only deployment using a non-exportable Google Cloud HSM key.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,open} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash,verify as verifyCrypto,createPublicKey} from 'node:crypto';
import {OAuth2Client} from 'google-auth-library';
import {KeyManagementServiceClient} from '@google-cloud/kms';
import {createPublicClient,createWalletClient,http,keccak256,encodeDeployData,parseEther,formatEther,recoverMessageAddress,parseTransaction,recoverTransactionAddress} from 'viem';
import {polygonAmoy} from 'viem/chains';
import {KmsEvmSigner,kmsP256Signer} from '../dist/index.js';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const project=process.env.PROJECT_ID??'yours-511602';
assert.equal(project,'yours-511602','This deployment is isolated to the user-selected project');
const region='asia-northeast1';
const key=name=>`projects/${project}/locations/${region}/keyRings/yours/cryptoKeys/${name}/cryptoKeyVersions/1`;
// Captured in process memory only. Production services use attached identities.
const access=execFileSync('gcloud',['auth','print-access-token','--project='+project],{encoding:'utf8'}).trim();
const authClient=new OAuth2Client();authClient.setCredentials({access_token:access});
const kms=new KeyManagementServiceClient({authClient});
const rpc=process.env.AMOY_RPC_URL??'https://polygon-amoy-bor-rpc.publicnode.com';
assert.equal(new URL(rpc).protocol,'https:');
const client=createPublicClient({chain:polygonAmoy,transport:http(rpc,{timeout:20000,retryCount:1})});
assert.equal(await client.getChainId(),80002);
const infra=JSON.parse(await readFile(root+'deployments/amoy-infrastructure.json','utf8'));
const block=await client.getBlock();
for(const pin of infra.contracts){
 const code=await client.getCode({address:pin.address,blockNumber:block.number});
 assert(code&&code!=='0x','Missing deployed infrastructure');
 assert.equal(keccak256(code),pin.codeHash,'Infrastructure code changed: '+pin.address);
}
for(const pin of infra.proxyImplementations){
 const storage=await client.getStorageAt({address:pin.proxy,slot:pin.slot,blockNumber:block.number});
 assert.equal('0x'+storage.slice(-40),pin.implementation.toLowerCase(),'Proxy implementation changed');
 assert.equal(keccak256(await client.getCode({address:pin.implementation,blockNumber:block.number})),pin.codeHash);
}
const signers={};
for(const name of ['relayer','merchant','risk','human','price','agent'])signers[name]=await KmsEvmSigner.create(key(name),kms);
const relayer=signers.relayer.account();
const addresses=Object.fromEntries(Object.entries(signers).map(([name,signer])=>[name,signer.address]));
console.log(JSON.stringify({chainId:80002,project,addresses,balancePOL:formatEther(await client.getBalance({address:relayer.address})),verifiedInfrastructureBlock:block.number.toString()}));
const message='yours Cloud HSM signing verification on Polygon Amoy';
const signature=await relayer.signMessage({message});
assert.equal((await recoverMessageAddress({message,signature})).toLowerCase(),relayer.address.toLowerCase());
const merchant=await kmsP256Signer(key('ucp-merchant'),'ucp-merchant',kms);
const payload=new TextEncoder().encode(message);
assert(verifyCrypto('sha256',payload,{key:createPublicKey({key:merchant.publicJwk,format:'jwk'}),dsaEncoding:'ieee-p1363'},await merchant.sign(payload)));
await mkdir(root+'docs/evidence',{recursive:true});
await writeFile(root+'docs/evidence/cloud-kms.json',JSON.stringify({project,region,checkedAt:new Date().toISOString(),secp256k1:{address:relayer.address,recoveryVerified:true},p256:{publicJwk:merchant.publicJwk,signatureVerified:true},addresses,scope:'Actual HSM signatures; no private-key export. This file alone does not prove settlement.'},null,2)+'\n');
if(!process.argv.includes('--deploy')){console.log('HSM and infrastructure verification passed. Use --deploy for the testnet deployment.');process.exit(0);}

const artifact=JSON.parse(await readFile(root+'packages/contracts/out/YoursPurchaseGate.sol/YoursPurchaseGate.json','utf8'));
const args=[infra.manager,infra.jpyc,infra.usdc,infra.accountImplementation,infra.router,infra.factory,['periodic','redeemer','timestamp','value','nonce','transferAmount','calldata'].map(name=>infra.enforcers[name])];
const data=encodeDeployData({abi:artifact.abi,bytecode:artifact.bytecode.object,args});
const artifactHash=keccak256(data),journalPath=root+'.local/amoy-deploy-journal.json';
let journal;
try{journal=JSON.parse(await readFile(journalPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
if(journal){
 assert.equal(journal.artifactHash,artifactHash,'Deployment artifact changed after signing');
 assert.equal(journal.sender.toLowerCase(),relayer.address.toLowerCase());
}else{
 const wallet=createWalletClient({account:relayer,chain:polygonAmoy,transport:http(rpc)});
 const request=await wallet.prepareTransactionRequest({data,value:0n});
 assert.equal(request.type,'eip1559');
 const maximumCost=request.gas*request.maxFeePerGas;
 assert(maximumCost<=parseEther('1'),'Deployment exceeds the one-POL testnet gas cap');
 assert(await client.getBalance({address:relayer.address})>=maximumCost,'Insufficient testnet POL');
 const raw=await relayer.signTransaction(request);
 journal={artifactHash,sender:relayer.address,raw,hash:keccak256(raw),createdAt:new Date().toISOString()};
 await mkdir(root+'.local',{recursive:true,mode:0o700});
 const file=await open(journalPath,'wx',0o600);
 try{await file.writeFile(JSON.stringify(journal));await file.sync();}finally{await file.close();}
}
assert.equal(keccak256(journal.raw),journal.hash);
assert.equal((await recoverTransactionAddress({serializedTransaction:journal.raw})).toLowerCase(),relayer.address.toLowerCase());
const signed=parseTransaction(journal.raw);
assert.equal(signed.chainId,80002);assert.equal(signed.data,data);assert(!signed.to);assert.equal(signed.value??0n,0n);
let receipt=await client.getTransactionReceipt({hash:journal.hash}).catch(()=>null);
if(!receipt){
 try{await client.sendRawTransaction({serializedTransaction:journal.raw});}catch(error){
  // On an ambiguous RPC response, reconcile this hash. Never sign a second tx.
  console.log(JSON.stringify({event:'broadcast_reconcile',hash:journal.hash,error:error.name}));
 }
 console.log(JSON.stringify({event:'awaiting_deployment',hash:journal.hash}));
 receipt=await client.waitForTransactionReceipt({hash:journal.hash,confirmations:5,timeout:120000,pollingInterval:3000});
}
assert.equal(receipt.status,'success');assert(receipt.contractAddress);
assert.equal((await client.getBlock({blockNumber:receipt.blockNumber})).hash,receipt.blockHash);
const gate={address:receipt.contractAddress,abi:artifact.abi};
const registry=await client.readContract({...gate,functionName:'agentPermissions'});
const validator=await client.readContract({...gate,functionName:'validator'});
const adapter=await client.readContract({...gate,functionName:'fundingAdapter'});
assert.equal((await client.readContract({...gate,functionName:'settlementToken'})).toLowerCase(),infra.jpyc.toLowerCase());
assert.equal((await client.readContract({...gate,functionName:'accountImplementation'})).toLowerCase(),infra.accountImplementation.toLowerCase());
const pins=await Promise.all([gate.address,registry,validator,adapter].map(async address=>({address,codeHash:keccak256(await client.getCode({address}))})));
const manifest={...infra,gate:gate.address,registry,validator,adapter,addresses,merchantPublicJwk:merchant.publicJwk,deploymentTransaction:receipt.transactionHash,deploymentBlock:receipt.blockNumber.toString(),deploymentBlockHash:receipt.blockHash,creationCodeHash:artifactHash,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),contracts:[...infra.contracts,...pins]};
await writeFile(root+'deployments/amoy.json',JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({event:'deployed',gate:gate.address,registry,transactionHash:receipt.transactionHash,blockNumber:receipt.blockNumber.toString()}));
