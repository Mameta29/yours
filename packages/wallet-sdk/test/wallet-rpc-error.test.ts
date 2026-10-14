import { describe, expect, it } from 'vitest';
import { walletRpcError } from '../src/wallet-rpc-error.js';

describe('wallet setup RPC diagnostics', () => {
  it.each([
    [4001, 'wallet_rejected'], [5750, 'wallet_rejected'],
    [-32002, 'wallet_permission_pending'], [4100, 'wallet_permission_missing'],
    [-32602, 'wallet_upgrade_invalid_request'], [5730, 'wallet_upgrade_batch_unknown'],
    [5760, 'wallet_upgrade_unsupported'],
  ])('unwraps MetaMask originalError (%s)', (code, name) => {
    const error = walletRpcError({ code: -32603, message: 'Internal error', data: { originalError: { code, message: 'specific reason' } } }, 'wallet_sendCalls');
    expect(error.message).toBe(name);
    expect(error.diagnostic).toEqual({ method: 'wallet_sendCalls', code, message: 'specific reason' });
  });
  it('retains method and the nested reason when an internal error has no inner code', () => {
    const error = walletRpcError({ code: -32603, message: 'Internal error', cause: new Error('Failed to fetch') }, 'wallet_getCapabilities');
    expect(error.message).toBe('wallet_upgrade_request_failed');
    expect(error.diagnostic).toEqual({ method: 'wallet_getCapabilities', code: -32603, message: 'Failed to fetch' });
  });
  it('displays no request payload, signed hex, URLs or credentials', () => {
    const secret = '0x' + 'ab'.repeat(65);
    const error = walletRpcError({ message: `Failed ${secret} https://rpc.example/secret?key=secret token=secret\nretry`, data: { request: { params: [secret] } } }, 'wallet_sendCalls');
    expect(error.diagnostic.message).toBe('Failed [hex] [URL] [redacted] retry');
    expect(JSON.stringify(error.diagnostic)).not.toContain('secret');
  });
  it('bounds cyclic and overlong provider errors', () => {
    const cyclic: any = { code: -32603, message: 'reason '.repeat(100) };
    cyclic.cause = cyclic;
    expect(walletRpcError(cyclic, 'wallet_getCallsStatus').diagnostic.message).toHaveLength(240);
  });
});
