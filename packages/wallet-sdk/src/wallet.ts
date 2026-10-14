import { createWalletClient, custom, maxUint256, parseAbi, type Address, type EIP1193Provider, type Hex, type PublicClient } from 'viem';
import { SIGNABLE_DELEGATION_TYPED_DATA, toDelegationStruct } from '@metamask/smart-accounts-kit/utils';
import { hashDelegation, validatePermissionResponse, type Delegation, type GrantExpectation } from './permissions.js';

/** Portable EIP-712 signing request; contains no private key or RPC side effect. */
export function delegationTypedData(chainId:number,manager:Address,delegation:Delegation){
 return {domain:{name:'DelegationManager',version:'1',chainId,verifyingContract:manager},types:SIGNABLE_DELEGATION_TYPED_DATA,primaryType:'Delegation' as const,message:toDelegationStruct(delegation)};
}

export function gatePermissionRequests(expectations: readonly GrantExpectation[]) {
  if (!expectations.length || expectations.length > 2 || new Set(expectations.map(e => e.token.toLowerCase())).size !== expectations.length) throw new Error('Invalid permission set');
  const first = expectations[0]!;
  if (expectations.some(e => e.chainId !== first.chainId || e.owner !== first.owner || e.agent !== first.agent || e.gate !== first.gate || e.manager !== first.manager || e.expiry !== first.expiry || e.startTime !== first.startTime || e.owner.toLowerCase() === e.agent.toLowerCase() || e.expiry <= e.startTime || e.expiry > BigInt(Number.MAX_SAFE_INTEGER))) throw new Error('Inconsistent permission set');
  return expectations.map(e => ({ chainId: e.chainId, from: e.owner, to: e.agent, expiry: Number(e.expiry), redeemer: [e.gate], ...(e.funding ? { payee: [e.gate] } : {}),
    permission: { type: 'erc20-token-allowance' as const, isAdjustmentAllowed: false,
      data: { tokenAddress: e.token, allowanceAmount: maxUint256, startTime: Number(e.startTime),
        justification: 'PurchaseGate enforces the normal shopping budget OR a fresh, exact-order approval from the registered person. Root token amount is unlimited until expiry.' } } }));
}

async function assertWallet(provider: EIP1193Provider, chainId: number, owner?: Address) {
  if (Number(await provider.request({ method: 'eth_chainId' })) !== chainId) throw new Error('wallet_chain_mismatch');
  if (owner) {
    const accounts = await provider.request({ method: 'eth_accounts' });
    if (!accounts[0] || accounts[0].toLowerCase() !== owner.toLowerCase()) throw new Error('wallet_account_changed');
  }
}
/** Read-only capability probe after an explicit wallet connection; never treats a feature flag as acceptance. */
export async function probeGatePermissions(provider: EIP1193Provider, chainId: number, owner: Address) {
  await assertWallet(provider, chainId, owner);
  const { erc7715ProviderActions } = await import('@metamask/smart-accounts-kit/actions');
  const wallet = createWalletClient({ transport: custom(provider, { retryCount: 0 }) }).extend(erc7715ProviderActions());
  const supported = await wallet.getSupportedExecutionPermissions().catch(error => {
    // SDK/viem may wrap the wallet's JSON-RPC error. Connection success alone
    // does not imply this wallet supports Advanced Permissions.
    let cause = error;
    for (let i = 0; cause && i < 8; i++, cause = cause.cause) {
      if (cause.code === -32601 || cause.code === 4200) throw new Error('wallet_permission_unsupported');
    }
    throw new Error('wallet_permission_probe_failed', { cause: error });
  });
  const permission = supported['erc20-token-allowance'];
  const canRequest = !!permission?.chainIds.includes(chainId) && ['expiry', 'redeemer', 'payee'].every(r => permission.ruleTypes.includes(r));
  await assertWallet(provider, chainId, owner);
  return { supported, canRequest };
}

/** Called only on an explicit consent click. SDK converts developer requests into the correct raw RPC form. */
export async function requestGatePermissions(provider: EIP1193Provider, expectations: readonly GrantExpectation[]) {
  const requests = gatePermissionRequests(expectations), first = expectations[0]!;
  await assertWallet(provider, first.chainId, first.owner);
  const { erc7715ProviderActions } = await import('@metamask/smart-accounts-kit/actions');
  const wallet = createWalletClient({ transport: custom(provider, { retryCount: 0 }) }).extend(erc7715ProviderActions());
  const responses = await wallet.requestExecutionPermissions(requests).catch(error => {
    // Preserve the wallet's numeric RPC code without exposing its raw message,
    // which can contain account or permission details.
    let cause = error;
    for (let i = 0; cause && i < 8; i++, cause = cause.cause) {
      if (cause.code === 4001) throw new Error('wallet_rejected', { cause: error });
      if (cause.code === -32601 || cause.code === 4200) throw new Error('wallet_permission_unsupported', { cause: error });
      if (cause.code === -32002) throw new Error('wallet_permission_pending', { cause: error });
    }
    throw new Error('wallet_permission_request_failed', { cause: error });
  });
  await assertWallet(provider, first.chainId, first.owner);
  if (responses.length !== expectations.length) throw new Error('wallet_permission_count_mismatch');
  const used = new Set<number>();
  const grants = expectations.map(e => {
    const index = responses.findIndex((r, i) => !used.has(i) && r.permission.type === 'erc20-token-allowance' && r.permission.data.tokenAddress.toLowerCase() === e.token.toLowerCase());
    if (index < 0) throw new Error('wallet_permission_token_mismatch');
    used.add(index);
    try {
      return { token: e.token, ...validatePermissionResponse(responses[index], e) };
    } catch (error) {
      throw new Error('wallet_permission_validation_failed', { cause: error });
    }
  });
  return { responses, grants };
}

/** Verify signatures and revocation on the configured chain, independently of wallet response metadata. */
export async function verifyParentSignatures(client: PublicClient, parents: readonly Delegation[], e: GrantExpectation) {
  if (await client.getChainId() !== e.chainId) throw new Error('rpc_chain_mismatch');
  await Promise.all(parents.map(async parent => {
    const valid = await client.verifyTypedData({ address: parent.delegator, domain: { name: 'DelegationManager', version: '1', chainId: e.chainId, verifyingContract: e.manager },
      types: SIGNABLE_DELEGATION_TYPED_DATA, primaryType: 'Delegation', message: toDelegationStruct(parent), signature: parent.signature });
    if (!valid) throw new Error('invalid_parent_signature');
    const disabled = await client.readContract({ address: e.manager, abi: parseAbi(['function disabledDelegations(bytes32) view returns(bool)']), functionName: 'disabledDelegations', args: [hashDelegation(parent)] });
    if (disabled) throw new Error('parent_revoked');
    for (const caveat of parent.caveats.filter(c => c.enforcer.toLowerCase() === e.enforcers.nonce.toLowerCase())) {
      const nonce = await client.readContract({ address: e.enforcers.nonce, abi: parseAbi(['function currentNonce(address,address) view returns(uint256)']), functionName: 'currentNonce', args: [e.manager, parent.delegator] });
      if (nonce !== BigInt(caveat.terms)) throw new Error('parent_nonce_revoked');
    }
  }));
}

export function isExpected7702Code(code: Hex | undefined, implementation: Address) {
  return code?.toLowerCase() === `0xef0100${implementation.slice(2)}`.toLowerCase();
}
