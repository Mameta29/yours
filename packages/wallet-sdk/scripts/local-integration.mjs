// Real EIP-7702 + official MetaMask contracts on a disposable loopback chain.
// Adapted from the attributed EC extraction; no fixture private keys are exported.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, encodePacked, encodeAbiParameters, encodeFunctionData, parseEther, toHex, zeroAddress, zeroHash, maxUint256, keccak256, stringToHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { signDelegation } from '@metamask/smart-accounts-kit';
import { gateTypes, gateDomain, digest, structHash, merchantSetHash, assetLimitsHash, relayerSetHash, grantsHash, parentChainHash, buildPaymentLeaf, encodeDelegations, hashDelegation, validateParents, emptyFunding, emptyPrice, emptyApproval, requirementsHash, agentPermissionTypes, agentPermissionDomain, agentPermissionRegistryAbi } from '../dist/index.js';

const pinnedFramework = 'bff4b08f8006ad94322a6e3da8d90f274e20325d';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const framework = process.env.FRAMEWORK_PATH ?? root + '.local/delegation-framework';
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: framework, encoding: 'utf8' }).trim(), pinnedFramework);
const rpc = process.env.LOCAL_RPC ?? 'http://127.0.0.1:18812';
assert.match(rpc, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
const chain = foundry, chainId = foundry.id;
const client = createPublicClient({ chain, transport: http(rpc) });
assert.equal(await client.getChainId(), chainId);
assert.match(await client.request({ method: 'web3_clientVersion' }), /anvil/i);
// Other lifecycle tests advance and revert time. Re-align this disposable
// chain before mixing wall-clock AP2 attestations with onchain expiry checks.
const wallClock=Math.floor(Date.now()/1000),head=await client.getBlock();
if(Number(head.timestamp)<wallClock){await client.request({method:'evm_setNextBlockTimestamp',params:[wallClock]});await client.request({method:'anvil_mine',params:['0x1']});}
else if(Number(head.timestamp)>wallClock+15)throw new Error('Local chain clock is ahead; finish the time-travel test before this integration');
const keys = Object.fromEntries(['owner', 'agent', 'merchantSigner', 'riskSigner', 'humanSigner', 'priceSigner', 'relayer'].map(name => [name, generatePrivateKey()]));
const accounts = Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, privateKeyToAccount(key)]));
const wallet = createWalletClient({ account: accounts.relayer, chain, transport: http(rpc) });
await client.request({ method: 'anvil_setBalance', params: [accounts.relayer.address, toHex(parseEther('100'))] });
async function deploy(name, args = [], official = false) {
  const source = name.startsWith('Mock') ? 'GateFixture.sol' : name + '.sol';
  const artifact = JSON.parse(await readFile(`${official ? framework : root + 'packages/contracts'}/out/${source}/${name}.json`, 'utf8'));
  const receipt = await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args }) });
  assert.equal(receipt.status, 'success');
  return { address: receipt.contractAddress, abi: artifact.abi };
}
async function execute(contract, functionName, args) {
  const { request } = await client.simulateContract({ ...contract, account: accounts.relayer, functionName, args });
  const receipt = await client.waitForTransactionReceipt({ hash: await wallet.writeContract(request) });
  assert.equal(receipt.status, 'success');
  return receipt;
}
const manager = await deploy('DelegationManager', [accounts.relayer.address], true);
const implementation = await deploy('EIP7702StatelessDeleGator', [manager.address, zeroAddress], true);
const jpyc = await deploy('MockToken'), usdc = await deploy('MockToken');
const factory = await deploy('MockFactory'), router = await deploy('MockRouter', [factory.address]);
const names = { periodic: 'ERC20PeriodTransferEnforcer', redeemer: 'RedeemerEnforcer', timestamp: 'TimestampEnforcer', value: 'ValueLteEnforcer', nonce: 'NonceEnforcer', transferAmount: 'ERC20TransferAmountEnforcer', calldata: 'AllowedCalldataEnforcer' };
const enforcers = {};
for (const [key, name] of Object.entries(names)) enforcers[key] = (await deploy(name, [], true)).address;
const gate = await deploy('YoursPurchaseGate', [manager.address, jpyc.address, usdc.address, implementation.address, router.address, factory.address, Object.keys(names).map(name => enforcers[name])]);
const registry = { address: await client.readContract({ ...gate, functionName: 'agentPermissions' }), abi: agentPermissionRegistryAbi };
// A nested registry revert bubbles through the Gate. Include its error ABI so
// this test asserts the specific denial, rather than accepting any RPC failure.
gate.abi = [...gate.abi, ...registry.abi.filter(entry => entry.type === 'error' && !gate.abi.some(existing => existing.type === 'error' && existing.name === entry.name))];
const adapter = await client.readContract({ ...gate, functionName: 'fundingAdapter' });
const authorization = await accounts.owner.signAuthorization({ contractAddress: implementation.address, chainId, nonce: 0 });
assert.equal((await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: accounts.owner.address, authorizationList: [authorization], data: '0x', gas: 150000n }) })).status, 'success');
assert.equal(await client.getBalance({ address: accounts.owner.address }), 0n);
assert.equal(await client.getBalance({ address: accounts.agent.address }), 0n);
const now = (await client.getBlock()).timestamp, expiry = now + 86400n;
const merchant = toHex(100, { size: 20 }), shopIdHash = keccak256(stringToHex('yours-local-merchant'));
const policyId = keccak256(stringToHex('yours-local-policy')), connectionId = keccak256(stringToHex('yours-local-agent'));
const domain = gateDomain(chainId, gate.address);
const sign = (role, type, message) => accounts[role].signTypedData({ domain, types: gateTypes, primaryType: type, message });
async function parent(token, funding) {
  const delegation = { delegate: accounts.agent.address, delegator: accounts.owner.address, authority: toHex(maxUint256, { size: 32 }), salt: toHex(1n), signature: '0x', caveats: [
    { enforcer: enforcers.periodic, terms: encodePacked(['address', 'uint256', 'uint256', 'uint256'], [token, maxUint256, maxUint256, now]), args: '0x' },
    { enforcer: enforcers.redeemer, terms: gate.address, args: '0x' },
    { enforcer: enforcers.timestamp, terms: encodePacked(['uint128', 'uint128'], [0n, expiry]), args: '0x' },
    { enforcer: enforcers.value, terms: toHex(0n, { size: 32 }), args: '0x' },
    { enforcer: enforcers.nonce, terms: toHex(0n, { size: 32 }), args: '0x' },
    ...(funding ? [{ enforcer: enforcers.calldata, terms: encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [4n, gate.address]), args: '0x' }] : []),
  ] };
  delegation.signature = await signDelegation({ privateKey: keys.owner, delegation, delegationManager: manager.address, chainId });
  validateParents(encodeDelegations([delegation]), { chainId, manager: manager.address, owner: accounts.owner.address, agent: accounts.agent.address, token, gate: gate.address, expiry, startTime: now, enforcers, funding });
  return delegation;
}
const parents = { [jpyc.address]: await parent(jpyc.address, false), [usdc.address]: await parent(usdc.address, true) };
const shops = [{ shopIdHash, payTo: merchant }], assets = [{ token: usdc.address, autoPerOrder: 10000000n, autoPerPeriod: 1000000000n }], relayers = [accounts.relayer.address];
const policy = { account: accounts.owner.address, policyId, version: 1n, validAfter: now, validUntil: expiry, periodStart: now, periodSeconds: 3600n, autoPerOrderJpyc: parseEther('10000'), autoPerPeriodJpyc: parseEther('10000'), merchantSetHash: merchantSetHash(shops), assetLimitsHash: assetLimitsHash(assets), riskRulesHash: keccak256(stringToHex('local-test-rules')), identityBindingId: keccak256(stringToHex('local-test-identity')), relayerSetHash: relayerSetHash(relayers), autoMaxPremiumBps: 300, humanOverrideMask: 7, ...Object.fromEntries(['merchantSigner', 'riskSigner', 'humanSigner', 'priceSigner'].map(name => [name, accounts[name].address])) };
const grants = Object.entries(parents).sort(([a], [b]) => BigInt(a) < BigInt(b) ? -1 : 1).map(([token, delegation]) => ({ policyId, policyVersion: 1n, agent: accounts.agent.address, token, grantChainHash: parentChainHash([delegation]), validUntil: expiry }));
const registration = { policyHash: structHash('Policy', policy), grantsHash: grantsHash(grants), nonce: 0n, validUntil: now + 300n };
await execute(gate, 'registerPolicy', [policy, shops, assets, grants, relayers, 0n, registration.validUntil, await sign('owner', 'PolicyRegistration', registration)]);
const permission = { account: accounts.owner.address, policyId, connectionId, revision: 1n, agent: accounts.agent.address, validUntil: expiry, perOrder: parseEther('9500'), perPeriod: parseEther('10000'), merchantsHash: merchantSetHash(shops) };
const permissionDomain = agentPermissionDomain(chainId, registry.address);
await execute(registry, 'configure', [permission, shops, 0n, now + 300n, await accounts.owner.signTypedData({ domain: permissionDomain, types: agentPermissionTypes, primaryType: 'AgentPermission', message: { ...permission, nonce: 0n, deadline: now + 300n } })]);
await execute(jpyc, 'mint', [accounts.owner.address, parseEther('20000')]);
await execute(usdc, 'mint', [accounts.owner.address, 100000000n]);
let sequence = 0;
async function leaf(token, payTo, amount, until) {
  const delegation = buildPaymentLeaf([parents[token]], { agent: accounts.agent.address, gate: gate.address, token, enforcers }, amount, payTo, until, BigInt(++sequence));
  delegation.signature = await signDelegation({ privateKey: keys.agent, delegation, delegationManager: manager.address, chainId });
  return { hash: hashDelegation(delegation), context: encodeDelegations([delegation, parents[token]]) };
}
async function envelope(amount, funding = false, mask = 0) {
  const at = (await client.getBlock()).timestamp, until = at + 300n;
  const route = funding ? encodePacked(['address', 'uint24', 'address'], [jpyc.address, 3000, usdc.address]) : '0x';
  const f = funding ? { token: usdc.address, maxInput: 10000000n, outputJpyc: amount, adapter, routeHash: keccak256(route), quoteDeadline: until } : emptyFunding;
  const payment = await leaf(jpyc.address, merchant, amount, until), input = funding ? await leaf(usdc.address, gate.address, f.maxInput, until) : { hash: zeroHash, context: '0x' };
  const order = { orderId: toHex(++sequence, { size: 32 }), revisionId: toHex(++sequence, { size: 32 }), policyId, policyVersion: 1n, periodIndex: 0n, account: accounts.owner.address, agent: accounts.agent.address, shopIdHash, payTo: merchant, settlementToken: jpyc.address, settlementAmount: amount, basketCommitment: keccak256(stringToHex('local-basket')), fundingHash: structHash('Funding', f), requirementsHash: requirementsHash(chainId, gate.address, { settlementToken: jpyc.address, payTo: merchant, settlementAmount: amount }), validUntil: until };
  const orderHash = digest(domain, 'PurchaseOrder', order), intent = { orderHash, paymentLeafHash: payment.hash, fundingLeafHash: input.hash, validUntil: until };
  const intentHash = digest(domain, 'ExecutionIntent', intent), risk = { intentHash, riskDigest: keccak256(stringToHex('local-test-risk')), rulesHash: policy.riskRulesHash, reasonMask: 0, checkedAt: at, validUntil: at + 60n };
  const price = funding ? { orderHash, token: usdc.address, fairInputAtomic: 10000000n, sourceDigest: keccak256(stringToHex('local-test-price')), observedAt: at, validUntil: at + 60n } : emptyPrice;
  const human = mask ? { approvalId: toHex(++sequence, { size: 32 }), intentHash, riskDigest: risk.riskDigest, identityBindingId: policy.identityBindingId, overrideMask: mask, authenticatedAt: at, validUntil: at + 120n } : emptyApproval;
  const signatures = { merchant: await sign('merchantSigner', 'PurchaseOrder', order), agent: await sign('agent', 'ExecutionIntent', intent), risk: await sign('riskSigner', 'RiskStamp', risk), price: funding ? await sign('priceSigner', 'PriceStamp', price) : '0x', human: mask ? await sign('humanSigner', 'HumanApproval', human) : '0x' };
  return { order, funding: f, intent, paymentContext: payment.context, fundingContext: input.context, risk, price, human, signatures, route };
}
const args = e => [e.order, e.funding, e.intent, e.paymentContext, e.fundingContext, e.risk, e.price, e.human, e.signatures, e.route];
await assert.rejects(client.simulateContract({ ...gate, account: accounts.relayer, functionName: 'executePurchase', args: args(await envelope(parseEther('9600'))) }), /HumanApprovalRequired/);
const normal = await envelope(parseEther('9000'));
const normalReceipt = await execute(gate, 'executePurchase', args(normal));
await assert.rejects(client.simulateContract({ ...gate, account: accounts.relayer, functionName: 'executePurchase', args: args(await envelope(parseEther('2000'))) }), /HumanApprovalRequired/);
const approved = await envelope(parseEther('2000'), true, 2);
const approvedReceipt = await execute(gate, 'executePurchase', args(approved));
assert.equal(await client.readContract({ ...gate, functionName: 'spentJpyc', args: [accounts.owner.address, policyId, 0n] }), parseEther('11000'));
assert.equal(await client.readContract({ ...registry, functionName: 'spent', args: [accounts.owner.address, connectionId, 0n] }), parseEther('11000'));
assert.equal(await client.readContract({ ...jpyc, functionName: 'balanceOf', args: [merchant] }), parseEther('11000'));
assert.equal(await client.readContract({ ...jpyc, functionName: 'balanceOf', args: [accounts.agent.address] }), 0n);
const actualInput = await client.readContract({ ...gate, functionName: 'spentInput', args: [accounts.owner.address, policyId, 0n, usdc.address] });
assert.equal(actualInput, 9600000n);
assert.equal(100000000n - await client.readContract({ ...usdc, functionName: 'balanceOf', args: [accounts.owner.address] }), actualInput);
await assert.rejects(client.simulateContract({ ...gate, account: accounts.relayer, functionName: 'executePurchase', args: args(approved) }));
const transfer = encodePacked(['address', 'uint256', 'bytes'], [jpyc.address, 0n, encodeFunctionData({ abi: jpyc.abi, functionName: 'transfer', args: [merchant, parseEther('1')] })]);
await assert.rejects(client.simulateContract({ ...manager, account: accounts.relayer, functionName: 'redeemDelegations', args: [[normal.paymentContext], [zeroHash], [transfer]] }));
const deadline = (await client.getBlock()).timestamp + 300n;
await execute(registry, 'revoke', [accounts.owner.address, connectionId, 1n, deadline, await accounts.owner.signTypedData({ domain: permissionDomain, types: agentPermissionTypes, primaryType: 'RevokeAgent', message: { account: accounts.owner.address, connectionId, nonce: 1n, deadline } })]);
await assert.rejects(client.simulateContract({ ...gate, account: accounts.relayer, functionName: 'executePurchase', args: args(await envelope(parseEther('1'), false, 7)) }), /AgentInactive/);
const evidence = { scope: 'Local Anvil only. Real EIP-7702, official MetaMask Manager/account/enforcers, real signatures. Test tokens/router and test risk/human signers. No public Amoy transfer or browser wallet proof.', frameworkCommit: pinnedFramework, chainId, gate: gate.address, registry: registry.address, passed: ['gasless owner and agent', 'official signed delegations accepted', 'per-agent order limit enforced', 'automatic purchase', 'period excess rejected', 'single-order exception with atomic funding', 'shared and agent ledgers both 11000', 'merchant receives funds; AI holds none', 'unused funding returned', 'payment replay rejected', 'direct Manager bypass rejected', 'revocation cannot be overridden'], normalTransaction: normalReceipt.transactionHash, approvedTransaction: approvedReceipt.transactionHash };
await mkdir(root + 'docs/evidence', { recursive: true });
await writeFile(root + 'docs/evidence/local-chain.json', JSON.stringify(evidence, null, 2) + '\n');
await mkdir(root + '.local', { recursive: true });
await writeFile(root + '.local/local-chain.json', JSON.stringify({chainId,gate:gate.address,registry:registry.address,manager:manager.address,accountImplementation:implementation.address,jpyc:jpyc.address,usdc:usdc.address,enforcers,contracts:[],addresses:{relayer:accounts.relayer.address,agent:accounts.agent.address,merchant:accounts.merchantSigner.address,risk:accounts.riskSigner.address,human:accounts.humanSigner.address,price:accounts.priceSigner.address}}, null, 2) + '\n');
console.log(JSON.stringify({ passed: evidence.passed.length, evidence: 'docs/evidence/local-chain.json', scope: evidence.scope }));
if(process.env.PAYMENT_PIPELINE==='1'){
 const {paymentIntegration}=await import('../../../services/api/scripts/payment-integration.mjs');
 const manifest=JSON.parse(await readFile(root+'.local/local-chain.json','utf8'));
 await paymentIntegration({root,client,wallet,accounts,manifest,jpyc,humanKey:keys.humanSigner});
}
