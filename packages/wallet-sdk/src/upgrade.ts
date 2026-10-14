import { toHex, type Address, type EIP1193Provider, type Hex, type PublicClient, type WalletGetCallsStatusReturnType } from 'viem';
import { isExpected7702Code } from './wallet.js';

type UpgradeOptions = {
  provider: EIP1193Provider;
  client: PublicClient;
  chainId: number;
  owner: Address;
  implementation: Address;
  pendingBatchId?: Hex;
  /** Persist before polling: a tab reload must never submit a second batch. */
  onSubmitted: (id: Hex) => void;
  onSettled: () => void;
  onProgress?: (stage: 'approval' | 'confirming') => void;
};
const hash = /^0x[0-9a-fA-F]{64}$/;
const batchId = /^0x[0-9a-fA-F]{1,512}$/;

async function sameWallet(provider: EIP1193Provider, chainId: number, owner: Address) {
  if (Number(await provider.request({ method: 'eth_chainId' })) !== chainId) throw new Error('wallet_chain_mismatch');
  const accounts = await provider.request({ method: 'eth_accounts' });
  if (accounts[0]?.toLowerCase() !== owner.toLowerCase()) throw new Error('wallet_account_changed');
}
function rpcError(error: unknown) {
  let cause: any = error;
  for (let i = 0; cause && i < 8; i++, cause = cause.cause) {
    if ([4001, 5750].includes(cause.code)) return new Error('wallet_rejected', { cause: error });
    if (cause.code === -32002) return new Error('wallet_permission_pending', { cause: error });
    if ([-32601, 4200, 5700, 5710, 5760].includes(cause.code)) return new Error('wallet_upgrade_unsupported', { cause: error });
  }
  return new Error('wallet_upgrade_request_failed', { cause: error });
}

/** Explicit-click EIP-5792 upgrade. No token approval or asset transfer is sent.
 * MetaMask chooses its implementation; we independently require the pinned one.
 * Never replace an existing, different smart-account implementation.
 */
export async function ensureGateSmartAccount(options: UpgradeOptions): Promise<void> {
  const { provider, client, chainId, owner, implementation, onSubmitted, onSettled, onProgress } = options;
  if (await client.getChainId() !== chainId) throw new Error('rpc_chain_mismatch');
  await sameWallet(provider, chainId, owner);
  const code = await client.getCode({ address: owner });
  if (code && code !== '0x' && !isExpected7702Code(code, implementation)) throw new Error('wallet_implementation_mismatch');
  if (!options.pendingBatchId && isExpected7702Code(code, implementation)) return;
  let id = options.pendingBatchId;
  if (!id) {
    const capabilities = await provider.request({ method: 'wallet_getCapabilities', params: [owner, [toHex(chainId)]] }).catch(error => { throw rpcError(error); });
    const status = capabilities[toHex(chainId)]?.atomic?.status;
    if (status !== 'ready' && status !== 'supported') throw new Error('wallet_upgrade_unsupported');
    await sameWallet(provider, chainId, owner);
    onProgress?.('approval');
    // Two empty, zero-value self calls explicitly request atomic execution,
    // following MetaMask's documented upgrade flow. Do not retry this RPC.
    const result = await provider.request({ method: 'wallet_sendCalls', params: [{
      version: '2.0.0', from: owner, chainId: toHex(chainId), atomicRequired: true,
      calls: [{ to: owner, value: '0x0', data: '0x' }, { to: owner, value: '0x0', data: '0x' }],
    }] }).catch(error => { throw rpcError(error); });
    if (!result || !batchId.test(result.id)) throw new Error('wallet_upgrade_response_invalid');
    id = result.id as Hex;
    onSubmitted(id);
  }
  if (!id || !batchId.test(id)) throw new Error('wallet_upgrade_response_invalid');
  onProgress?.('confirming');
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await sameWallet(provider, chainId, owner);
    const status: WalletGetCallsStatusReturnType = await provider.request({ method: 'wallet_getCallsStatus', params: [id] }).catch(error => { throw rpcError(error); });
    if (status.id !== id || Number(status.chainId) !== chainId || status.version !== '2.0.0') throw new Error('wallet_upgrade_response_invalid');
    if (status.status >= 300 && status.status < 600) {
      onSettled();
      throw new Error('wallet_upgrade_failed');
    }
    if (status.status === 200) {
      if (!status.atomic || !status.receipts?.length || status.receipts.length > 2) throw new Error('wallet_upgrade_response_invalid');
      for (const receipt of status.receipts) {
        if (!hash.test(receipt.transactionHash) || receipt.status !== '0x1') throw new Error('wallet_upgrade_response_invalid');
        const confirmed = await client.waitForTransactionReceipt({ hash: receipt.transactionHash, confirmations: 5, timeout: 180_000 });
        const canonical = await client.getBlock({ blockNumber: confirmed.blockNumber });
        if (confirmed.status !== 'success' || canonical.hash !== confirmed.blockHash) throw new Error('wallet_upgrade_failed');
        const confirmedCode = await client.getCode({ address: owner, blockNumber: confirmed.blockNumber });
        if (!isExpected7702Code(confirmedCode, implementation)) throw new Error('wallet_upgrade_not_applied');
      }
      if (!isExpected7702Code(await client.getCode({ address: owner }), implementation)) throw new Error('wallet_implementation_mismatch');
      await sameWallet(provider, chainId, owner);
      onSettled();
      return;
    }
    if (status.status !== 100) throw new Error('wallet_upgrade_response_invalid');
    await new Promise(resolve => setTimeout(resolve, 1_500));
  }
  throw new Error('wallet_upgrade_confirming');
}
