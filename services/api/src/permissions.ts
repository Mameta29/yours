import {randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import {z} from 'zod';
import {encodeFunctionData,keccak256,stringToHex,zeroHash,type Address,type Hex} from 'viem';
import {DomainError,minorToAtomic,permissionSchema,digest} from '@yours/domain';
import {transaction,audit,pauseConnection,type Db,type Tx} from '@yours/storage';
import {gateDomain,gateTypes,structHash,merchantSetHash,assetLimitsHash,relayerSetHash,grantsHash,agentPermissionDomain,agentPermissionTypes,validateParents,verifyParentSignatures,isExpected7702Code,type Policy,type GrantExpectation} from '@yours/wallet-sdk';
import {owner,type Env} from './auth.js';
import {confirmedCall,jsonSafe,tokenAbi,type ChainRuntime} from './chain.js';
import type {Config} from './config.js';

const signature=z.string().regex(/^0x[0-9a-fA-F]{130}$/);
const txHash=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const setting=z.object({perOrder:z.number().int().nonnegative().safe(),perPeriod:z.number().int().nonnegative().safe(),
 globalPerOrder:z.number().int().nonnegative().safe(),globalPerPeriod:z.number().int().nonnegative().safe(),
 days:z.number().int().min(1).max(30).default(7),merchants:z.array(z.string()).max(64)}).strict();
const uint=(minor:number)=>minor===0?'0':minorToAtomic(minor,'JPY',18);
const bytes32=(value:string)=>keccak256(stringToHex(value));
const revive=<T>(type:keyof typeof gateTypes,value:any):T=>Object.fromEntries(gateTypes[type].map(field=>[field.name,field.type.startsWith('uint')?(field.type==='uint32'?Number(value[field.name]):BigInt(value[field.name])):value[field.name]])) as T;
const asExpectation=(value:any):GrantExpectation=>({...value,startTime:BigInt(value.startTime),expiry:BigInt(value.expiry)});
const asPermission=(value:any)=>({...value,revision:BigInt(value.revision),validUntil:BigInt(value.validUntil),perOrder:BigInt(value.perOrder),perPeriod:BigInt(value.perPeriod)});

async function draft(db:Pick<Db,'query'>|Tx,id:string,accountId:string,allowExpired=false){
 const {rows:[row]}=await db.query('SELECT * FROM permission_drafts WHERE id=$1 AND account_id=$2',[id,accountId]);
 if(!row)throw new DomainError('permission_draft_not_found',404);
 if(!allowExpired&&!row.completed_at&&new Date(row.expires_at).getTime()<=Date.now())throw new DomainError('permission_draft_expired',409);
 return row;
}
async function saveDraft(db:Db,row:any,document:any){
 const {rowCount}=await db.query('UPDATE permission_drafts SET document=$2 WHERE id=$1 AND document=$3::jsonb AND completed_at IS NULL',[row.id,JSON.stringify(document),JSON.stringify(row.document)]);
 if(rowCount!==1)throw new DomainError('permission_draft_changed',409);
}

export function permissionRoutes(db:Db,config:Config,chain:ChainRuntime){
 const router=new Hono<Env>(),{client,manifest:m,gate,registry}=chain;
 router.get('/wallet',async c=>{
  const actor=owner(c);
  const [code,balance,policy]=await Promise.all([client.getCode({address:actor.address as Address}),client.readContract({address:m.jpyc,abi:tokenAbi,functionName:'balanceOf',args:[actor.address as Address]}),client.readContract({...gate,functionName:'policy',args:[actor.address as Address]})]);
  return c.json(jsonSafe({chainId:m.chainId,balance,decimals:18,currency:'JPY',smartAccountReady:isExpected7702Code(code,m.accountImplementation),accountImplementation:m.accountImplementation,policy,manifest:m}));
 });
 router.post('/connections/:id/prepare',async c=>{
  const actor=owner(c),connectionId=z.string().uuid().parse(c.req.param('id')),input=setting.parse(await c.req.json());
  if(!config.MERCHANT_PAY_TO||input.merchants.some(id=>id!==config.MERCHANT_ID)||new Set(input.merchants).size!==input.merchants.length)throw new DomainError('merchant_not_enrolled',422);
  const [block,onchain,nonce,registryNonce,decimals]=await Promise.all([
   client.getBlock(),client.readContract({...gate,functionName:'policy',args:[actor.address as Address]}),
   client.readContract({...gate,functionName:'ownerNonce',args:[actor.address as Address]}),client.readContract({...registry,functionName:'nonces',args:[actor.address as Address]}),
   client.readContract({address:m.jpyc,abi:tokenAbi,functionName:'decimals'}),
  ]);
  if(decimals!==18)throw new DomainError('settlement_token_decimals_mismatch',503);
  const prepared=await transaction(db,async tx=>{
   await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[actor.accountId]);
   const {rows:[connection]}=await tx.query('SELECT * FROM connections WHERE id=$1 AND account_id=$2',[connectionId,actor.accountId]);
   if(!connection||connection.status==='revoked')throw new DomainError('connection_not_found',404);
   const {rows:[storedPolicy]}=await tx.query('SELECT * FROM policies WHERE account_id=$1',[actor.accountId]);
   if(onchain.policyId!==zeroHash&&(!storedPolicy||storedPolicy.policy_id!==onchain.policyId||storedPolicy.revision!==Number(onchain.version)))throw new DomainError('policy_reconciliation_required',409);
   const {rows:[oldPermission]}=await tx.query('SELECT revision FROM permissions WHERE connection_id=$1',[connectionId]);
   const chainPermission=await client.readContract({...registry,functionName:'permissions',args:[actor.address as Address,bytes32(connectionId)]});
   if(Number(chainPermission[3])!==(oldPermission?.revision??0))throw new DomainError('permission_reconciliation_required',409);
   const now=Number(block.timestamp),validUntil=storedPolicy&&Number(onchain.validUntil)>now+600?Number(onchain.validUntil):now+input.days*86400;
   if(validUntil<=now+600)throw new DomainError('global_permission_renewal_required',409);
   const permission=permissionSchema.parse({connectionId,revision:(oldPermission?.revision??0)+1,perOrder:uint(input.perOrder),perPeriod:uint(input.perPeriod),validUntil,
    merchants:input.merchants.map(id=>({id,origin:config.PUBLIC_ORIGIN,payTo:config.MERCHANT_PAY_TO}))});
   const {rows:others}=await tx.query("SELECT c.agent_address,w.* FROM wallet_grants w JOIN connections c ON c.id=w.connection_id WHERE c.account_id=$1 AND c.id<>$2 AND c.status<>'revoked' ORDER BY c.agent_address,w.token_address",[actor.accountId,connectionId]);
   if(others.some(row=>Number(row.valid_until)<validUntil))throw new DomainError('existing_grant_expires_earlier',409);
   const {rows:otherPermissions}=await tx.query("SELECT p.document FROM permissions p JOIN connections c ON c.id=p.connection_id WHERE c.account_id=$1 AND c.id<>$2 AND c.status<>'revoked'",[actor.accountId,connectionId]);
   const merchantMap=new Map<string,{shopIdHash:Hex;payTo:Address}>();
   for(const merchant of [...permission.merchants,...otherPermissions.flatMap(row=>row.document.merchants)]){
    const entry={shopIdHash:bytes32(merchant.id),payTo:merchant.payTo as Address};merchantMap.set(entry.shopIdHash+entry.payTo.toLowerCase(),entry);
   }
   const merchants=[...merchantMap.values()].sort((a,b)=>a.shopIdHash===b.shopIdHash?(BigInt(a.payTo)<BigInt(b.payTo)?-1:1):BigInt(a.shopIdHash)<BigInt(b.shopIdHash)?-1:1);
   const id=randomUUID(),policyId=storedPolicy?.policy_id??bytes32(`yours:${m.chainId}:${actor.address}`),version=BigInt(onchain.version)+1n;
   const expectation:GrantExpectation={chainId:m.chainId,manager:m.manager,owner:actor.address as Address,agent:connection.agent_address,token:m.jpyc,gate:m.gate,expiry:BigInt(validUntil),startTime:BigInt(now),enforcers:m.enforcers,funding:false};
   const document=jsonSafe({input,expectation,permission,merchants,controlRevision:connection.control_revision,otherGrants:others.map(row=>({...row.document.binding,policyVersion:version})),
    policy:{account:actor.address,policyId,version,validAfter:now,validUntil,periodStart:storedPolicy?onchain.periodStart:now,periodSeconds:storedPolicy?onchain.periodSeconds:86400,
     autoPerOrderJpyc:uint(input.globalPerOrder),autoPerPeriodJpyc:uint(input.globalPerPeriod),merchantSetHash:merchantSetHash(merchants),assetLimitsHash:assetLimitsHash([]),riskRulesHash:bytes32('yours-policy-and-ap2-v1'),identityBindingId:bytes32(`yours-owner:${m.chainId}:${actor.address}`),relayerSetHash:relayerSetHash([m.addresses.relayer]),autoMaxPremiumBps:0,humanOverrideMask:7,merchantSigner:m.addresses.merchant,riskSigner:m.addresses.risk,humanSigner:m.addresses.human,priceSigner:m.addresses.price},
    nonce,registryNonce,deadline:now+600,kind:storedPolicy?'updatePolicy':'registerPolicy'});
   await tx.query('INSERT INTO permission_drafts(id,account_id,connection_id,document,expires_at) VALUES($1,$2,$3,$4,to_timestamp($5))',[id,actor.accountId,connectionId,JSON.stringify(document),now+600]);
   return {id,expectation:document.expectation,permission:document.permission,sharedBudget:{perOrder:input.globalPerOrder,perPeriod:input.globalPerPeriod,periodSeconds:document.policy.periodSeconds,validUntil},gate:m.gate};
  });return c.json(prepared,201);
 });
 router.post('/drafts/:id/parents',async c=>{
  const actor=owner(c),id=z.string().uuid().parse(c.req.param('id'));
  const {context}=z.object({context:z.string().regex(/^0x[0-9a-fA-F]+$/).max(16386)}).strict().parse(await c.req.json());
  const row=await draft(db,id,actor.accountId),d=row.document,e=asExpectation(d.expectation);
  if(row.completed_at||d.calls)throw new DomainError('permission_draft_already_signed',409);
  const validated=validateParents(context as Hex,e);await verifyParentSignatures(client,validated.parents,e);
  if(!isExpected7702Code(await client.getCode({address:e.owner}),m.accountImplementation))throw new DomainError('wallet_upgrade_required',409);
  const policy=revive<Policy>('Policy',d.policy);
  const binding={policyId:policy.policyId,policyVersion:policy.version,agent:e.agent,token:e.token,grantChainHash:validated.grantChainHash,validUntil:e.expiry};
  const grants=[...d.otherGrants.map((g:any)=>revive<any>('GrantBinding',g)),binding].sort((a,b)=>a.agent.toLowerCase()===b.agent.toLowerCase()?(BigInt(a.token)<BigInt(b.token)?-1:1):BigInt(a.agent)<BigInt(b.agent)?-1:1);
  const merchants=d.permission.merchants.map((merchant:any)=>({shopIdHash:bytes32(merchant.id),payTo:merchant.payTo})).sort((a:any,b:any)=>BigInt(a.shopIdHash)<BigInt(b.shopIdHash)?-1:1);
  const p={account:e.owner,policyId:policy.policyId,connectionId:bytes32(row.connection_id),revision:BigInt(d.permission.revision),agent:e.agent,validUntil:e.expiry,perOrder:BigInt(d.permission.perOrder),perPeriod:BigInt(d.permission.perPeriod),merchantsHash:merchantSetHash(merchants)};
  const typedData=jsonSafe({policy:{domain:gateDomain(m.chainId,m.gate),types:{PolicyRegistration:gateTypes.PolicyRegistration},primaryType:'PolicyRegistration',message:{policyHash:structHash('Policy',policy),grantsHash:grantsHash(grants),nonce:BigInt(d.nonce),validUntil:BigInt(d.deadline)}},
   permission:{domain:agentPermissionDomain(m.chainId,m.registry),types:{AgentPermission:agentPermissionTypes.AgentPermission},primaryType:'AgentPermission',message:{...p,nonce:BigInt(d.registryNonce),deadline:BigInt(d.deadline)}}});
  await saveDraft(db,row,{...d,context,binding:jsonSafe(binding),grants:jsonSafe(grants),registryPermission:jsonSafe(p),registryMerchants:merchants,typedData});
  return c.json({id,typedData});
 });
 router.post('/drafts/:id/transactions',async c=>{
  const actor=owner(c),id=z.string().uuid().parse(c.req.param('id'));
  const signatures=z.object({policy:signature,permission:signature}).strict().parse(await c.req.json());
  const row=await draft(db,id,actor.accountId),d=row.document;
  if(!d.typedData||row.completed_at)throw new DomainError('permission_draft_not_signable',409);
  if(d.calls){if(digest(d.signatures)!==digest(signatures))throw new DomainError('permission_draft_already_signed',409);return c.json({id,chainId:m.chainId,calls:d.calls});}
  for(const type of ['policy','permission'] as const){
   if(!await client.verifyTypedData({...d.typedData[type],address:actor.address as Address,signature:signatures[type] as Hex}))throw new DomainError('owner_signature_invalid',401);
  }
  const policy=revive<Policy>('Policy',d.policy),grants=d.grants.map((g:any)=>revive<any>('GrantBinding',g));
  const calls=[{to:m.gate,data:encodeFunctionData({abi:gate.abi,functionName:d.kind,args:[policy,d.merchants,[],grants,[m.addresses.relayer],BigInt(d.nonce),BigInt(d.deadline),signatures.policy as Hex]})},
   {to:m.registry,data:encodeFunctionData({abi:registry.abi,functionName:'configure',args:[asPermission(d.registryPermission),d.registryMerchants,BigInt(d.registryNonce),BigInt(d.deadline),signatures.permission as Hex]})}];
  await saveDraft(db,row,{...d,signatures,calls});
  return c.json({id,chainId:m.chainId,calls});
 });
 router.post('/drafts/:id/activate',async c=>{
  const actor=owner(c),id=z.string().uuid().parse(c.req.param('id'));
  const hashes=z.object({policy:txHash,permission:txHash}).strict().parse(await c.req.json());
  const row=await draft(db,id,actor.accountId,true),d=row.document;
  if(!d.calls)throw new DomainError('permission_transactions_missing',409);
  await confirmedCall(chain,hashes.policy as Hex,d.calls[0].to,d.calls[0].data);
  await confirmedCall(chain,hashes.permission as Hex,d.calls[1].to,d.calls[1].data);
  const [current,active,permissionActive,currentPermission]=await Promise.all([
   client.readContract({...gate,functionName:'policy',args:[actor.address as Address]}),client.readContract({...gate,functionName:'active',args:[actor.address as Address]}),
   client.readContract({...registry,functionName:'active',args:[actor.address as Address,bytes32(row.connection_id)]}),client.readContract({...registry,functionName:'permissions',args:[actor.address as Address,bytes32(row.connection_id)]}),
  ]);
  if(!active||!permissionActive||current.policyId!==d.policy.policyId||current.version!==BigInt(d.policy.version)||currentPermission[3]!==BigInt(d.permission.revision))throw new DomainError('permission_no_longer_current',409);
  await transaction(db,async tx=>{
   await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[actor.accountId]);
   const latest=await draft(tx,id,actor.accountId,true);if(latest.completed_at)return;
   const {rows:[connection]}=await tx.query('SELECT control_revision FROM connections WHERE id=$1',[row.connection_id]);
   if(connection.control_revision!==d.controlRevision)throw new DomainError('permission_stopped_during_activation',409);
   if(digest(latest.document)!==digest(d))throw new DomainError('permission_draft_changed',409);
   const budget={perOrder:d.policy.autoPerOrderJpyc,perPeriod:d.policy.autoPerPeriodJpyc,periodStart:Number(d.policy.periodStart),periodSeconds:Number(d.policy.periodSeconds),validAfter:Number(d.policy.validAfter),validUntil:Number(d.policy.validUntil),status:'active',chainPolicy:d.policy};
   await tx.query(`INSERT INTO policies(account_id,policy_id,revision,gate_address,token_address,token_decimals,currency,document,activation_tx) VALUES($1,$2,$3,$4,$5,18,'JPY',$6,$7) ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision,document=excluded.document,activation_tx=excluded.activation_tx,updated_at=now()`,[actor.accountId,d.policy.policyId,Number(d.policy.version),m.gate.toLowerCase(),m.jpyc.toLowerCase(),JSON.stringify(budget),hashes.policy]);
   await tx.query(`INSERT INTO permissions(connection_id,revision,document,owner_signature,activation_tx,status) VALUES($1,$2,$3,$4,$5,'active') ON CONFLICT(connection_id) DO UPDATE SET revision=excluded.revision,document=excluded.document,owner_signature=excluded.owner_signature,activation_tx=excluded.activation_tx,status='active',updated_at=now()`,[row.connection_id,d.permission.revision,JSON.stringify(d.permission),d.signatures.permission,hashes.permission]);
   await tx.query(`INSERT INTO wallet_grants(connection_id,token_address,context,document,valid_after,valid_until) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(connection_id,token_address) DO UPDATE SET context=excluded.context,document=excluded.document,valid_after=excluded.valid_after,valid_until=excluded.valid_until,updated_at=now()`,[row.connection_id,m.jpyc.toLowerCase(),d.context,JSON.stringify({binding:d.binding,expectation:d.expectation}),d.expectation.startTime,d.expectation.expiry]);
   await tx.query("UPDATE connections SET status='active' WHERE id=$1",[row.connection_id]);
   await tx.query('UPDATE permission_drafts SET completed_at=now() WHERE id=$1',[id]);
   await audit(tx,actor.accountId,'owner:'+actor.accountId,'permission.activated',row.connection_id,{policyTransaction:hashes.policy,permissionTransaction:hashes.permission});
  });return c.json({id,connectionId:row.connection_id,status:'active'});
 });
 router.post('/connections/:id/revoke/prepare',async c=>{
  const actor=owner(c),connectionId=z.string().uuid().parse(c.req.param('id'));
  await pauseConnection(db,actor.accountId,connectionId);
  const nonce=await client.readContract({...registry,functionName:'nonces',args:[actor.address as Address]});
  const deadline=Number((await client.getBlock()).timestamp)+300;
  const typedData=jsonSafe({domain:agentPermissionDomain(m.chainId,m.registry),types:{RevokeAgent:agentPermissionTypes.RevokeAgent},primaryType:'RevokeAgent',message:{account:actor.address,connectionId:bytes32(connectionId),nonce,deadline}});
  return c.json({connectionId,typedData});
 });
 router.post('/connections/:id/revoke/transaction',async c=>{
  const actor=owner(c),connectionId=z.string().uuid().parse(c.req.param('id'));
  const request=z.object({nonce:z.string().regex(/^[0-9]+$/),deadline:z.number().int().positive().safe(),signature}).strict().parse(await c.req.json());
  const {rows:[connection]}=await db.query('SELECT status FROM connections WHERE id=$1 AND account_id=$2',[connectionId,actor.accountId]);
  if(!connection||connection.status!=='paused')throw new DomainError('connection_not_paused',409);
  const message={account:actor.address as Address,connectionId:bytes32(connectionId),nonce:BigInt(request.nonce),deadline:BigInt(request.deadline)};
  if(!await client.verifyTypedData({address:actor.address as Address,domain:agentPermissionDomain(m.chainId,m.registry),types:agentPermissionTypes,primaryType:'RevokeAgent',message,signature:request.signature as Hex}))throw new DomainError('owner_signature_invalid',401);
  return c.json({to:m.registry,data:encodeFunctionData({abi:registry.abi,functionName:'revoke',args:[message.account,message.connectionId,message.nonce,message.deadline,request.signature as Hex]})});
 });
 router.post('/connections/:id/revoke/confirm',async c=>{
  const actor=owner(c),connectionId=z.string().uuid().parse(c.req.param('id'));
  const request=z.object({transactionHash:txHash}).strict().parse(await c.req.json());
  const tx=await client.getTransaction({hash:request.transactionHash as Hex});
  const {decodeFunctionData}=await import('viem');
  const decoded=decodeFunctionData({abi:registry.abi,data:tx.input});
  if(decoded.functionName!=='revoke'||decoded.args[0].toLowerCase()!==actor.address.toLowerCase()||decoded.args[1]!==bytes32(connectionId))throw new DomainError('revocation_transaction_mismatch',422);
  await confirmedCall(chain,request.transactionHash as Hex,m.registry,tx.input);
  if(await client.readContract({...registry,functionName:'active',args:[actor.address as Address,bytes32(connectionId)]}))throw new DomainError('permission_still_active',409);
  await transaction(db,async tx=>{
   await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[actor.accountId]);
   const {rowCount}=await tx.query("UPDATE connections SET status='paused',control_revision=control_revision+1 WHERE id=$1 AND account_id=$2",[connectionId,actor.accountId]);
   if(!rowCount)throw new DomainError('connection_not_found',404);
   await tx.query("UPDATE permissions SET status='revoked',updated_at=now() WHERE connection_id=$1",[connectionId]);
   await audit(tx,actor.accountId,'owner:'+actor.accountId,'permission.revoked_onchain',connectionId,{transactionHash:request.transactionHash});
  });return c.json({connectionId,status:'paused',onchainRevoked:true});
 });
 return router;
}
