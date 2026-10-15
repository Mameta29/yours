import React, { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  ArrowRight,
  Wallet,
  ShieldCheck,
  Plus,
  Pause,
  Check,
  ChevronRight,
  LayoutDashboard,
  Layers,
  Activity,
  Code2,
  X,
  LoaderCircle,
  FileText,
  LockKeyhole,
  ExternalLink,
  RefreshCw,
  AlertCircle,
  LogOut,
  Copy,
} from "lucide-react";
import {
  api,
  explain,
  walletErrorDetails,
  short,
  yen,
  fromAtomic,
} from "./api";
import OrderDetails from "./OrderDetails";
import HomeWorkspace from "./HomeWorkspace";
import { auditLabels } from "./run-progress";
const walletAction =
  (name) =>
  (...args) =>
    import("./wallet").then((module) => module[name](...args));
const connect = walletAction("connect"),
  typed = walletAction("typed"),
  personal = walletAction("personal"),
  registerPermission = walletAction("registerPermission"),
  revokePermission = walletAction("revokePermission");
import "./style.css";
const states = {
  pending: "設定待ち",
  active: "有効",
  paused: "停止中",
  revoked: "取り消し済み",
  prepared: "準備中",
  approval_required: "あなたの確認が必要",
  authorized: "実行準備中",
  signing: "署名中",
  submitted: "チェーンの確定待ち",
  confirmed: "支払済み",
  failed: "成立せず",
  canceled: "キャンセル",
};
const linkedOrder = window.location.pathname.match(
  /^\/orders\/([0-9a-f-]{36})\/?$/i,
)?.[1];
const Logo = () => (
  <span className="wordmark">
    yours<span className="brand-period">.</span>
  </span>
);
const Status = ({ state }) => (
  <span className={"status " + state}>
    <i />
    {states[state] ?? state}
  </span>
);
function NoticeText({ notice }) {
  return (
    <div className="notice-text">
      {notice.text}
      {notice.details && (
        <details className="wallet-error-details">
          <summary>エラーの詳細</summary>
          <pre>{notice.details}</pre>
        </details>
      )}
    </div>
  );
}
function App() {
  const [config, setConfig] = useState(null),
    [data, setData] = useState(null),
    [providers, setProviders] = useState([]),
    [provider, setProvider] = useState(null),
    [tab, setTab] = useState("home"),
    [modal, setModal] = useState(
      linkedOrder ? { kind: "order", orderId: linkedOrder } : null,
    ),
    [busy, setBusy] = useState(""),
    [notice, setNotice] = useState(null),
    [products, setProducts] = useState([]),
    [tasks, setTasks] = useState([]),
    [runs, setRuns] = useState([]),
    [pendingRun, setPendingRun] = useState(null),
    [audit, setAudit] = useState([]),
    [chat, setChat] = useState(""),
    [selected, setSelected] = useState(""),
    [wallet, setWallet] = useState(null);
  const logoutPending = useRef(Promise.resolve());
  const refresh = useCallback(async () => {
    try {
      const me = await api("/api/owner/me");
      setData(me);
      const [t, r, a] = await Promise.all([
        api("/api/owner/tasks"),
        api("/api/owner/runs"),
        api("/api/owner/audit"),
      ]);
      setTasks(t.tasks);
      setRuns(r.runs);
      setAudit(a.events);
    } catch (e) {
      if (e.status === 401) setData(null);
      else throw e;
    }
  }, []);
  useEffect(() => {
    api("/api/config")
      .then(setConfig)
      .catch(() =>
        setNotice({
          error: true,
          text: "接続できませんでした。ページを再読み込みしてください。",
        }),
      );
    refresh().catch(() => {});
    const announce = (e) =>
      setProviders((old) =>
        old.some(
          (p) =>
            p.info.uuid === e.detail.info.uuid ||
            p.provider === e.detail.provider,
        )
          ? old
          : [...old, e.detail],
      );
    window.addEventListener("eip6963:announceProvider", announce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    if (window.ethereum)
      setProviders([
        {
          info: {
            uuid: "injected",
            name: window.ethereum.isMetaMask
              ? "MetaMask"
              : "ブラウザのウォレット",
          },
          provider: window.ethereum,
        },
      ]);
    return () =>
      window.removeEventListener("eip6963:announceProvider", announce);
  }, [refresh]);
  useEffect(() => {
    if (linkedOrder && data?.account.id)
      setModal({ kind: "order", orderId: linkedOrder });
  }, [data?.account.id]);
  useEffect(() => {
    if (!config) return;
    api(
      "/ucp/catalog/search",
      { query: "", pagination: { limit: 12 } },
      {
        headers: {
          "UCP-Agent": 'profile="' + config.origin + '/.well-known/ucp"',
        },
      },
    )
      .then((r) => setProducts(r.products))
      .catch(() => {});
  }, [config]);
  useEffect(() => {
    if (!data) return;
    const timer = setInterval(
      () => refresh().catch(() => {}),
      pendingRun ||
        runs.some((r) => r.status === "running") ||
        data.intents?.some((i) =>
          ["authorized", "signing", "submitted"].includes(i.state),
        )
        ? 2000
        : 8000,
    );
    return () => clearInterval(timer);
  }, [
    data?.account.id,
    refresh,
    !!pendingRun,
    runs.some((r) => r.status === "running"),
    data?.intents?.some((i) =>
      ["authorized", "signing", "submitted"].includes(i.state),
    ),
  ]);
  useEffect(() => {
    if (!data) return;
    api("/api/owner/permissions/wallet")
      .then(setWallet)
      .catch(() => {});
  }, [
    data?.account.id,
    data?.policy?.activation_tx,
    data?.intents?.find((i) => i.state === "confirmed")?.transaction_hash,
  ]);
  useEffect(() => {
    if (data) return;
    setTasks([]);
    setAudit([]);
    setWallet(null);
    setRuns((old) =>
      old.filter((run) => run.result?.readOnly && !run.created_at),
    );
  }, [data?.account.id]);
  useEffect(() => {
    if (provider || !data?.account.address || !config || !providers.length)
      return;
    let alive = true;
    const owner = data.account.address.toLowerCase();
    Promise.all(
      providers.map(async ({ provider: candidate }) => {
        let timer;
        try {
          const result = await Promise.race([
            Promise.all([
              candidate.request({ method: "eth_accounts" }),
              candidate.request({ method: "eth_chainId" }),
            ]),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(null), 3000);
            }),
          ]);
          return result?.[0]?.[0]?.toLowerCase() === owner &&
            Number(result[1]) === config.chainId
            ? candidate
            : null;
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      }),
    ).then((matches) => {
      const unique = [...new Set(matches.filter(Boolean))];
      // Only reattach an already authorized, unambiguous account/network.
      // Never request accounts, signatures or a network switch on page load.
      if (alive && unique.length === 1) setProvider(unique[0]);
    });
    return () => {
      alive = false;
    };
  }, [provider, providers, data?.account.address, config]);
  useEffect(() => {
    if (!provider || !data?.account.address || !config) return;
    const changed = () => {
      setProvider(null);
      setData(null);
      setModal(null);
      setWallet(null);
      setTasks([]);
      setRuns([]);
      setNotice({
        text: "ウォレットが変更されました。もう一度接続してください。",
      });
      logoutPending.current = api("/api/auth/logout", {}).catch(() => {});
    };
    const accountsChanged = (accounts) => {
      if (accounts?.[0]?.toLowerCase() !== data.account.address.toLowerCase())
        changed();
    };
    const chainChanged = (chainId) => {
      if (Number(chainId) !== config.chainId) changed();
    };
    provider.on?.("accountsChanged", accountsChanged);
    provider.on?.("chainChanged", chainChanged);
    provider.on?.("disconnect", changed);
    return () => {
      provider.removeListener?.("accountsChanged", accountsChanged);
      provider.removeListener?.("chainChanged", chainChanged);
      provider.removeListener?.("disconnect", changed);
    };
  }, [provider, data?.account.address, config]);
  async function action(message, fn) {
    setBusy(message);
    setNotice(null);
    try {
      await fn();
      await refresh();
    } catch (error) {
      setNotice({
        error: true,
        text: explain(error),
        details: walletErrorDetails(error),
      });
    } finally {
      setBusy("");
    }
  }
  async function login(p) {
    const returnTo = modal?.returnTo,
      returnAddress = modal?.returnAddress;
    await action("ウォレットでログインの署名を確認してください", async () => {
      await logoutPending.current;
      const connectedAddress = await connect(p, config);
      setProvider(p);
      if (
        returnTo &&
        returnAddress?.toLowerCase() === connectedAddress.toLowerCase()
      ) {
        setModal(returnTo);
        setNotice({
          text: "接続しました。内容を確認して、操作を続けてください。",
        });
      } else {
        setModal(null);
        if (returnTo)
          setNotice({
            text: "別のウォレットに接続しました。このウォレットで操作するAIを選び直してください。",
          });
      }
    });
  }
  const address = data?.account.address,
    connections = data?.connections ?? [],
    active = connections.filter(
      (c) =>
        c.status === "active" &&
        Number(c.permission?.validUntil) > Date.now() / 1000,
    ),
    budget = data?.policy?.document,
    spent = fromAtomic(data?.usage?.accountSpent),
    reserved = fromAtomic(data?.usage?.accountReserved),
    limit = fromAtomic(budget?.perPeriod),
    remaining = Math.max(0, limit - spent - reserved);
  const chosen =
    active.find((c) => c.id === selected && c.provider === "gemini") ??
    active.find((c) => c.provider === "gemini");
  const needProvider = (returnTo = modal) => {
    if (!provider || !data) {
      setModal({ kind: "wallet", returnTo, returnAddress: address });
      return false;
    }
    return true;
  };
  async function runAgent({
    requestId = crypto.randomUUID(),
    message,
    connectionId,
    mandateId,
    displayMessage,
  }) {
    setPendingRun({
      requestId,
      message,
      connectionId,
      mandateId,
      displayMessage,
    });
    try {
      return await api("/api/owner/runs", {
        requestId,
        message,
        ...(connectionId ? { connectionId } : {}),
        ...(mandateId ? { mandateId } : {}),
      });
    } finally {
      setPendingRun(null);
    }
  }
  async function ask(message = chat, mandateId) {
    if (!message.trim()) return;
    setChat("");
    await action("Geminiが確認しています", async () => {
      if (!data) {
        setPendingRun({ requestId: crypto.randomUUID(), message });
        try {
          const response = await api("/api/demo/runs", { message });
          setRuns((old) => [{ ...response, message }, ...old].slice(0, 10));
        } finally {
          setPendingRun(null);
        }
      } else {
        await runAgent({ message, connectionId: chosen?.id, mandateId });
      }
    });
  }
  async function approveOrder(intent) {
    await action("この注文への本人同意を準備しています", async () => {
      const approval = await api(
        "/api/owner/approvals/" + intent.id + "/prepare",
        {},
      );
      setModal({ kind: "exception", approval });
    });
  }
  const connectionCard = (c) => (
    <article key={c.id} className="agent-card">
      <div className="agent-top">
        <span
          className={
            "agent-icon " + (c.provider === "gemini" ? "gemini" : "external")
          }
        >
          {c.provider === "gemini" ? "G" : c.name.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <h3>{c.name}</h3>
          <span className="muted small">
            {c.provider === "gemini" ? "Google Gemini" : "接続済みの外部AI"}
          </span>
        </div>
        <Status
          state={c.permission_status === "revoked" ? "revoked" : c.status}
        />
      </div>
      <div className="agent-limits">
        <div>
          <span>1回の上限</span>
          <strong>
            {c.permission
              ? "¥" + yen(fromAtomic(c.permission.perOrder))
              : "未設定"}
          </strong>
        </div>
        <div>
          <span>24時間の上限</span>
          <strong>
            {c.permission
              ? "¥" + yen(fromAtomic(c.permission.perPeriod))
              : "未設定"}
          </strong>
        </div>
      </div>
      <p className="muted small">
        {c.permission
          ? `期限 ${new Date(c.permission.validUntil * 1000).toLocaleDateString("ja-JP")} · ${c.permission.merchants.length}店舗`
          : "予算・お店・期限を指定して、購入を任せます。"}
      </p>
      <div className="card-actions">
        <button
          className="text-button"
          onClick={() => setModal({ kind: "permission", connection: c })}
        >
          {c.pending_draft
            ? "登録を再開"
            : "権限を" + (c.permission ? "編集" : "設定")}{" "}
          <ArrowRight size={14} />
        </button>
        {c.status === "active" && (
          <button
            className="icon-button"
            aria-label={c.name + "を停止"}
            onClick={() =>
              action("新しい購入を停止しています", () =>
                api("/api/owner/connections/" + c.id + "/pause", {}),
              )
            }
          >
            <Pause size={16} />
          </button>
        )}
        {c.permission && (
          <button
            className="text-button danger"
            onClick={() => setModal({ kind: "revoke", connection: c })}
          >
            取り消す
          </button>
        )}
        {c.provider === "external" && c.status !== "revoked" && (
          <button
            className="text-button"
            disabled={!!busy}
            onClick={() =>
              action("接続tokenを更新しています", async () => {
                const result = await api(
                  `/api/owner/connections/${c.id}/token`,
                  {},
                );
                setModal({
                  kind: "token",
                  connection: { ...c, agentToken: result.agentToken },
                });
              })
            }
          >
            接続情報を再発行
          </button>
        )}
      </div>
    </article>
  );
  return (
    <div className="shell">
      <aside className="sidebar">
        <a href="/" className="logo-link" aria-label="yours ホーム">
          <Logo />
        </a>
        <div className="workspace-tag">Personal workspace</div>
        <nav>
          {[
            ["home", LayoutDashboard, "ホーム"],
            ["agents", Layers, "AIと権限"],
            ["activity", Activity, "アクティビティ"],
            ["guide", Code2, "接続ガイド"],
          ].map(([key, Icon, label]) => (
            <button
              key={key}
              className={tab === key ? "nav-item selected" : "nav-item"}
              onClick={() => setTab(key)}
            >
              <Icon size={19} />
              {label}
              {key === "agents" && connections.length > 0 && (
                <span className="nav-count">{connections.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <a
            href="https://github.com/Mameta29/yours"
            target="_blank"
            rel="noreferrer"
          >
            GitHub <ArrowUpRight size={14} />
          </a>
          <span className="small muted">Your AI. Your rules.</span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="mobile-brand">
            <Logo />
          </div>
          <div className="breadcrumb">
            ワークスペース <ChevronRight size={13} />
            <span>
              {tab === "home"
                ? "ホーム"
                : tab === "agents"
                  ? "AIと権限"
                  : tab === "activity"
                    ? "アクティビティ"
                    : "接続ガイド"}
            </span>
          </div>
          <div className="topbar-actions">
            <span className="network">
              <i />
              Polygon Amoy <span>テストネット</span>
            </span>
            <button
              className="button wallet-button"
              disabled={!config || !!busy}
              onClick={() => setModal({ kind: "wallet" })}
            >
              <Wallet size={16} />
              {address ? short(address) : "ウォレットを接続"}
            </button>
          </div>
        </header>
        <main>
          {notice && (
            <div
              className={"notice " + (notice.error ? "error" : "")}
              role="alert"
            >
              <AlertCircle size={17} />
              <NoticeText notice={notice} />
              <button
                className="icon-button"
                aria-label="通知を閉じる"
                onClick={() => setNotice(null)}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {busy && !pendingRun && (
            <div className="busy" role="status">
              <LoaderCircle size={17} className="spin" />
              {busy}
            </div>
          )}
          <div className="page-heading">
            <div>
              <h1>
                {tab === "home"
                  ? "買い物を、あなたの条件で。"
                  : tab === "agents"
                    ? "誰に、どこまで任せますか。"
                    : tab === "activity"
                      ? "AIの行動を、ひとつずつ。"
                      : "あなたのAIを、yoursにつなぐ。"}
              </h1>
              <p>
                {tab === "home"
                  ? "資産はあなたの手に。選んだAIに、必要な範囲だけを任せる。"
                  : tab === "agents"
                    ? "予算・お店・期限を設定。権限はいつでも停止できます。"
                    : tab === "activity"
                      ? "同意、購入、支払いの根拠を確認できます。"
                      : "UCPで商品を選び、AP2で同意を証明し、x402で支払います。"}
              </p>
            </div>
            {tab === "agents" && (
              <button
                className="button primary"
                disabled={!data || !!busy}
                onClick={() => setModal({ kind: "add" })}
              >
                <Plus size={16} />
                AIを追加
              </button>
            )}
          </div>
          {tab === "home" && (
            <HomeWorkspace
              {...{
                config,
                data,
                wallet,
                budget,
                remaining,
                limit,
                spent,
                reserved,
                connections,
                active,
                chosen,
                selected,
                setSelected,
                runs,
                pendingRun,
                tasks,
                audit,
                products,
                busy,
                chat,
                setChat,
                ask,
              }}
              onAdd={() => setModal({ kind: "add" })}
              onWallet={() => setModal({ kind: "wallet" })}
              onPermission={(connection) =>
                setModal({ kind: "permission", connection })
              }
              onPause={(connection) =>
                action("新しい購入を停止しています", () =>
                  api(`/api/owner/connections/${connection.id}/pause`, {}),
                )
              }
              onPurchase={(product) =>
                data && active.length
                  ? setModal({ kind: "purchase", product })
                  : setNotice({
                      text: "先にウォレットを接続し、AIの権限を設定してください。",
                    })
              }
              onOpen={(intent) =>
                setModal({ kind: "order", intentId: intent.id })
              }
              onApprove={approveOrder}
              onAgents={() => setTab("agents")}
              onActivity={() => setTab("activity")}
              onRunTask={(task, agent) =>
                action("Geminiが依頼を確認しています", () =>
                  runAgent({
                    connectionId: agent.id,
                    mandateId: task.id,
                    message: `承認した依頼 ${task.id} を実行してください。`,
                  }),
                )
              }
              onRevokeTask={(task) =>
                action("依頼を取り消しています", () =>
                  api(`/api/owner/tasks/${task.id}/revoke`, {}),
                )
              }
              onCopyTask={(task) =>
                action("依頼IDをコピーしています", async () => {
                  await navigator.clipboard.writeText(task.id);
                  setNotice({
                    text: "依頼IDをコピーしました。接続した外部AIから実行できます。",
                  });
                })
              }
            />
          )}
          {tab === "agents" && (
            <>
              <div className="agent-grid">
                {connections.map(connectionCard)}
                <button
                  className="add-agent"
                  disabled={!data}
                  onClick={() => setModal({ kind: "add" })}
                >
                  <Plus size={24} />
                  <strong>新しいAIを追加</strong>
                  <span>Gemini、または外部サービス</span>
                </button>
              </div>
              <div className="principles">
                <div>
                  <ShieldCheck />
                  <h3>資産はあなたのウォレットに</h3>
                  <p>
                    AIのアドレスは実行者の識別に使います。購入資金を預ける必要はありません。
                  </p>
                </div>
                <div>
                  <Layers />
                  <h3>AIをまたいで予算を共有</h3>
                  <p>
                    別のAIや新しい鍵に切り替えても、使用済みの予算は引き継ぎます。
                  </p>
                </div>
                <div>
                  <Pause />
                  <h3>判断を、あなたに戻せる</h3>
                  <p>
                    条件を超えた注文には、その注文専用の新しい本人署名が必要です。
                  </p>
                </div>
              </div>
            </>
          )}
          {tab === "activity" && (
            <>
              <IntentList
                intents={data?.intents ?? []}
                onApprove={approveOrder}
                onOpen={(intent) =>
                  setModal({ kind: "order", intentId: intent.id })
                }
              />
              <div className="section-heading">
                <h2>同意と操作の記録</h2>
                <button
                  className="text-button"
                  onClick={() => action("記録を更新しています", refresh)}
                >
                  <RefreshCw size={14} />
                  更新
                </button>
              </div>
              <div className="audit-list">
                {audit.length ? (
                  audit.map((e) => (
                    <div key={e.sequence}>
                      <span className="audit-dot" />
                      <div>
                        <strong>{auditLabels[e.action] ?? e.action}</strong>
                        <small>
                          {e.actor.startsWith("owner:")
                            ? "本人"
                            : e.actor.startsWith("agent:")
                              ? "AI"
                              : e.actor}{" "}
                          · {new Date(e.created_at).toLocaleString("ja-JP")}
                        </small>
                      </div>
                      <span>#{e.sequence}</span>
                    </div>
                  ))
                ) : (
                  <p className="empty-line">操作の記録はここに表示されます。</p>
                )}
              </div>
            </>
          )}
          {tab === "guide" && (
            <div className="guide">
              <article>
                <Code2 size={25} />
                <h2>同じ仕組みを、あなたのAIにも。</h2>
                <p>
                  yoursは特定のECやAIに依存しない委任決済基盤です。本人がAIの実行アドレスを登録し、購入条件に署名します。
                </p>
                <div className="protocol-flow">
                  {[
                    "UCP · 商品と会計",
                    "AP2 · 同意の証拠",
                    "x402 · 支払要求",
                    "Gate · 条件の強制",
                  ].map((v) => (
                    <span key={v}>{v}</span>
                  ))}
                </div>
                <a
                  className="button primary"
                  href="/payment-handler"
                  target="_blank"
                  rel="noreferrer"
                >
                  接続仕様を読む <ArrowUpRight size={15} />
                </a>
                <a
                  className="button"
                  href="/.well-known/ucp"
                  target="_blank"
                  rel="noreferrer"
                >
                  UCPプロファイル <ArrowUpRight size={15} />
                </a>
              </article>
              <article>
                <h2>検証できる、支払い。</h2>
                <p>
                  決済はPolygon
                  Amoy上のテストJPYCを使います。送金の確定、宛先、金額を照合した後に注文を確定します。支払済みの取引はExplorerから追跡できます。
                </p>
                <a
                  href="https://github.com/Mameta29/yours"
                  target="_blank"
                  rel="noreferrer"
                >
                  ソースコードと検証記録 <ArrowUpRight size={14} />
                </a>
              </article>
            </div>
          )}
          <footer>
            <span>AI works for you.</span>
            <div>
              <a href="/privacy">プライバシー</a>
              <a href="/terms">利用条件</a>
              <span>Built on Google Cloud</span>
            </div>
          </footer>
        </main>
      </div>
      {modal && (
        <ModalFrame busy={busy} onClose={() => setModal(null)}>
          <ModalContent
            key={
              modal.kind +
              ":" +
              (modal.connection?.id ?? modal.intentId ?? modal.orderId ?? "")
            }
            {...{
              modal,
              setModal,
              config,
              data,
              provider,
              providers,
              login,
              action,
              busy,
              setBusy,
              chosen,
              needProvider,
              ask,
              runAgent,
              tasks,
              setNotice,
            }}
          />
          {busy && (
            <div className="notice" role="status">
              <LoaderCircle className="spin" size={18} />
              {busy}
            </div>
          )}
          {notice && (
            <div
              className={"notice " + (notice.error ? "error" : "")}
              role="alert"
            >
              <NoticeText notice={notice} />
            </div>
          )}
        </ModalFrame>
      )}
    </div>
  );
}
function ModalFrame({ busy, onClose, children }) {
  const ref = useRef(null),
    state = useRef({ busy, onClose });
  state.current = { busy, onClose };
  useEffect(() => {
    const previous = document.activeElement,
      dialog = ref.current;
    const selector =
      'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]';
    (dialog.querySelector(selector) ?? dialog).focus();
    const key = (e) => {
      if (e.key === "Escape" && !state.current.busy) {
        e.preventDefault();
        state.current.onClose();
      }
      if (e.key === "Tab") {
        const elements = [...dialog.querySelectorAll(selector)].filter(
          (el) => el.getClientRects().length,
        );
        const first = elements[0] ?? dialog,
          last = elements.at(-1) ?? dialog;
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            !dialog.contains(document.activeElement))
        ) {
          e.preventDefault();
          last.focus();
        } else if (
          !e.shiftKey &&
          (document.activeElement === last ||
            !dialog.contains(document.activeElement))
        ) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
      >
        <button
          className="close icon-button"
          aria-label="閉じる"
          disabled={!!busy}
          onClick={onClose}
        >
          <X size={21} />
        </button>
        {children}
      </section>
    </div>
  );
}
function IntentList({ intents, onApprove, onOpen }) {
  return (
    <div className="intent-list">
      {intents.length ? (
        intents.map((i) => (
          <div className="intent-row" key={i.id}>
            <span className={"intent-icon " + i.state}>
              <FileText size={19} />
            </span>
            <div>
              <strong>
                {i.merchant_name ??
                  (i.merchant_id === "yours-lab"
                    ? "yours Market"
                    : i.merchant_id)}
              </strong>
              <small>{new Date(i.created_at).toLocaleString("ja-JP")}</small>
            </div>
            <Status state={i.state} />
            <strong>¥{yen(Number(i.amount_minor))}</strong>
            {i.state === "approval_required" && (
              <button
                className="button small-button"
                onClick={() => onApprove(i)}
              >
                内容を確認
              </button>
            )}
            {i.state !== "approval_required" && (
              <button className="button small-button" onClick={() => onOpen(i)}>
                注文を開く
              </button>
            )}
            {i.transaction_hash && (
              <a
                className="icon-button"
                aria-label="取引をExplorerで見る"
                target="_blank"
                rel="noreferrer"
                href={"https://amoy.polygonscan.com/tx/" + i.transaction_hash}
              >
                <ArrowUpRight size={17} />
              </a>
            )}
          </div>
        ))
      ) : (
        <div className="empty-line">
          購入すると、進行状況と支払記録がここに表示されます。
        </div>
      )}
    </div>
  );
}
function ModalContent({
  modal,
  setModal,
  config,
  data,
  provider,
  providers,
  login,
  action,
  busy,
  setBusy,
  chosen,
  needProvider,
  ask,
  runAgent,
  tasks,
  setNotice,
}) {
  const [name, setName] = useState("My Gemini"),
    [type, setType] = useState("gemini"),
    [agentAddress, setAgentAddress] = useState(""),
    [jwk, setJwk] = useState(""),
    [permissionDraft, setPermissionDraft] = useState(null),
    [draftLoading, setDraftLoading] = useState(modal.kind === "permission"),
    [checked, setChecked] = useState(false),
    [quantity, setQuantity] = useState(modal.form?.quantity ?? 1),
    [email, setEmail] = useState(modal.form?.email ?? ""),
    purchaseRequest = useRef(modal.form?.purchaseRequest ?? null),
    [purchaseConnection, setPurchaseConnection] = useState(
      modal.form?.purchaseConnection ?? chosen?.id ?? "",
    ),
    [settings, setSettings] = useState(
      modal.form?.settings ?? {
        perOrder: modal.connection?.permission
          ? fromAtomic(modal.connection.permission.perOrder)
          : 2000,
        perPeriod: modal.connection?.permission
          ? fromAtomic(modal.connection.permission.perPeriod)
          : 5000,
        globalPerOrder: data?.policy
          ? fromAtomic(data.policy.document.perOrder)
          : 3000,
        globalPerPeriod: data?.policy
          ? fromAtomic(data.policy.document.perPeriod)
          : 10000,
        days: 7,
        merchants:
          modal.connection?.permission?.merchants.map((m) => m.id) ??
          (config?.merchant?.id ? [config.merchant.id] : []),
      },
    );
  const address = data?.account.address;
  useEffect(() => {
    if (modal.kind !== "permission") return;
    let alive = true;
    api(`/api/owner/permissions/connections/${modal.connection.id}/draft`)
      .then(({ draft }) => {
        if (!alive) return;
        setPermissionDraft(draft);
        if (draft?.input) setSettings(draft.input);
      })
      .catch((error) => {
        if (alive) setNotice({ error: true, text: explain(error) });
      })
      .finally(() => {
        if (alive) setDraftLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [modal.kind, modal.connection?.id]);
  if (modal.kind === "order")
    return (
      <OrderDetails {...{ modal, data, setModal, action, busy, Status }} />
    );
  if (modal.kind === "wallet")
    return (
      <>
        <span className="modal-symbol">
          <Wallet />
        </span>
        <h2 id="modal-title">あなたのウォレットを接続</h2>
        <p>ログインの署名では、資産の移動や購入権限の付与は行われません。</p>
        {modal.returnTo && (
          <p className="notice">
            同じウォレットに接続すると、入力した内容を保って元の画面へ戻ります。
          </p>
        )}
        {providers.length ? (
          providers.map((p) => (
            <button
              className="wallet-option"
              key={p.info.uuid}
              onClick={() => login(p.provider)}
              disabled={!!busy}
            >
              <Wallet size={19} />
              {p.info.name}
              <ArrowRight size={18} />
            </button>
          ))
        ) : (
          <div className="notice">
            ブラウザのウォレットを検出できませんでした。PCの対応ウォレット拡張を有効にしてください。
          </div>
        )}
        {data && (
          <button
            className="text-button"
            onClick={() =>
              action("接続を解除しています", async () => {
                await api("/api/auth/logout", {});
                setModal(null);
              })
            }
          >
            <LogOut size={15} />
            ログアウト
          </button>
        )}
        <p className="small muted">
          ネットワーク：{config.network} / {config.chainId}
        </p>
      </>
    );
  if (modal.kind === "add")
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          action("AIを登録しています", async () => {
            const result = await api("/api/owner/connections", {
              name,
              provider: type,
              ...(type === "external"
                ? { agentAddress, ap2PublicJwk: JSON.parse(jwk) }
                : {}),
            });
            setModal(
              type === "external"
                ? { kind: "token", connection: result }
                : { kind: "permission", connection: result },
            );
          });
        }}
      >
        <span className="modal-symbol">
          <Layers />
        </span>
        <h2 id="modal-title">AIを追加する</h2>
        <p>実行するAIを選び、あとから購入の範囲を指定します。</p>
        <label>
          サービス
          <select
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setName(e.target.value === "gemini" ? "My Gemini" : "My agent");
            }}
          >
            <option value="gemini">Gemini · yoursで実行</option>
            <option value="external">外部のAIサービス</option>
          </select>
        </label>
        <label>
          表示名
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            required
          />
        </label>
        {type === "external" && (
          <>
            <label>
              AIの実行アドレス
              <input
                placeholder="0x…"
                pattern="0x[0-9a-fA-F]{40}"
                value={agentAddress}
                onChange={(e) => setAgentAddress(e.target.value)}
                required
              />
            </label>
            <label>
              AP2の公開鍵（P-256 JWK）
              <textarea
                value={jwk}
                onChange={(e) => setJwk(e.target.value)}
                required
                placeholder={'{"kty":"EC","crv":"P-256",…}'}
              />
            </label>
            <p className="small muted">秘密鍵は入力しないでください。</p>
          </>
        )}
        <button className="button primary full" disabled={!!busy}>
          登録して権限を設定 <ArrowRight size={16} />
        </button>
      </form>
    );
  if (modal.kind === "token")
    return (
      <>
        <h2 id="modal-title">外部AIの接続情報</h2>
        <p>
          トークンはこの画面で一度だけ表示します。サービスの安全な設定先に保存してください。
        </p>
        <code className="token-value">{modal.connection.agentToken}</code>
        <button
          className="button"
          onClick={() =>
            navigator.clipboard.writeText(modal.connection.agentToken)
          }
        >
          <Copy size={15} />
          コピー
        </button>
        <button
          className="button primary"
          onClick={() =>
            setModal({ kind: "permission", connection: modal.connection })
          }
        >
          権限を設定する
        </button>
      </>
    );
  if (modal.kind === "permission")
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!needProvider({ ...modal, form: { settings } })) return;
          action("購入権限を設定しています", async () => {
            await registerPermission({
              provider,
              address,
              config,
              connection: modal.connection,
              settings,
              progress: setBusy,
            });
            setModal(null);
            setNotice({
              text: "購入権限を登録しました。商品を選んで、AIへの依頼を作成できます。",
            });
          });
        }}
      >
        <span className="modal-symbol">
          <ShieldCheck />
        </span>
        <h2 id="modal-title">{modal.connection.name}に任せる範囲</h2>
        <p>支出は本人のウォレットから行われます。</p>
        <p className="small muted">
          初回のウォレット設定も、このボタンから始められます。表示されるMetaMaskの確認画面で承認してください。
        </p>
        {permissionDraft && (
          <p className="notice">
            前回確認した条件で登録を再開します。成功済みの取引は再送しません。
          </p>
        )}
        <div className="form-grid">
          {[
            ["perOrder", "このAI：1回の上限"],
            ["perPeriod", "このAI：24時間の上限"],
            ["globalPerOrder", "すべてのAI：1回の上限"],
            ["globalPerPeriod", "すべてのAI：24時間の上限"],
          ].map(([key, label]) => (
            <label key={key}>
              {label}
              <div className="money-input">
                <span>¥</span>
                <input
                  type="number"
                  disabled={draftLoading || !!permissionDraft}
                  min="0"
                  max="10000000"
                  required
                  value={settings[key]}
                  onChange={(e) =>
                    setSettings({ ...settings, [key]: Number(e.target.value) })
                  }
                />
              </div>
            </label>
          ))}
        </div>
        <fieldset className="merchant-choices">
          <legend>購入を許可するお店</legend>
          {(config.merchants ?? [config.merchant]).map((merchant) => (
            <label className="check-label" key={merchant.id}>
              <input
                type="checkbox"
                disabled={draftLoading || !!permissionDraft}
                checked={settings.merchants?.includes(merchant.id) ?? false}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    merchants: e.target.checked
                      ? [...(settings.merchants ?? []), merchant.id]
                      : (settings.merchants ?? []).filter(
                          (id) => id !== merchant.id,
                        ),
                  })
                }
              />
              {merchant.name}
              {merchant.adapter === "jpyc-ec"
                ? "（外部EC・Amoy）"
                : "（yours）"}
            </label>
          ))}
        </fieldset>
        <label>
          期限
          <select
            disabled={draftLoading || !!permissionDraft}
            value={settings.days}
            onChange={(e) =>
              setSettings({ ...settings, days: Number(e.target.value) })
            }
          >
            <option value={1}>1日間</option>
            <option value={7}>7日間</option>
            <option value={30}>30日間</option>
          </select>
        </label>
        <details className="permission-details">
          <summary>ウォレットに付与する権限について</summary>
          <p>
            委任そのものは期間内の上限なしで作成し、専用コントラクトが上記の予算・店舗・期限を強制します。通常条件を超える支払いには、その注文専用の新しい本人署名が必要です。送金先は注文の署名で固定されます。
          </p>
          <p>
            登録には署名と2件のオンチェーン取引が必要です。ウォレットにテスト用POLをご用意ください。既存の共有予算がある場合、更新前の期間と期限を引き継ぎます。
          </p>
        </details>
        <label className="check-label">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            required
          />
          この条件で購入を任せることを確認しました
        </label>
        <button
          className="button primary full"
          disabled={!checked || !!busy || draftLoading}
        >
          {permissionDraft ? "残りの登録を進める" : "ウォレットで承認する"}{" "}
          <ArrowRight size={16} />
        </button>
      </form>
    );
  if (modal.kind === "purchase") {
    const p = modal.product,
      amount = p.price_range.min.amount * quantity;
    const available = data.connections.filter(
      (c) =>
        c.status === "active" && c.permission?.validUntil > Date.now() / 1000,
    );
    const buyer =
      available.find((c) => c.id === purchaseConnection) ?? available[0];
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (
            !needProvider({
              ...modal,
              form: {
                quantity,
                email,
                purchaseConnection,
                purchaseRequest: purchaseRequest.current,
              },
            })
          )
            return;
          action("この購入への同意を準備しています", async () => {
            const formKey = JSON.stringify({
              connectionId: buyer.id,
              productId: p.id,
              quantity,
              email,
            });
            if (purchaseRequest.current?.key !== formKey)
              purchaseRequest.current = {
                key: formKey,
                id: crypto.randomUUID(),
              };
            const task = await api("/api/owner/tasks/prepare", {
              connectionId: buyer.id,
              merchantId: p.metadata?.merchant_id ?? config.merchant.id,
              ...(p.metadata?.external
                ? { email, requestId: purchaseRequest.current.id }
                : {}),
              items: [{ id: p.id, quantity }],
              maxAmount: amount,
              minutes: 60,
            });
            let approved;
            if (task.authorizedMandateId)
              approved = { id: task.authorizedMandateId };
            else {
              let transferSignature;
              if (
                task.transferAuthorization &&
                !task.transferAuthorization.authorized
              ) {
                setBusy("店舗の注文予約をウォレットで確認してください");
                transferSignature = await personal(
                  provider,
                  address,
                  config.chainId,
                  task.transferAuthorization.message,
                );
              }
              setBusy("この購入をAIに任せる同意を確認してください");
              const signature = await typed(
                provider,
                address,
                config.chainId,
                task.typedData,
              );
              approved = await api("/api/owner/tasks/" + task.id + "/approve", {
                signature,
                ...(transferSignature ? { transferSignature } : {}),
              });
            }
            setModal(null);
            if (buyer.provider !== "gemini") {
              setNotice({
                text: `${buyer.name}への依頼を承認しました。依頼ID: ${approved.id}。接続したAIから実行できます。`,
              });
              return;
            }
            await runAgent({
              displayMessage: `「${p.title}」の購入を${buyer.name}に依頼`,
              connectionId: buyer.id,
              mandateId: approved.id,
              message:
                "承認した依頼 " +
                approved.id +
                " を実行してください。完了または本人の確認が必要になったら教えてください。",
            });
          });
        }}
      >
        <span className="modal-symbol">
          <FileText />
        </span>
        <h2 id="modal-title">この購入を任せる</h2>
        <p>指定した商品と金額の範囲で、一回の購入に同意します。</p>
        <div className="purchase-summary">
          <strong>{p.title}</strong>
          <p>{p.description.plain}</p>
          <span>{p.metadata?.merchant_name ?? config.merchant.name}</span>
        </div>
        <label>
          この購入を任せるAI
          <select
            value={buyer?.id ?? ""}
            onChange={(e) => setPurchaseConnection(e.target.value)}
          >
            {available.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {p.metadata?.external && (
          <label>
            注文確認メールの宛先
            <input
              type="email"
              required
              maxLength="254"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={!!busy}
            />
            <small>この店舗へ送信します。AIへの依頼には含めません。</small>
          </label>
        )}
        <label>
          数量
          <input
            type="number"
            min="1"
            max="10"
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
          />
        </label>
        <div className="total">
          <span>支払う金額の上限</span>
          <strong>
            ¥{yen(amount)} <small>JPYC</small>
          </strong>
        </div>
        <p className="small muted">
          {p.metadata?.external
            ? "外部ECのAmoy検証商品です。予約の本人確認とAIへの購入同意を順に確認します。実物の発送はありません。"
            : "Amoyのテスト商品です。ウォレットでの署名後、AIが会計と支払いを進めます。"}
        </p>
        <button className="button primary full" disabled={!!busy || !buyer}>
          署名して、この購入を任せる <ArrowRight size={16} />
        </button>
      </form>
    );
  }
  if (modal.kind === "exception")
    return (
      <>
        <span className="modal-symbol amber">
          <AlertCircle />
        </span>
        <h2 id="modal-title">この注文だけ、許可しますか</h2>
        <p>
          通常の条件を超えています。許可しても、AI全体の上限は変わりません。
        </p>
        <div className="purchase-summary">
          <strong>{modal.approval.merchant.name}</strong>
          <p>
            {modal.approval.reasons
              .map(
                (r) =>
                  ({
                    period_budget: "期間予算の超過",
                    per_order: "1回の上限超過",
                    merchant: "許可範囲外のお店",
                  })[r] ?? r,
              )
              .join("・")}
          </p>
          <div className="total">
            <span>今回の支払い</span>
            <strong>¥{yen(modal.approval.amount)}</strong>
          </div>
        </div>
        <button
          className="button primary full"
          disabled={!!busy}
          onClick={() => {
            if (!needProvider()) return;
            action("今回だけの同意を確認しています", async () => {
              const signature = await typed(
                provider,
                address,
                config.chainId,
                modal.approval.typedData,
              );
              await api(
                "/api/owner/approvals/" + modal.approval.id + "/approve",
                { signature },
              );
              setModal(null);
              setNotice({
                text: "この注文への同意を記録しました。アシスタントに購入の再開を依頼できます。",
              });
            });
          }}
        >
          署名して、一件だけ許可
        </button>
      </>
    );
  if (modal.kind === "revoke")
    return (
      <>
        <span className="modal-symbol">
          <Pause />
        </span>
        <h2 id="modal-title">{modal.connection.name}の権限を取り消す</h2>
        <p>
          新しい購入をすぐに停止し、ウォレットでの承認後にチェーン上の権限も取り消します。送信済みの取引は、確定まで追跡します。
        </p>
        <button
          className="button primary full"
          disabled={!!busy}
          onClick={() => {
            if (!needProvider()) return;
            action("権限を取り消しています", async () => {
              await revokePermission({
                provider,
                address,
                config,
                connection: modal.connection,
                progress: setBusy,
              });
              setModal(null);
            });
          }}
        >
          停止して、取り消しを承認
        </button>
      </>
    );
}
createRoot(document.getElementById("root")).render(<App />);
