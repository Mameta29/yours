import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  maxUint256,
  toHex,
  encodePacked,
} from "viem";
import { polygonAmoy, foundry } from "viem/chains";
import {
  requestGatePermissions,
  encodeDelegations,
  delegationTypedData,
} from "@yours/wallet-sdk";
import { api } from "./api";
const serialize = (value) =>
  JSON.stringify(value, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
export async function ensure(provider, chainId, address) {
  const accounts = await provider.request({ method: "eth_accounts" });
  if (accounts[0]?.toLowerCase() !== address.toLowerCase())
    throw new Error("wallet_account_changed");
  if (Number(await provider.request({ method: "eth_chainId" })) !== chainId)
    throw new Error("wallet_chain_mismatch");
}
export async function connect(provider, config) {
  const accounts = await provider.request({ method: "eth_requestAccounts" }),
    address = accounts[0];
  if (
    Number(await provider.request({ method: "eth_chainId" })) !== config.chainId
  ) {
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: toHex(config.chainId) }],
      });
    } catch (error) {
      if (error.code !== 4902) throw error;
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: toHex(config.chainId),
            chainName: "Polygon Amoy",
            nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
            rpcUrls: ["https://polygon-amoy-bor-rpc.publicnode.com"],
            blockExplorerUrls: ["https://amoy.polygonscan.com"],
          },
        ],
      });
    }
  }
  await ensure(provider, config.chainId, address);
  const challenge = await api("/api/auth/challenge", { address });
  const signature = await provider.request({
    method: "personal_sign",
    params: [toHex(challenge.message), address],
  });
  await api("/api/auth/verify", { nonce: challenge.nonce, signature });
  return address;
}
export async function typed(provider, address, chainId, data) {
  await ensure(provider, chainId, address);
  return provider.request({
    method: "eth_signTypedData_v4",
    params: [address, serialize(data)],
  });
}
function clients(provider, config, address) {
  const chain = config.chainId === 80002 ? polygonAmoy : foundry;
  return {
    wallet: createWalletClient({
      account: address,
      chain,
      transport: custom(provider),
    }),
    publicClient: createPublicClient({
      chain,
      transport: http(
        config.chainId === 80002
          ? "https://polygon-amoy-bor-rpc.publicnode.com"
          : "http://127.0.0.1:18812",
      ),
    }),
  };
}
export async function registerPermission({
  provider,
  address,
  config,
  connection,
  settings,
  progress,
}) {
  const { wallet, publicClient } = clients(provider, config, address);
  progress("委任する条件を確認しています");
  const state = await api("/api/owner/permissions/wallet");
  const draft = await api(
      `/api/owner/permissions/connections/${connection.id}/prepare`,
      settings,
    ),
    e = {
      ...draft.expectation,
      expiry: BigInt(draft.expectation.expiry),
      startTime: BigInt(draft.expectation.startTime),
    };
  let context;
  progress("ウォレットで購入権限を承認してください");
  if (state.smartAccountReady) {
    const nonce = await publicClient.readContract({
      address: e.enforcers.nonce,
      abi: [
        {
          type: "function",
          name: "currentNonce",
          stateMutability: "view",
          inputs: [
            { name: "manager", type: "address" },
            { name: "delegator", type: "address" },
          ],
          outputs: [{ type: "uint256" }],
        },
      ],
      functionName: "currentNonce",
      args: [e.manager, address],
    });
    const parent = {
      delegate: e.agent,
      delegator: address,
      authority: toHex(maxUint256, { size: 32 }),
      salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
      signature: "0x",
      caveats: [
        {
          enforcer: e.enforcers.periodic,
          terms: encodePacked(
            ["address", "uint256", "uint256", "uint256"],
            [e.token, maxUint256, maxUint256, e.startTime],
          ),
          args: "0x",
        },
        { enforcer: e.enforcers.redeemer, terms: e.gate, args: "0x" },
        {
          enforcer: e.enforcers.timestamp,
          terms: encodePacked(["uint128", "uint128"], [0n, e.expiry]),
          args: "0x",
        },
        {
          enforcer: e.enforcers.value,
          terms: toHex(0n, { size: 32 }),
          args: "0x",
        },
        {
          enforcer: e.enforcers.nonce,
          terms: toHex(nonce, { size: 32 }),
          args: "0x",
        },
      ],
    };
    parent.signature = await typed(
      provider,
      address,
      config.chainId,
      delegationTypedData(config.chainId, e.manager, parent),
    );
    context = encodeDelegations([parent]);
  } else {
    const result = await requestGatePermissions(provider, [e]);
    context = result.responses[0].context;
  }
  const base = "/api/owner/permissions/drafts/" + draft.id;
  const terms = await api(base + "/parents", { context });
  progress("上限と共有予算の署名を確認してください");
  const policy = await typed(
      provider,
      address,
      config.chainId,
      terms.typedData.policy,
    ),
    permission = await typed(
      provider,
      address,
      config.chainId,
      terms.typedData.permission,
    );
  const transactions = await api(base + "/transactions", {
    policy,
    permission,
  });
  const hashes = [];
  for (const [i, call] of transactions.calls.entries()) {
    progress(`権限の登録 ${i + 1}/2 — ウォレットで取引を承認してください`);
    await ensure(provider, config.chainId, address);
    const hash = await wallet.sendTransaction(call);
    hashes.push(hash);
    sessionStorage.setItem(
      "yours.permission-draft",
      serialize({ id: draft.id, owner: address, hashes }),
    );
    progress(`権限の登録 ${i + 1}/2 — チェーン上の確定を待っています`);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 5,
    });
    if (receipt.status !== "success") throw new Error("transaction_reverted");
  }
  await api(base + "/activate", { policy: hashes[0], permission: hashes[1] });
  sessionStorage.removeItem("yours.permission-draft");
}
export async function revokePermission({
  provider,
  address,
  config,
  connection,
  progress,
}) {
  progress("新しい購入を停止しています");
  const prepared = await api(
    `/api/owner/permissions/connections/${connection.id}/revoke/prepare`,
    {},
  );
  progress("ウォレットで権限の取り消しを承認してください");
  const signature = await typed(
    provider,
    address,
    config.chainId,
    prepared.typedData,
  );
  const call = await api(
    `/api/owner/permissions/connections/${connection.id}/revoke/transaction`,
    {
      nonce: String(prepared.typedData.message.nonce),
      deadline: Number(prepared.typedData.message.deadline),
      signature,
    },
  );
  const { wallet, publicClient } = clients(provider, config, address);
  await ensure(provider, config.chainId, address);
  const hash = await wallet.sendTransaction(call);
  progress("取り消しの確定を待っています");
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 5,
  });
  if (receipt.status !== "success") throw new Error("transaction_reverted");
  await api(
    `/api/owner/permissions/connections/${connection.id}/revoke/confirm`,
    { transactionHash: hash },
  );
}
