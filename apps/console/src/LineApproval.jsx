import React, { useEffect, useState } from 'react';
import { Check, ExternalLink, LoaderCircle, ShieldCheck } from 'lucide-react';
import { api, explain, yen, short } from './api';
const labels = { per_order: '1回の上限を超えています', period_budget: '期間の予算を超えています', merchant: '購入を許可したお店の範囲外です' };
export default function LineApproval({ token }) {
  const [order, setOrder] = useState(null), [error, setError] = useState('');
  const path = '/api/line/approvals/' + encodeURIComponent(token);
  useEffect(() => {
    let alive = true;
    const load = () => api(path).then(o => { if (alive) setOrder(o); }).catch(e => { if (alive) setError(explain(e)); });
    load(); const timer = setInterval(load, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [token]);
  const paid = order?.state === 'confirmed' && order.transactionHash;
  const waiting = ['authorized', 'signing', 'submitted'].includes(order?.state);
  return <main className="line-approval-page"><a className="wordmark" href="/">yours<span className="brand-period">.</span></a>
    <article className="line-approval-card">
      <span className="line-approval-icon">{paid ? <Check /> : <ShieldCheck />}</span>
      <p className="eyebrow">あなたの確認が必要な注文</p>
      <h1>{paid ? '支払いが確定しました。' : waiting ? 'この注文を承認しました。' : order?.state === 'canceled' ? '注文を取り消しました。' : 'この買い物だけ、許可しますか。'}</h1>
      {error && <div className="notice error" role="alert">{error}</div>}
      {!order ? <p role="status"><LoaderCircle className="spin" size={18} /> 注文を確認しています。</p> : <>
        <section className="line-order-summary"><p>{order.merchant}</p>{order.items.map(line => <div key={line.id} className="line-order-item"><strong>{line.item.title}</strong><span>数量 {typeof line.quantity === 'number' ? line.quantity : line.quantity.total}</span></div>)}<div className="line-order-total"><span>合計</span><strong>¥{yen(order.amount)} <small>test JPYC</small></strong></div></section>
        {order.state === 'approval_required' && <><ul className="line-order-reasons">{order.reasons.map(reason => <li key={reason}>{labels[reason] ?? reason}</li>)}</ul><p>承認するのは、この商品・お店・金額の一件だけです。いつもの購入条件は変わりません。</p>
          {order.available ? <><p>連携したLINEのトークに戻り、注文確認カードの「この一件だけ許可」を押してください。</p>{order.botId && <a className="button line-login-button full" href={'https://line.me/R/oaMessage/' + encodeURIComponent(order.botId) + '/'}>LINEの注文確認に戻る</a>}<p className="small muted">このページを開いただけでは、支払いは承認されません。</p></> : <p className="notice">この注文またはLINE連携の期限が切れています。LINEから新しく依頼してください。</p>}</>}
        {waiting && <p className="line-busy"><LoaderCircle className="spin" size={18} />支払いと店舗での受付を進めています。結果はLINEへお知らせします。</p>}
        {paid && <><p>代金はあなたのウォレットから支払われました。</p><a className="button" href={'https://amoy.polygonscan.com/tx/' + order.transactionHash} target="_blank" rel="noreferrer">取引を確認 {short(order.transactionHash)} <ExternalLink size={15} /></a></>}
        {order.state === 'failed' && <p>この注文は成立しませんでした。LINEとyoursの注文履歴で結果を確認できます。</p>}
      </>}
    </article><p className="line-approval-footnote">Polygon Amoy · テスト用JPYC</p>
  </main>;
}
