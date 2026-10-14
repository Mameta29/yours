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
  Send,
  X,
  LoaderCircle,
  Sparkles,
  FileText,
  LockKeyhole,
  ExternalLink,
  RefreshCw,
  AlertCircle,
  LogOut,
  Copy,
} from "lucide-react";
import { api, explain, short, yen, fromAtomic } from "./api";
import OrderDetails from "./OrderDetails";
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
    yours<span className="brand-star">✳</span>
  </span>
);
const Status = ({ state }) => (
  <span className={"status " + state}>
    <i />
    {states[state] ?? state}
  </span>
);
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
    [audit, setAudit] = useState([]),
    [chat, setChat] = useState(""),
    [selected, setSelected] = useState(""),
    [wallet, setWallet] = useState(null);
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
    const timer = setInterval(() => refresh().catch(() => {}), 8000);
    return () => clearInterval(timer);
  }, [data?.account.id, refresh]);
  useEffect(() => {
    if (!data) return;
    api("/api/owner/permissions/wallet")
      .then(setWallet)
      .catch(() => {});
  }, [data?.account.id, data?.policy?.activation_tx]);
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
    if (!provider) return;
    const changed = () => {
      setData(null);
      setWallet(null);
      setTasks([]);
      setRuns([]);
      setNotice({
        text: "ウォレットが変更されました。もう一度接続してください。",
      });
      api("/api/auth/logout", {}).catch(() => {});
    };
    provider.on?.("accountsChanged", changed);
    provider.on?.("chainChanged", changed);
    provider.on?.("disconnect", changed);
    return () => {
      provider.removeListener?.("accountsChanged", changed);
      provider.removeListener?.("chainChanged", changed);
      provider.removeListener?.("disconnect", changed);
    };
  }, [provider]);
  async function action(message, fn) {
    setBusy(message);
    setNotice(null);
    try {
      await fn();
      await refresh();
    } catch (error) {
      setNotice({ error: true, text: explain(error) });
    } finally {
      setBusy("");
    }
  }
  async function login(p) {
    await action("ウォレットでログインの署名を確認してください", async () => {
      await connect(p, config);
      setProvider(p);
      setModal(null);
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
  const needProvider = () => {
    if (!provider) {
      setModal({ kind: "wallet" });
      return false;
    }
    return true;
  };
  async function ask(message = chat, mandateId) {
    if (!message.trim()) return;
    setChat("");
    await action("Geminiが確認しています", async () => {
      if (!data) {
        const response = await api("/api/demo/runs", { message });
        setRuns((old) => [{ ...response, message }, ...old].slice(0, 10));
      } else {
        await api("/api/owner/runs", {
          requestId: crypto.randomUUID(),
          message,
          ...(chosen ? { connectionId: chosen.id } : {}),
          ...(mandateId ? { mandateId } : {}),
        });
      }
    });
  }
  async function approveOrder(intent) {
    if (!needProvider()) return;
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
          <Sparkles size={23} />
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
        <div className="workspace-tag">
          <span className="workspace-icon">Y</span>
          <div>
            あなたのワークスペース<small>Personal account</small>
          </div>
        </div>
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
          <div className="security-note">
            <ShieldCheck size={18} />
            <span>
              資産の持ち主は、
              <br />
              <strong>いつもあなたです。</strong>
            </span>
          </div>
          <a
            href="https://github.com/Mameta29/yours"
            target="_blank"
            rel="noreferrer"
          >
            GitHub <ArrowUpRight size={14} />
          </a>
          <span className="small muted">Google Cloud Hackathon · 2026</span>
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
              {notice.text}
              <button
                className="icon-button"
                aria-label="通知を閉じる"
                onClick={() => setNotice(null)}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {busy && (
            <div className="busy" role="status">
              <LoaderCircle size={17} className="spin" />
              {busy}
            </div>
          )}
          <div className="page-heading">
            <div>
              <span className="eyebrow">YOUR AI. YOUR RULES.</span>
              <h1>
                {tab === "home"
                  ? "任せる範囲を、あなたが決める。"
                  : tab === "agents"
                    ? "誰に、どこまで任せますか。"
                    : tab === "activity"
                      ? "AIの行動を、ひとつずつ。"
                      : "あなたのAIを、yoursにつなぐ。"}
              </h1>
              <p>
                {tab === "home"
                  ? "AIに買い物を任せても、資産と決定権はあなたの手に。"
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
            <>
              <section className="summary-grid">
                <div className="summary-card balance">
                  <div className="summary-label">
                    共有予算の残り <span className="badge">24時間ごと</span>
                  </div>
                  <div className="big-number">
                    {budget ? "¥" + yen(remaining) : "—"}
                    <span>
                      {budget ? "/ ¥" + yen(limit) : "予算を設定してください"}
                    </span>
                  </div>
                  <div className="budget-bar">
                    <i
                      style={{
                        width: limit
                          ? Math.min(100, ((spent + reserved) / limit) * 100) +
                            "%"
                          : "0%",
                      }}
                    />
                  </div>
                  <div className="small muted">
                    {budget
                      ? `支払済み ¥${yen(spent)} · 確定待ち ¥${yen(reserved)}`
                      : "複数のAIでも、使える総額はひとつ。"}
                  </div>
                </div>
                <div className="summary-card">
                  <span className="summary-label">
                    購入を任せているAI <Layers size={18} />
                  </span>
                  <div className="big-number">
                    {active.length}
                    <span>サービス</span>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => setTab("agents")}
                  >
                    権限を確認する <ArrowUpRight size={15} />
                  </button>
                </div>
                <div className="summary-card">
                  <span className="summary-label">
                    本人ウォレット <ShieldCheck size={18} />
                  </span>
                  <div className="big-number">
                    {wallet ? "¥" + yen(fromAtomic(wallet.balance)) : "—"}
                    <span>JPYC</span>
                  </div>
                  <span className="small muted">
                    AIへの事前送金は不要です。
                  </span>
                </div>
              </section>
              <div className="home-grid">
                <div className="main-column">
                  <section>
                    <div className="section-heading">
                      <h2>あなたのAI</h2>
                      <button
                        className="text-button"
                        disabled={!data}
                        onClick={() => setModal({ kind: "add" })}
                      >
                        <Plus size={15} />
                        追加する
                      </button>
                    </div>
                    {connections.length ? (
                      <div className="agent-grid">
                        {connections.map(connectionCard)}
                      </div>
                    ) : (
                      <div className="empty-card">
                        <span className="empty-mark">
                          <Sparkles size={27} />
                        </span>
                        <h3>最初のAIに、役割を。</h3>
                        <p>
                          ウォレットを接続し、Geminiに任せる
                          <br />
                          買い物の範囲を設定しましょう。
                        </p>
                        <button
                          className="button primary"
                          disabled={!config || !!busy}
                          onClick={() =>
                            setModal({ kind: data ? "add" : "wallet" })
                          }
                        >
                          {data ? "AIを追加する" : "ウォレットを接続"}
                          <ArrowRight size={16} />
                        </button>
                      </div>
                    )}
                  </section>
                  <section>
                    <div className="section-heading">
                      <h2>購入を依頼する</h2>
                      <span className="small muted">
                        Amoy検証ストア · テスト商品
                      </span>
                    </div>
                    <div className="products">
                      {products.map((p) => (
                        <button
                          key={p.id}
                          className="product"
                          disabled={!p.variants[0].availability.available}
                          onClick={() =>
                            data && active.length
                              ? setModal({ kind: "purchase", product: p })
                              : setNotice({
                                  text: "先にウォレットを接続し、AIの権限を設定してください。",
                                })
                          }
                        >
                          <span className="product-art">
                            <FileText size={33} />
                            <span>
                              {p.metadata?.external
                                ? "CONNECTED / EC"
                                : "YOURS / DIGITAL"}
                            </span>
                          </span>
                          <div>
                            <h3>{p.title}</h3>
                            <small>
                              {p.metadata?.merchant_name ?? "yours Market"}
                              {!p.variants[0].availability.available
                                ? " · 現在は購入できません"
                                : ""}
                            </small>
                            <p>{p.description.plain}</p>
                            <strong>
                              ¥{yen(p.price_range.min.amount)} <span>JPYC</span>
                            </strong>
                            <ArrowUpRight size={17} />
                          </div>
                        </button>
                      ))}
                    </div>
                    {!products.length && (
                      <div className="empty-line">
                        商品カタログを準備しています。
                      </div>
                    )}
                  </section>
                  {tasks.some(
                    (t) =>
                      !t.intent_id &&
                      !t.revoked_at &&
                      new Date(t.expires_at).getTime() > Date.now(),
                  ) && (
                    <section>
                      <div className="section-heading">
                        <h2>承認済みの依頼</h2>
                      </div>
                      <div className="approved-tasks">
                        {tasks
                          .filter(
                            (t) =>
                              !t.intent_id &&
                              !t.revoked_at &&
                              new Date(t.expires_at).getTime() > Date.now(),
                          )
                          .map((t) => {
                            const agent = connections.find(
                              (c) => c.id === t.connection_id,
                            );
                            return (
                              <article className="approved-task" key={t.id}>
                                <div>
                                  <strong>
                                    {t.task.items
                                      .map((i) => i.title)
                                      .join("、")}
                                  </strong>
                                  <p className="small muted">
                                    {agent?.name} · 上限 ¥
                                    {yen(t.task.max_amount)} ·{" "}
                                    {new Date(t.expires_at).toLocaleTimeString(
                                      "ja-JP",
                                      { hour: "2-digit", minute: "2-digit" },
                                    )}
                                    まで
                                  </p>
                                </div>
                                <div className="card-actions">
                                  {agent?.provider === "gemini" ? (
                                    <button
                                      className="text-button"
                                      disabled={
                                        !!busy || agent.status !== "active"
                                      }
                                      onClick={() =>
                                        action(
                                          "Geminiが依頼を確認しています",
                                          () =>
                                            api("/api/owner/runs", {
                                              requestId: crypto.randomUUID(),
                                              connectionId: agent.id,
                                              mandateId: t.id,
                                              message: `承認した依頼 ${t.id} を実行してください。`,
                                            }),
                                        )
                                      }
                                    >
                                      AIで実行 <ArrowRight size={14} />
                                    </button>
                                  ) : (
                                    <button
                                      className="text-button"
                                      onClick={() =>
                                        action(
                                          "依頼IDをコピーしています",
                                          async () => {
                                            await navigator.clipboard.writeText(
                                              t.id,
                                            );
                                            setNotice({
                                              text: "依頼IDをコピーしました。接続した外部AIから実行できます。",
                                            });
                                          },
                                        )
                                      }
                                    >
                                      依頼IDをコピー <Copy size={14} />
                                    </button>
                                  )}
                                  <button
                                    className="text-button danger"
                                    disabled={!!busy}
                                    onClick={() =>
                                      action("依頼を取り消しています", () =>
                                        api(
                                          `/api/owner/tasks/${t.id}/revoke`,
                                          {},
                                        ),
                                      )
                                    }
                                  >
                                    依頼を取り消す
                                  </button>
                                </div>
                              </article>
                            );
                          })}
                      </div>
                    </section>
                  )}
                  <section>
                    <div className="section-heading">
                      <h2>最近の購入</h2>
                      <button
                        className="text-button"
                        onClick={() => setTab("activity")}
                      >
                        すべて見る <ArrowUpRight size={14} />
                      </button>
                    </div>
                    <IntentList
                      intents={data?.intents.slice(0, 5) ?? []}
                      onApprove={approveOrder}
                      onOpen={(intent) =>
                        setModal({ kind: "order", intentId: intent.id })
                      }
                    />
                  </section>
                </div>
                <aside className="assistant-panel">
                  <div className="assistant-header">
                    <span className="agent-icon gemini">
                      <Sparkles size={22} />
                    </span>
                    <div>
                      <h2>あなたのアシスタント</h2>
                      <span className="small muted">Gemini · Google Cloud</span>
                    </div>
                  </div>
                  {active.filter((c) => c.provider === "gemini").length > 1 && (
                    <select
                      aria-label="会話するAI"
                      value={chosen?.id ?? ""}
                      onChange={(e) => setSelected(e.target.value)}
                    >
                      {active
                        .filter((c) => c.provider === "gemini")
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </select>
                  )}
                  <div className="chat-messages">
                    {runs.length === 0 ? (
                      <div className="assistant-intro">
                        <span className="mini-star">✳</span>
                        <h3>
                          次のひと仕事、
                          <br />
                          任せてみませんか。
                        </h3>
                        <p>
                          カタログを調べて、購入候補をご案内します。支払いは、あなたが署名した依頼の範囲だけ。
                        </p>
                        <button
                          onClick={() =>
                            setChat("カタログの商品と価格を教えて")
                          }
                          className="prompt"
                        >
                          カタログの商品と価格を教えて{" "}
                          <ArrowUpRight size={14} />
                        </button>
                      </div>
                    ) : (
                      [...runs].reverse().map((r) => (
                        <div key={r.id} className="chat-turn">
                          <div className="user-message">{r.message}</div>
                          <div className="model-message">
                            <Sparkles size={15} />
                            <div>
                              {r.result?.text ??
                                (r.status === "running"
                                  ? "確認しています…"
                                  : "結果を確認できませんでした。注文履歴をご確認ください。")}
                              {r.result?.events?.length > 0 && (
                                <details>
                                  <summary>
                                    実行記録 · {r.result.events.length}件
                                  </summary>
                                  {r.result.events.map((e, i) => (
                                    <div key={i} className="trace">
                                      <Check size={12} />
                                      {e.type}
                                    </div>
                                  ))}
                                </details>
                              )}
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                  <form
                    className="chat-input"
                    onSubmit={(e) => {
                      e.preventDefault();
                      ask();
                    }}
                  >
                    <textarea
                      rows={2}
                      aria-label="Geminiへのメッセージ"
                      placeholder={
                        data
                          ? "調べてほしいこと、任せたいこと…"
                          : "商品について聞いてみてください"
                      }
                      maxLength={data ? 2000 : 500}
                      value={chat}
                      onChange={(e) => setChat(e.target.value)}
                      disabled={!config?.geminiConfigured || !!busy}
                    />
                    <div>
                      <span>
                        <LockKeyhole size={12} />
                        決済は本人の同意が必要
                      </span>
                      <button
                        aria-label="送信"
                        disabled={
                          !config?.geminiConfigured || !chat.trim() || !!busy
                        }
                      >
                        <Send size={16} />
                      </button>
                    </div>
                  </form>
                </aside>
              </div>
            </>
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
                        <strong>{e.action}</strong>
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
            <span>
              <Logo /> AI works for you.
            </span>
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
              {notice.text}
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
  setNotice,
}) {
  const [name, setName] = useState("My Gemini"),
    [type, setType] = useState("gemini"),
    [agentAddress, setAgentAddress] = useState(""),
    [jwk, setJwk] = useState(""),
    [permissionDraft, setPermissionDraft] = useState(null),
    [draftLoading, setDraftLoading] = useState(modal.kind === "permission"),
    [checked, setChecked] = useState(false),
    [quantity, setQuantity] = useState(1),
    [email, setEmail] = useState(""),
    purchaseRequest = useRef(null),
    [purchaseConnection, setPurchaseConnection] = useState(chosen?.id ?? ""),
    [settings, setSettings] = useState({
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
    });
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
          <Sparkles />
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
          if (!needProvider()) return;
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
          if (!needProvider()) return;
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
            await api("/api/owner/runs", {
              requestId: crypto.randomUUID(),
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
          onClick={() =>
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
            })
          }
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
