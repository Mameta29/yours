import React, { useEffect, useState } from "react";
import { FileText, ExternalLink, ArrowDown } from "lucide-react";
import { api, explain, yen } from "./api";

export default function OrderDetails({
  modal,
  data,
  setModal,
  action,
  busy,
  Status,
}) {
  const [record, setRecord] = useState(null),
    [error, setError] = useState("");
  const accountId = data?.account.id;
  const purchase = record?.accountId === accountId ? record?.purchase : null;
  useEffect(() => {
    if (!accountId) return;
    let alive = true,
      timer;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const path = modal.orderId
          ? "/orders/" + modal.orderId
          : "/" + modal.intentId;
        const result = await api("/api/owner/purchases" + path, undefined, {
          signal: controller.signal,
        });
        if (!alive) return;
        setRecord({ accountId, purchase: result });
        setError("");
        if (
          !["failed", "canceled", "approval_required"].includes(result.state) &&
          (result.state !== "confirmed" || !result.receipts)
        )
          timer = setTimeout(poll, 4000);
      } catch (e) {
        if (alive) setError(explain(e));
      }
    };
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [accountId, modal.intentId, modal.orderId]);
  if (!accountId)
    return (
      <>
        <h2 id="modal-title">あなたの注文</h2>
        <p>
          購入した本人のウォレットでログインすると、注文の内容と購入品を確認できます。
        </p>
        <button
          className="button primary"
          onClick={() => setModal({ kind: "wallet" })}
        >
          ウォレットを接続
        </button>
      </>
    );
  if (!purchase)
    return (
      <>
        <h2 id="modal-title">注文の確認</h2>
        <p role="status">{error || "注文を読み込んでいます…"}</p>
      </>
    );
  return (
    <>
      <span className="modal-symbol">
        <FileText />
      </span>
      <h2 id="modal-title">{purchase.merchantName || "注文の詳細"}</h2>
      <p>
        {new Date(purchase.createdAt).toLocaleString("ja-JP")} ·{" "}
        <Status state={purchase.state} />
      </p>
      <div className="order-items">
        {purchase.items.map((line) => (
          <div key={line.id}>
            <span>
              <strong>{line.item.title}</strong>
              <small>
                数量{" "}
                {typeof line.quantity === "number"
                  ? line.quantity
                  : line.quantity.total}
                {line.status === "fulfilled" ? " · 購入品を提供済み" : ""}
              </small>
            </span>
            <strong>
              ¥
              {yen(
                line.totals.find((total) => total.type === "total")?.amount ??
                  line.item.price,
              )}
            </strong>
          </div>
        ))}
      </div>
      <div className="order-total">
        <span>合計</span>
        <strong>
          ¥{yen(purchase.amount)} <small>test JPYC</small>
        </strong>
      </div>
      {purchase.state === "confirmed" && (
        <button
          className="button primary full"
          disabled={!!busy}
          onClick={() =>
            action("購入品を準備しています", async () => {
              const delivery = await api(
                `/api/owner/purchases/${purchase.id}/delivery`,
                {},
              );
              setRecord({
                accountId,
                purchase: {
                  ...purchase,
                  order: delivery.order,
                  items: delivery.order.line_items,
                },
              });
              window.location.assign(
                `/api/owner/purchases/${purchase.id}/download`,
              );
            })
          }
        >
          購入品をダウンロード <ArrowDown size={16} />
        </button>
      )}
      {purchase.transactionHash && (
        <a
          className="text-button"
          href={"https://amoy.polygonscan.com/tx/" + purchase.transactionHash}
          target="_blank"
          rel="noreferrer"
        >
          チェーン上の取引を確認 <ExternalLink size={15} />
        </a>
      )}
      {purchase.order && (
        <p className="small muted order-id">注文番号 {purchase.order.id}</p>
      )}
      {purchase.receipts && (
        <button
          className="text-button"
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob(
                [
                  JSON.stringify(
                    {
                      order: purchase.order,
                      receipts: purchase.receipts,
                      transactionHash: purchase.transactionHash,
                    },
                    null,
                    2,
                  ),
                ],
                { type: "application/json" },
              ),
            );
            const link = document.createElement("a");
            link.href = url;
            link.download = "yours-receipt-" + purchase.id + ".json";
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          署名付きの決済記録を保存 <FileText size={15} />
        </button>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
