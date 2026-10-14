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
  ensureGateSmartAccount,
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
  const upgradeKey = `yours.upgrade.${config.chainId}.${address.toLowerCase()}.${state.accountImplementation.toLowerCase()}`;
  let pendingUpgrade;
  try {
    pendingUpgrade = JSON.parse(localStorage.getItem(upgradeKey) ?? "null");
  } catch {}
  await ensureGateSmartAccount({
    provider,
    client: publicClient,
    chainId: config.chainId,
    owner: address,
    implementation: state.accountImplementation,
    pendingBatchId: pendingUpgrade?.id,
    onSubmitted: (id) =>
      localStorage.setItem(upgradeKey, JSON.stringify({ id })),
    onSettled: () => localStorage.removeItem(upgradeKey),
    onProgress: (stage) =>
      progress(
        stage === "approval"
          ? "MetaMaskでスマートアカウントへの切り替えを確認してください"
          : "ウォレットの設定を反映しています。完了後、購入権限の承認へ進みます",
      ),
  });
  let draft = (
    await api(`/api/owner/permissions/connections/${connection.id}/draft`)
  ).draft;
  const storageKey = `yours.permission.${config.chainId}.${address.toLowerCase()}.${connection.id}`;
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
  } catch {}
  let hashes = {
    ...(draft?.hashes ?? {}),
    ...(saved && draft && saved.id === draft.id ? saved.hashes : {}),
  };
  const persist = () =>
    localStorage.setItem(storageKey, serialize({ id: draft.id, hashes }));
  const wait = async (key, hash) => {
    progress("送信済みの登録を確認しています");
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 5,
      timeout: 180000,
      onReplaced: ({ transaction }) => {
        hashes[key] = transaction.hash;
        persist();
      },
    });
    if (receipt.status !== "success") return false;
    hashes[key] = receipt.transactionHash;
    persist();
    await api(`/api/owner/permissions/drafts/${draft.id}/progress`, hashes);
    return true;
  };
  if (draft) {
    for (const key of ["policy", "permission"]) {
      if (hashes[key] && !(await wait(key, hashes[key]))) {
        // Let the server verify the reverted call before issuing fresh consent.
        await api(`/api/owner/permissions/drafts/${draft.id}/progress`, hashes);
        delete hashes[key];
        persist();
      }
    }
    if (hashes.policy && hashes.permission) {
      await api(`/api/owner/permissions/drafts/${draft.id}/activate`, hashes);
      localStorage.removeItem(storageKey);
      return;
    }
  }
  if (
    !draft ||
    (!draft.context && Number(draft.deadline) <= Date.now() / 1000 + 120) ||
    Number(draft.permission.validUntil) <= Date.now() / 1000 + 600
  ) {
    // Any confirmed first call has been reconciled above. A fresh draft keeps
    // the same policy ID, shared usage and period anchor.
    draft = await api(
      `/api/owner/permissions/connections/${connection.id}/prepare`,
      settings,
    );
    hashes = {};
    persist();
  }
  const e = {
    ...draft.expectation,
    expiry: BigInt(draft.expectation.expiry),
    startTime: BigInt(draft.expectation.startTime),
  };
  let context = draft.context;
  if (!context) {
    progress("ウォレットで購入権限を承認してください");
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
  }
  const base = "/api/owner/permissions/drafts/" + draft.id;
  let terms = draft.typedData
    ? { typedData: draft.typedData, policyRegistered: draft.policyRegistered }
    : await api(base + "/parents", { context });
  if (
    (draft.deadline && Number(draft.deadline) <= Date.now() / 1000 + 120) ||
    (draft.hashes?.permission && !hashes.permission) ||
    (draft.hashes?.policy && !hashes.policy)
  ) {
    terms = await api(base + "/renew", {});
    draft = await api(base);
  }
  let transactions = draft.calls?.[1] ? { calls: draft.calls } : null;
  if (!transactions) {
    progress("上限と共有予算の署名を確認してください");
    const policy = terms.policyRegistered
        ? undefined
        : await typed(
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
    transactions = await api(base + "/transactions", { policy, permission });
  }
  persist();
  for (const [i, call] of transactions.calls.entries()) {
    const key = i === 0 ? "policy" : "permission";
    if (hashes[key]) continue;
    progress(`権限の登録 ${i + 1}/2 — ウォレットで取引を承認してください`);
    await ensure(provider, config.chainId, address);
    hashes[key] = await wallet.sendTransaction(call);
    persist();
    // The browser journal survives tab closure even before RPC propagation.
    await api(base + "/progress", hashes).catch(() => {});
    if (!(await wait(key, hashes[key])))
      throw new Error("transaction_reverted");
  }
  await api(base + "/activate", hashes);
  localStorage.removeItem(storageKey);
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

export async function personal(provider, address, chainId, message) {
  await ensure(provider, chainId, address);
  const signature = await provider.request({
    method: "personal_sign",
    params: [toHex(message), address],
  });
  await ensure(provider, chainId, address);
  return signature;
}
