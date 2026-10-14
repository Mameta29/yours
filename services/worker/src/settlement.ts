import {randomBytes,randomUUID} from 'node:crypto';
import {encodeFunctionData,keccak256,stringToHex,zeroHash,parseEventLogs,type Address,type Hex,type PublicClient,type LocalAccount} from 'viem';
import {DomainError,digest as snapshotDigest} from '@yours/domain';
import {claimTransaction,saveSignedTransaction,markBroadcast,recordChainReceipt,transaction,audit,enqueue,type Db,type Tx} from '@yours/storage';
import {yoursPurchaseGateAbi,decodeDelegations,validateParents,verifyParentSignatures,buildPaymentLeaf,delegationTypedData,hashDelegation,encodeDelegations,gateDomain,gateTypes,digest,structHash,requirementsHash,basketCommitment,evidenceDigest,emptyFunding,emptyPrice,emptyApproval,type ExecutionEnvelope,type Enforcers} from '@yours/wallet-sdk';
import {validateSchema,UCP_VERSION} from '@yours/ucp';
import {paymentPayload,parseEnvelope} from '@yours/wallet-sdk';

export interface SettlementRuntime {
 client:PublicClient;chainId:number;gate:Address;manager:Address;token:Address;enforcers:Enforcers;
 merchantId:string;payTo:Address;origin:string;
 signers:Record<'relayer'|'agent'|'merchant'|'risk',LocalAccount>;
 verifyIntent:(id:string)=>Promise<{transaction_id:string;expires_at:number}>;
 endorseIntent?:(id:string)=>Promise<{human:unknown;signature:Hex}>;
}
const safe=(value:unknown)=>JSON.parse(JSON.stringify(value,(_k,v)=>typeof v==='bigint'?v.toString():v));
const args=(e:ExecutionEnvelope)=>[e.order,e.funding,e.intent,e.paymentContext,e.fundingContext,e.risk,e.price,e.human,e.signatures,e.route] as const;
async function loadIntent(db:Db,id:string){
 const {rows:[row]}=await db.query(`SELECT i.*,a.address,c.agent_address,c.status AS connection_status,p.document AS policy,p.revision AS policy_revision,g.context,g.document AS grant FROM intents i JOIN accounts a ON a.id=i.account_id JOIN connections c ON c.id=i.connection_id JOIN policies p ON p.account_id=i.account_id JOIN wallet_grants g ON g.connection_id=i.connection_id AND g.token_address=p.token_address WHERE i.id=$1`,[id]);
 if(!row)throw new DomainError('payment_not_found',404);return row;
}
async function prepareEnvelope(db:Db,id:string,r:SettlementRuntime){
 const row=await loadIntent(db,id),now=Math.floor(Date.now()/1000);
 if(!['authorized','approval_required'].includes(row.state)||row.connection_status!=='active')throw new DomainError('intent_not_authorized',409);
 if(new Date(row.expires_at).getTime()<=Date.now())throw new DomainError('payment_expired',409);
 if(snapshotDigest(row.snapshot)!==row.snapshot_hash)throw new DomainError('snapshot_changed',409);
 const verified=await r.verifyIntent(id);
 if(verified.expires_at<=now)throw new DomainError('mandate_expired',409);
 const checkout=row.snapshot.checkout,amount=BigInt(row.amount_atomic),policy=row.policy.chainPolicy;
 if(row.merchant_id!==r.merchantId||checkout.yours.pay_to.toLowerCase()!==r.payTo.toLowerCase()||checkout.yours.asset.toLowerCase()!==r.token.toLowerCase()||row.agent_address!==r.signers.agent.address.toLowerCase())throw new DomainError('unsupported_payment_binding',422);
 for(const [role,field] of [['merchant','merchantSigner'],['risk','riskSigner']] as const)if(policy[field].toLowerCase()!==r.signers[role].address.toLowerCase())throw new DomainError('signer_binding_changed',409);
 const expiry=BigInt(Math.min(now+120,verified.expires_at,Math.floor(new Date(row.expires_at).getTime()/1000)));
 const e={...row.grant.expectation,expiry:BigInt(row.grant.expectation.expiry),startTime:BigInt(row.grant.expectation.startTime)};
 const {parents}=validateParents(row.context,e);await verifyParentSignatures(r.client,parents,e);
 const leaf=buildPaymentLeaf(parents,{agent:r.signers.agent.address,gate:r.gate,token:r.token,enforcers:r.enforcers},amount,r.payTo,expiry,BigInt('0x'+randomBytes(32).toString('hex')));
 leaf.signature=await r.signers.agent.signTypedData(delegationTypedData(r.chainId,r.manager,leaf));
 const order={orderId:keccak256(stringToHex(id)),revisionId:keccak256(stringToHex(row.revision+':'+row.snapshot_hash)),policyId:policy.policyId,policyVersion:BigInt(row.policy_revision),periodIndex:BigInt(row.period_index),account:row.address,agent:r.signers.agent.address,shopIdHash:keccak256(stringToHex(row.merchant_id)),payTo:r.payTo,settlementToken:r.token,settlementAmount:amount,basketCommitment:basketCommitment(checkout,('0x'+randomBytes(32).toString('hex')) as Hex),fundingHash:structHash('Funding',emptyFunding),requirementsHash:requirementsHash(r.chainId,r.gate,{settlementToken:r.token,payTo:r.payTo,settlementAmount:amount}),validUntil:expiry};
 const domain=gateDomain(r.chainId,r.gate),orderHash=digest(domain,'PurchaseOrder',order);
 const intent={orderHash,paymentLeafHash:hashDelegation(leaf),fundingLeafHash:zeroHash,validUntil:expiry},intentHash=digest(domain,'ExecutionIntent',intent);
 const risk={intentHash,riskDigest:evidenceDigest({snapshotHash:row.snapshot_hash,ap2Transaction:verified.transaction_id,policyVersion:row.policy_revision,merchant:row.merchant_id,payTo:r.payTo,token:r.token,rules:'verified-ap2-and-enrolled-merchant-v1'}),rulesHash:policy.riskRulesHash,reasonMask:0,checkedAt:BigInt(now),validUntil:BigInt(Math.min(now+60,Number(expiry)))};
 const signatures={merchant:await r.signers.merchant.signTypedData({domain,types:gateTypes,primaryType:'PurchaseOrder',message:order}),agent:await r.signers.agent.signTypedData({domain,types:gateTypes,primaryType:'ExecutionIntent',message:intent}),risk:await r.signers.risk.signTypedData({domain,types:gateTypes,primaryType:'RiskStamp',message:risk}),price:'0x' as Hex,human:'0x' as Hex};
 const envelope:ExecutionEnvelope={order,funding:emptyFunding,intent,paymentContext:encodeDelegations([leaf,...parents]),fundingContext:'0x',risk,price:emptyPrice,human:emptyApproval,signatures,route:'0x'};
 return envelope;
}
async function transactionTerms(db:Db,id:string,r:SettlementRuntime,envelope:ExecutionEnvelope){
 const verified=await r.verifyIntent(id),now=Math.floor(Date.now()/1000);
 if(verified.expires_at<=now||envelope.order.validUntil<=now)throw new DomainError('mandate_expired',409);
 // A human or an agent can spend time inspecting the quote. Keep the order and
 // risk digest immutable, refreshing only the short-lived risk attestation.
 envelope.risk={...envelope.risk,checkedAt:BigInt(now),validUntil:BigInt(Math.min(now+60,Number(envelope.order.validUntil)))};
 envelope.signatures.risk=await r.signers.risk.signTypedData({domain:gateDomain(r.chainId,r.gate),types:gateTypes,primaryType:'RiskStamp',message:envelope.risk});
 const {rows:[row]}=await db.query('SELECT reasons FROM intents WHERE id=$1',[id]);
 if(row.reasons.length){
  if(!r.endorseIntent)throw new DomainError('owner_endorsement_unavailable',503);
  const endorsement=await r.endorseIntent(id);
  envelope=parseEnvelope({...safe(envelope),human:endorsement.human,signatures:{...envelope.signatures,human:endorsement.signature}});
 }
 await r.client.simulateContract({address:r.gate,abi:yoursPurchaseGateAbi,functionName:'executePurchase',args:args(envelope),account:r.signers.relayer.address});
 const data=encodeFunctionData({abi:yoursPurchaseGateAbi,functionName:'executePurchase',args:args(envelope)});
 const gas=await r.client.estimateGas({account:r.signers.relayer.address,to:r.gate,data});
 if(gas>2_000_000n)throw new DomainError('gas_limit_exceeded',422);
 const fees=await r.client.estimateFeesPerGas({type:'eip1559',chain:null});
 if(fees.maxFeePerGas>2_000_000_000_000n)throw new DomainError('gas_price_exceeded',503);
 return safe({to:r.gate,data,value:0n,gas:gas*12n/10n,maxFeePerGas:fees.maxFeePerGas*2n,maxPriorityFeePerGas:fees.maxPriorityFeePerGas,envelope});
}
/** Every retry uses the same persisted nonce and exact signed bytes. */
export async function executePayment(db:Db,id:string,r:SettlementRuntime){
 let {rows:[journal]}=await db.query('SELECT * FROM signed_transactions WHERE intent_id=$1',[id]);
 if(!journal){
  const row=await loadIntent(db,id);
  if(['failed','canceled'].includes(row.state)){await releaseUnpaid(db,id);return {state:row.state};}
  if(new Date(row.expires_at).getTime()<=Date.now()){
   await transaction(db,async tx=>{await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[row.account_id]);await tx.query("UPDATE intents SET state='failed',updated_at=now() WHERE id=$1 AND state IN ('authorized','approval_required')",[id]);await audit(tx,row.account_id,'worker','payment.expired',id);});
   await releaseUnpaid(db,id);return {state:'failed'};
  }
  let {rows:[prepared]}=await db.query('SELECT * FROM payment_envelopes WHERE intent_id=$1',[id]);
  if(!prepared){
   const envelope=await prepareEnvelope(db,id,r);
   const payload=paymentPayload(envelope,r.chainId,r.gate,r.manager,r.origin+'/api/agent/payments/'+id,keccak256(stringToHex(id)));
   await db.query('INSERT INTO payment_envelopes(intent_id,envelope,payload,payload_hash) VALUES($1,$2,$3,$4) ON CONFLICT(intent_id) DO NOTHING',[id,JSON.stringify(safe(envelope)),JSON.stringify(payload),snapshotDigest(payload)]);
   ({rows:[prepared]}=await db.query('SELECT * FROM payment_envelopes WHERE intent_id=$1',[id]));
  }
  if(row.state==='approval_required')return {state:'approval_required'};
  if(!prepared.accepted_at)return {state:'payment_required'};
  const unsigned=await transactionTerms(db,id,r,parseEnvelope(prepared.envelope));
  journal=await claimTransaction(db,{intentId:id,chainId:r.chainId,signer:r.signers.relayer.address,pendingNonce:await r.client.getTransactionCount({address:r.signers.relayer.address,blockTag:'pending'}),unsigned});
 }else if(!journal.raw_transaction){
  journal=await claimTransaction(db,{intentId:id,chainId:r.chainId,signer:r.signers.relayer.address,pendingNonce:0,unsigned:{}});
 }
 if(!journal.raw_transaction){
  const p=journal.unsigned_payload;
  const raw=await r.signers.relayer.signTransaction({type:'eip1559',chainId:journal.chain_id,nonce:Number(journal.nonce),to:p.to,data:p.data,value:BigInt(p.value),gas:BigInt(p.gas),maxFeePerGas:BigInt(p.maxFeePerGas),maxPriorityFeePerGas:BigInt(p.maxPriorityFeePerGas)});
  await saveSignedTransaction(db,journal,raw,keccak256(raw));
  journal={...journal,raw_transaction:raw,transaction_hash:keccak256(raw),state:'signed'};
 }
 const hash=journal.transaction_hash as Hex;
 let receipt;
 try{receipt=await r.client.getTransactionReceipt({hash});}catch(error){if((error as Error).name!=='TransactionReceiptNotFoundError')throw error;}
 if(!receipt){
  // A lost send response is ambiguous. Re-read/rebroadcast this exact hash only.
  try{const sent=await r.client.sendRawTransaction({serializedTransaction:journal.raw_transaction});if(sent!==hash)throw new Error('broadcast_hash_mismatch');}
  catch(error){try{await r.client.getTransaction({hash});}catch{throw error;}}
  await markBroadcast(db,journal.id);return {state:'submitted',transactionHash:hash};
 }
 const height=await r.client.getBlockNumber({cacheTime:0});
 if(height-receipt.blockNumber+1n<5n)return {state:'confirming',transactionHash:hash};
 if((await r.client.getBlock({blockNumber:receipt.blockNumber})).hash!==receipt.blockHash)throw new DomainError('receipt_reorg',409);
 const tx=await r.client.getTransaction({hash});
 if(tx.chainId!==r.chainId||tx.from.toLowerCase()!==r.signers.relayer.address.toLowerCase()||receipt.to?.toLowerCase()!==r.gate.toLowerCase()||tx.input.toLowerCase()!==journal.unsigned_payload.data.toLowerCase())throw new DomainError('receipt_binding_mismatch',409);
 if(receipt.status==='success'){
  const expected=journal.unsigned_payload.envelope;
  const events=parseEventLogs({abi:yoursPurchaseGateAbi,eventName:'PurchasePaid',logs:receipt.logs.filter(l=>l.address.toLowerCase()===r.gate.toLowerCase()),strict:true});
  const event=events[0]?.args;
  if(events.length!==1||!event||event.orderId!==expected.order.orderId||event.orderHash!==expected.intent.orderHash||event.account.toLowerCase()!==expected.order.account.toLowerCase()||event.payTo.toLowerCase()!==r.payTo.toLowerCase()||event.settlementAmount!==BigInt(expected.order.settlementAmount))throw new DomainError('payment_event_mismatch',409);
 }
 await recordChainReceipt(db,journal.id,{transactionHash:hash,blockNumber:receipt.blockNumber.toString(),blockHash:receipt.blockHash,status:receipt.status,gasUsed:receipt.gasUsed.toString()},receipt.status==='success',async(tx,intent)=>{
  if(receipt.status==='success')await createOrder(tx,intent,r);
  else await releaseSession(tx,intent);
 });
 return {state:receipt.status==='success'?'confirmed':'failed',transactionHash:hash};
}
async function createOrder(tx:Tx,intent:any,r:SettlementRuntime){
 const {rows:[session]}=await tx.query('SELECT * FROM merchant_sessions WHERE id=$1 FOR UPDATE',[intent.checkout_id]);
 if(!session||session.actor!=='agent:'+intent.connection_id||session.status!=='complete_in_progress')throw new DomainError('settlement_session_mismatch',409);
 const doc=intent.snapshot.checkout,id=randomUUID();
 const {rows:holds}=await tx.query('SELECT * FROM inventory_reservations WHERE session_id=$1 AND released_at IS NULL ORDER BY product_id',[session.id]);
 if(holds.length!==doc.line_items.length)throw new DomainError('inventory_reservation_missing',409);
 for(const hold of holds){const {rowCount}=await tx.query('UPDATE merchant_products SET stock=stock-$3 WHERE merchant_id=$1 AND id=$2 AND stock>=$3',[hold.merchant_id,hold.product_id,hold.quantity]);if(rowCount!==1)throw new DomainError('inventory_reconciliation_required',409);}
 await tx.query('UPDATE inventory_reservations SET released_at=now() WHERE session_id=$1',[session.id]);
 const order={ucp:{version:UCP_VERSION,capabilities:{'dev.ucp.shopping.order':[{version:UCP_VERSION}]}},id,checkout_id:session.id,permalink_url:r.origin+'/orders/'+id,line_items:doc.line_items.map((line:any)=>({...line,quantity:{original:line.quantity,total:line.quantity,fulfilled:0},status:'processing'})),fulfillment:{expectations:[],events:[]},currency:doc.currency,totals:doc.totals,yours:{network:'eip155:'+r.chainId,transaction_hash:intent.transaction_hash,intent_id:intent.id}};
 validateSchema('shopping/order.json',order);
 await tx.query('INSERT INTO merchant_orders(id,session_id,document,transaction_hash) VALUES($1,$2,$3,$4)',[id,session.id,JSON.stringify(order),intent.transaction_hash]);
 const checkout={...session.document,status:'completed',order:{id,permalink_url:order.permalink_url},yours:{...session.document.yours,revision:session.revision+1,payment_status:'confirmed',transaction_hash:intent.transaction_hash}};
 delete checkout.ap2;
 await tx.query("UPDATE merchant_sessions SET status='completed',revision=revision+1,document=$2,updated_at=now() WHERE id=$1",[session.id,JSON.stringify(checkout)]);
 await enqueue(tx,'order.webhook','order-created:'+id,{intentId:intent.id,eventId:'order-created:'+id,occurredAt:Math.floor(Date.now()/1000),platformProfile:session.platform_profile,document:order});
 await enqueue(tx,'order.receipts','receipts:'+intent.id,{intentId:intent.id});
 await audit(tx,intent.account_id,'worker','order.created',id,{intentId:intent.id,transactionHash:intent.transaction_hash});
}
async function releaseSession(tx:Tx,intent:any){
 const {rows:[session]}=await tx.query('SELECT * FROM merchant_sessions WHERE id=$1 FOR UPDATE',[intent.checkout_id]);if(!session||session.status!=='complete_in_progress')return;
 const document={...session.document,status:'canceled',yours:{...session.document.yours,revision:session.revision+1,payment_status:intent.state}};delete document.ap2;
 await tx.query("UPDATE merchant_sessions SET status='canceled',revision=revision+1,document=$2,updated_at=now() WHERE id=$1",[session.id,JSON.stringify(document)]);
 await tx.query('UPDATE inventory_reservations SET released_at=now() WHERE session_id=$1',[session.id]);
}
export async function releaseUnpaid(db:Db,id:string){return transaction(db,async tx=>{const {rows:[intent]}=await tx.query("SELECT * FROM intents WHERE id=$1 AND state IN ('failed','canceled')",[id]);if(intent)await releaseSession(tx,intent);});}
