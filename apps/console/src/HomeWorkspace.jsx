import React, { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronRight,
  LoaderCircle,
  Pause,
  Plus,
  ShieldCheck,
  X,
} from "lucide-react";
import Markdown from "./Markdown";
import { fromAtomic, yen, short } from "./api";
import { purchaseProgress, traceLabels } from "./run-progress";

const time = (value) =>
  value
    ? new Date(value).toLocaleTimeString("ja-JP", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "";

function Execution({ progress, onOpen, onApprove }) {
  const p = progress;
  return (
    <section
      className={"execution " + (p.attention ? "needs-attention" : "")}
      aria-label="購入の実行状況"
    >
      <div className="execution-heading">
        <span>
          {p.paid
            ? "支払いが完了しました"
            : p.attention
              ? "あなたの確認が必要です"
              : p.stopped
                ? "購入は成立していません"
                : p.needsCheck
                  ? "依頼の実行結果を確認してください"
                  : "購入を進めています"}
        </span>
        <strong>
          {p.amountIsLimit && <small>上限 </small>}¥{yen(p.amount)}
        </strong>
      </div>
      <p className="execution-product">{p.title}</p>
      <ol className="execution-steps">
        {p.steps.map((step, i) => (
          <li key={step.label} className={step.status}>
            <span className="step-marker">
              {step.status === "done" ? (
                <Check size={13} />
              ) : step.status === "current" ? (
                <LoaderCircle size={13} className="spin" />
              ) : step.status === "stopped" ? (
                <X size={13} />
              ) : (
                i + 1
              )}
            </span>
            <div>
              <strong>{step.label}</strong>
              <small>{step.detail}</small>
              {step.at && <time>{time(step.at)}</time>}
            </div>
          </li>
        ))}
      </ol>
      <div className="execution-result">
        <span>
          {p.paid
            ? "本人のウォレットから店舗へ送金"
            : p.attention
              ? "この注文への追加同意を待っています"
              : "実際の処理状況を自動で更新します"}
        </span>
        {p.intent && (
          <button
            className={
              p.attention ? "button primary small-button" : "text-button"
            }
            onClick={() =>
              p.attention ? onApprove(p.intent) : onOpen(p.intent)
            }
          >
            {p.attention ? "内容を確認" : "注文を開く"}
            <ArrowUpRight size={14} />
          </button>
        )}
      </div>
      {p.paid && (
        <a
          className="execution-proof"
          href={"https://amoy.polygonscan.com/tx/" + p.hash}
          target="_blank"
          rel="noreferrer"
        >
          Amoyで確定 · {short(p.hash)}
          <ArrowUpRight size={12} />
        </a>
      )}
    </section>
  );
}

function RunRecord({
  run,
  tasks,
  intents,
  audit,
  connections,
  onOpen,
  onApprove,
}) {
  const progress = purchaseProgress(run, tasks, intents, audit);
  const connection = connections.find((c) => c.id === run.connection_id);
  const events = run.result?.events ?? [];
  return (
    <article className="chat-turn">
      <div className="request-meta">
        <span>あなた</span>
        <time>{time(run.created_at)}</time>
      </div>
      <div className="user-message">
        {progress
          ? `「${progress.title}」の購入を${connection?.name ?? "AI"}に依頼`
          : (run.displayMessage ??
            (run.mandate_id
              ? "承認した購入を実行してください。"
              : run.message))}
      </div>
      <div className="response-meta">
        <span className="agent-monogram small-monogram">G</span>
        <strong>{connection?.name ?? "Gemini"}</strong>
        {run.status === "running" && (
          <span className="run-state">
            <LoaderCircle size={12} className="spin" />
            実行中
          </span>
        )}
      </div>
      {progress && <Execution progress={progress} {...{ onOpen, onApprove }} />}
      <div className="model-message">
        {run.result?.text ? (
          progress ? (
            <details className="response-detail">
              <summary>Geminiの回答</summary>
              <Markdown>{run.result.text}</Markdown>
            </details>
          ) : (
            <Markdown>{run.result.text}</Markdown>
          )
        ) : (
          !progress && (
            <p className="run-waiting">
              {run.pending
                ? "依頼を送信しています…"
                : run.status === "running"
                  ? "Geminiが依頼を確認しています…"
                  : "結果を確認できませんでした。注文履歴をご確認ください。"}
            </p>
          )
        )}
        {events.length > 0 && (
          <details className="execution-log">
            <summary>実行ログ · {events.length}件</summary>
            <p className="log-provider">
              {run.result.framework} · {run.result.model} / Google Cloud
            </p>
            {events.map((event, i) => (
              <div className="trace" key={i}>
                <time>{time(event.at * 1000)}</time>
                <span>
                  {traceLabels[event.type] ?? event.type}
                  {event.type === "catalog.search" && ` · ${event.count}件`}
                </span>
              </div>
            ))}
          </details>
        )}
      </div>
    </article>
  );
}

export default function HomeWorkspace({
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
  onAdd,
  onWallet,
  onPermission,
  onPause,
  onPurchase,
  onOpen,
  onApprove,
  onAgents,
  onActivity,
  onRunTask,
  onRevokeTask,
  onCopyTask,
}) {
  const [catalogScope, setCatalogScope] = useState("allowed");
  const messages = useRef(null),
    stickToBottom = useRef(true);
  const last = runs[0];
  useEffect(() => {
    if (pendingRun) {
      stickToBottom.current = true;
      if (messages.current)
        messages.current.scrollTop = messages.current.scrollHeight;
    }
  }, [pendingRun?.requestId]);
  useEffect(() => {
    if (stickToBottom.current && messages.current)
      messages.current.scrollTop = messages.current.scrollHeight;
  }, [
    last?.id,
    last?.status,
    last?.result,
    pendingRun?.requestId,
    tasks.find((t) => t.id === last?.mandate_id)?.state,
  ]);
  const list = [...runs].reverse();
  if (
    pendingRun &&
    !runs.some((r) => r.client_request_id === pendingRun.requestId)
  )
    list.push({
      id: pendingRun.requestId,
      client_request_id: pendingRun.requestId,
      connection_id: pendingRun.connectionId,
      mandate_id: pendingRun.mandateId,
      message: pendingRun.message,
      displayMessage: pendingRun.displayMessage,
      status: "running",
      pending: true,
    });
  const permission = chosen ?? connections.find((c) => c.status !== "revoked");
  const allowed = new Set(
    permission?.permission?.merchants.map((m) => m.id) ?? [],
  );
  const catalog = products.filter(
    (p) =>
      !allowed.size ||
      catalogScope === "all" ||
      allowed.has(p.metadata?.merchant_id ?? config?.merchant.id),
  );
  const waiting = tasks.filter(
    (t) =>
      !t.intent_id &&
      !t.revoked_at &&
      new Date(t.expires_at).getTime() > Date.now(),
  );
  return (
    <>
      <section className="account-overview" aria-label="予算と支払い元">
        <div className="overview-budget">
          <div className="overview-label">
            共有予算の残り<span>24時間ごと</span>
          </div>
          <div className="overview-value">
            {budget ? `¥${yen(remaining)}` : "—"}
            <small>{budget ? `/ ¥${yen(limit)}` : "未設定"}</small>
          </div>
          <div className="budget-bar">
            <i
              style={{
                width: limit
                  ? Math.min(100, ((spent + reserved) / limit) * 100) + "%"
                  : "0%",
              }}
            />
          </div>
          <p>
            支払済み ¥{yen(spent)}
            {reserved > 0 && ` · 確定待ち ¥${yen(reserved)}`}
          </p>
        </div>
        <div>
          <div className="overview-label">任せているAI</div>
          <div className="overview-value">
            {active.length}
            <small>サービス</small>
          </div>
          <button className="text-button" onClick={onAgents}>
            権限を管理
            <ArrowRight size={13} />
          </button>
        </div>
        <div>
          <div className="overview-label">
            あなたのウォレット
            <ShieldCheck size={15} />
          </div>
          <div className="overview-value">
            {wallet ? `¥${yen(fromAtomic(wallet.balance))}` : "—"}
            <small>test JPYC</small>
          </div>
          <p>資産はここに。AIへの入金は不要です。</p>
        </div>
      </section>
      <div className="purchase-workspace">
        <section className="assistant-panel" aria-label="Geminiへの依頼">
          <div className="assistant-header">
            <span className="agent-monogram">G</span>
            <div>
              <h2>{chosen?.name ?? "Gemini"}</h2>
              <span className="small muted">Google Cloud · Gemini</span>
            </div>
            <span className="assistant-purpose">購入アシスタント</span>
            {active.filter((c) => c.provider === "gemini").length > 1 && (
              <select
                aria-label="会話するAI"
                value={chosen?.id ?? selected}
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
          </div>
          <div
            className="chat-messages"
            ref={messages}
            onScroll={(e) => {
              const el = e.currentTarget;
              stickToBottom.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 100;
            }}
          >
            {list.length ? (
              list.map((run) => (
                <RunRecord
                  key={run.id}
                  {...{ run, tasks, audit, connections, onOpen, onApprove }}
                  intents={data?.intents ?? []}
                />
              ))
            ) : (
              <div className="assistant-intro">
                <span className="intro-kicker">あなたの条件で、買い物を。</span>
                <h3>何を探しましょうか。</h3>
                <p>
                  商品を調べ、比べるところから。
                  <br />
                  購入内容に同意すると、会計と支払いを進めます。
                </p>
                {[
                  "カタログの商品と価格を教えて",
                  "1,000円以内の商品を比較して",
                ].map((prompt) => (
                  <button
                    className="prompt"
                    key={prompt}
                    onClick={() => {
                      setChat(prompt);
                      document.getElementById("assistant-message")?.focus();
                    }}
                  >
                    {prompt}
                    <ArrowUpRight size={14} />
                  </button>
                ))}
              </div>
            )}
          </div>
          <form
            className="chat-input"
            onSubmit={(e) => {
              e.preventDefault();
              stickToBottom.current = true;
              ask();
            }}
          >
            <div className="composer">
              <textarea
                id="assistant-message"
                rows={2}
                aria-label="Geminiへのメッセージ"
                placeholder="探しているものや、予算を教えてください"
                maxLength={data ? 2000 : 500}
                value={chat}
                onChange={(e) => setChat(e.target.value)}
                disabled={!config?.geminiConfigured || !!busy}
              />
              <button
                aria-label="送信"
                disabled={!config?.geminiConfigured || !chat.trim() || !!busy}
              >
                <ArrowUp size={18} />
              </button>
            </div>
            <p>購入には、商品と金額への本人の同意が必要です。</p>
          </form>
        </section>
        <aside className="context-rail">
          <section className="permission-summary">
            <div className="section-heading">
              <h2>任せている範囲</h2>
              <button
                className="text-button"
                disabled={!data || !!busy}
                onClick={onAdd}
                aria-label="AIを追加する"
              >
                <Plus size={15} />
              </button>
            </div>
            {permission ? (
              <>
                <div className="permission-identity">
                  <strong>{permission.name}</strong>
                  <span className={"status " + permission.status}>
                    <i />
                    {permission.status === "active"
                      ? "有効"
                      : permission.status === "paused"
                        ? "停止中"
                        : "設定待ち"}
                  </span>
                </div>
                <dl className="permission-facts">
                  <div>
                    <dt>1回の上限</dt>
                    <dd>
                      {permission.permission
                        ? `¥${yen(fromAtomic(permission.permission.perOrder))}`
                        : "未設定"}
                    </dd>
                  </div>
                  <div>
                    <dt>24時間の上限</dt>
                    <dd>
                      {permission.permission
                        ? `¥${yen(fromAtomic(permission.permission.perPeriod))}`
                        : "未設定"}
                    </dd>
                  </div>
                </dl>
                {permission.permission && (
                  <>
                    <p className="permission-scope">
                      {permission.permission.merchants.length}店舗 ·{" "}
                      {new Date(
                        permission.permission.validUntil * 1000,
                      ).toLocaleDateString("ja-JP", {
                        month: "long",
                        day: "numeric",
                      })}
                      まで
                    </p>
                    <p className="permission-stores">
                      {permission.permission.merchants
                        .map(
                          (m) =>
                            config?.merchants?.find((shop) => shop.id === m.id)
                              ?.name ?? "登録済みの店舗",
                        )
                        .join(" / ")}
                    </p>
                  </>
                )}
                <div className="permission-controls">
                  <button
                    className="text-button"
                    disabled={!!busy}
                    onClick={() => onPermission(permission)}
                  >
                    {permission.pending_draft
                      ? "登録を再開"
                      : permission.permission
                        ? "権限を編集"
                        : "権限を設定"}
                    <ArrowRight size={13} />
                  </button>
                  {permission.status === "active" && (
                    <button
                      className="text-button"
                      disabled={!!busy}
                      onClick={() => onPause(permission)}
                      aria-label={permission.name + "を停止"}
                    >
                      <Pause size={13} />
                      停止
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className="permission-empty">
                <p>AIを選び、予算・店舗・期限を設定します。</p>
                <button
                  className="button"
                  disabled={!config || !!busy}
                  onClick={data ? onAdd : onWallet}
                >
                  {data ? "AIを追加する" : "ウォレットを接続"}
                  <ArrowRight size={14} />
                </button>
              </div>
            )}
          </section>
          <section className="catalog-panel">
            <div className="section-heading">
              <h2>商品を選ぶ</h2>
              <span className="small muted">{catalog.length}商品</span>
            </div>
            {allowed.size > 0 && (
              <div className="catalog-scope" aria-label="表示する店舗">
                {[
                  ["allowed", "許可したお店"],
                  ["all", "すべて"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    aria-pressed={catalogScope === value}
                    className={catalogScope === value ? "selected" : ""}
                    onClick={() => setCatalogScope(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <div className="product-list">
              {[...catalog]
                .sort(
                  (a, b) => a.price_range.min.amount - b.price_range.min.amount,
                )
                .map((p) => (
                  <button
                    key={p.id}
                    className="product-row"
                    disabled={!p.variants[0].availability.available || !!busy}
                    onClick={() => onPurchase(p)}
                  >
                    <span className="product-name">
                      <strong>{p.title}</strong>
                      <small>
                        {p.metadata?.merchant_name ?? "yours Market"}
                        {!p.variants[0].availability.available && " · 在庫なし"}
                      </small>
                    </span>
                    <span className="product-price">
                      ¥{yen(p.price_range.min.amount)}
                    </span>
                    <ChevronRight size={14} />
                  </button>
                ))}
              {!catalog.length && (
                <p className="empty-line">カタログを読み込んでいます。</p>
              )}
            </div>
            <p className="catalog-footnote">Polygon Amoy · test JPYCでの購入</p>
          </section>
        </aside>
      </div>
      {waiting.length > 0 && (
        <section className="pending-tasks">
          <div className="section-heading">
            <h2>承認済みの依頼</h2>
          </div>
          {waiting.map((t) => {
            const agent = connections.find((c) => c.id === t.connection_id);
            return (
              <article className="approved-task" key={t.id}>
                <div>
                  <strong>{t.task.items.map((i) => i.title).join("、")}</strong>
                  <p className="small muted">
                    {agent?.name} · 上限 ¥{yen(t.task.max_amount)} ·{" "}
                    {time(t.expires_at)}まで
                  </p>
                </div>
                <div className="task-actions">
                  <button
                    className="text-button"
                    disabled={!!busy || agent?.status !== "active"}
                    onClick={() =>
                      agent?.provider === "gemini"
                        ? onRunTask(t, agent)
                        : onCopyTask(t)
                    }
                  >
                    {agent?.provider === "gemini"
                      ? "AIで実行"
                      : "依頼IDをコピー"}
                    <ArrowRight size={14} />
                  </button>
                  <button
                    className="text-button danger"
                    disabled={!!busy}
                    onClick={() => onRevokeTask(t)}
                  >
                    依頼を取り消す
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      )}
      <section className="recent-purchases">
        <div className="section-heading">
          <h2>最近の購入</h2>
          <button className="text-button" onClick={onActivity}>
            すべて見る
            <ArrowUpRight size={14} />
          </button>
        </div>
        {data?.intents.length ? (
          data.intents.slice(0, 3).map((intent) => {
            const task = tasks.find((t) => t.intent_id === intent.id);
            return (
              <button
                key={intent.id}
                className="purchase-row"
                onClick={() =>
                  intent.state === "approval_required"
                    ? onApprove(intent)
                    : onOpen(intent)
                }
              >
                <span>
                  <strong>
                    {task?.task.items.map((i) => i.title).join("、") ??
                      intent.merchant_name}
                  </strong>
                  <small>
                    {intent.merchant_name} ·{" "}
                    {new Date(intent.created_at).toLocaleString("ja-JP")}
                  </small>
                </span>
                <span className={"status " + intent.state}>
                  <i />
                  {intent.state === "confirmed"
                    ? "支払済み"
                    : intent.state === "approval_required"
                      ? "確認が必要"
                      : intent.state === "failed"
                        ? "成立せず"
                        : intent.state === "canceled"
                          ? "キャンセル"
                          : "処理中"}
                </span>
                <strong>¥{yen(Number(intent.amount_minor))}</strong>
                <ArrowUpRight size={15} />
              </button>
            );
          })
        ) : (
          <p className="empty-line">
            購入すると、注文と支払いの記録がここに残ります。
          </p>
        )}
      </section>
    </>
  );
}
