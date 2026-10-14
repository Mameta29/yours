export type UpgradeRpcMethod = 'wallet_getCapabilities' | 'wallet_sendCalls' | 'wallet_getCallsStatus';
export type WalletRpcMethod = UpgradeRpcMethod | 'wallet_getSupportedExecutionPermissions' | 'wallet_requestExecutionPermissions' | 'eth_signTypedData_v4';

/** Displayable context only. Never include request parameters or error.data. */
export type WalletRpcDiagnostic = { method: WalletRpcMethod; code?: number; message: string };

function safeMessage(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]')
    .replace(/0x[\da-f]{40,}/gi, '[hex]')
    .replace(/\b[A-Za-z0-9_+\/=.-]{48,}\b/g, '[data]')
    .replace(/\b(?:bearer\s+|(?:token|password|secret|api[-_]?key)\s*[:=]\s*)[^\s,;]+/gi, '[redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 240);
}

export function walletRpcError(error: unknown, method: WalletRpcMethod): Error & { diagnostic: WalletRpcDiagnostic } {
  // MetaMask serializes the underlying RPC error under data.originalError;
  // viem uses cause. Bound traversal and handle cyclic provider errors.
  const seen = new Set<unknown>();
  const queue = [error];
  const causes: { code?: number; message: string }[] = [];
  while (queue.length && seen.size < 12) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const item = current as { code?: unknown; message?: unknown; cause?: unknown; data?: { originalError?: unknown }; error?: unknown };
    causes.push({ code: typeof item.code === 'number' && Number.isSafeInteger(item.code) ? item.code : undefined, message: safeMessage(item.message) });
    queue.push(item.cause, item.data?.originalError, item.error);
  }
  const specific = causes.find(cause => cause.code !== undefined && cause.code !== -32603);
  const detail = specific ?? [...causes].reverse().find(cause => cause.message) ?? causes[0];
  const code = specific?.code ?? causes.find(cause => cause.code !== undefined)?.code;
  const isPermission = method === 'wallet_getSupportedExecutionPermissions' || method === 'wallet_requestExecutionPermissions';
  const isSignature = method === 'eth_signTypedData_v4';
  let message = isPermission ? (method === 'wallet_getSupportedExecutionPermissions' ? 'wallet_permission_probe_failed' : 'wallet_permission_request_failed') : isSignature ? 'wallet_signature_request_failed' : 'wallet_upgrade_request_failed';
  if (code === 4001 || code === 5750) message = 'wallet_rejected';
  else if (code === -32002) message = 'wallet_permission_pending';
  else if (code === 4100) message = 'wallet_permission_missing';
  else if (code === -32602) message = isPermission ? 'wallet_permission_invalid_request' : isSignature ? 'wallet_signature_invalid_request' : 'wallet_upgrade_invalid_request';
  else if (code === 5730 && !isPermission && !isSignature) message = 'wallet_upgrade_batch_unknown';
  else if ([-32601, 4200, 5700, 5710, 5760].includes(code ?? 0)) message = isPermission ? 'wallet_permission_unsupported' : isSignature ? 'wallet_signature_unsupported' : 'wallet_upgrade_unsupported';
  return Object.assign(new Error(message, { cause: error }), { diagnostic: { method, code, message: detail?.message ?? '' } });
}
