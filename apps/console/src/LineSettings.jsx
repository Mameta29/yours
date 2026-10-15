import React, { useEffect, useState } from 'react';
import { ArrowUpRight, Check, Copy, LoaderCircle, MessageCircle, Pause, ShieldCheck } from 'lucide-react';
import { api, explain, fromAtomic, yen } from './api';

export default function LineSettings({ data, config, signConsent, onWallet, onPermission, onRefresh }) {
  const [status, setStatus] = useState(null), [email, setEmail] = useState(''), [code, setCode] = useState(null), [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const available = data?.connections.filter(c => c.provider === 'gemini' && c.status === 'active' && c.permission?.validUntil > Date.now() / 1000) ?? [];
  const connection = available[0];
  const load = () => api('/api/owner/line').then(setStatus);
  useEffect(() => {
    let alive = true;
    setStatus(null); setCode(null); setConfirmed(false); setEmail(''); setError(''); setNotice('');
    if (!data) return;
    const refresh = () => api('/api/owner/line').then(value => { if (alive) setStatus(value); }).catch(e => { if (alive) setError(explain(e)); });
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => { alive = false; clearInterval(timer); };
  }, [data?.account.id]);
  const active = status?.links.find(l => l.activated_at && new Date(l.expires_at).getTime() > Date.now());
  const pending = status?.links.find(l => !l.activated_at && l.claimed);
  async function act(label, fn) {
    setBusy(label); setError(''); setNotice('');
    try { await fn(); await load(); await onRefresh?.(); } catch (e) { setError(explain(e)); } finally { setBusy(''); }
  }
  return <div className="line-settings">
    <section className="line-setup-card">
      <div className="line-card-title"><MessageCircle size={22} /><div><h2>いつものLINEから、買い物を任せる。</h2><p>条件はここで。毎日の依頼は、トークで。</p></div></div>
      {error && <div className="notice error" role="alert">{error}</div>}
      {notice && <div className="notice" role="status">{notice}</div>}
      {busy && <p className="line-busy" role="status"><LoaderCircle size={16} className="spin" />{busy}</p>}
      {!data ? <><p>初回だけ、ウォレットとLINEをつなぎます。資産をbotへ送る必要はありません。</p><button className="button primary" onClick={onWallet}>ウォレットを接続</button></>
      : !connection ? <><p>先にGeminiの購入権限を設定してください。</p><button className="button primary" onClick={onPermission}>購入権限を設定する</button></>
      : active ? <>
        <div className="line-connected"><span><Check size={17} />LINEでの購入が有効</span><strong>{active.display_name}</strong><p>{connection.name} · {new Date(active.expires_at).toLocaleDateString('ja-JP')}まで</p></div>
        <div className="line-example"><span>LINEに送ってみる</span><p>お米10kg買っといて</p></div>
        <p>予算とお店の条件内なら、そのまま購入します。条件外では支払いを止め、この注文だけ許可するかを確認します。</p>
        <div className="line-actions">{status.botId && <a className="button primary" href={'https://line.me/R/oaMessage/' + encodeURIComponent(status.botId) + '/?' + encodeURIComponent('お米10kg買っといて')} target="_blank" rel="noreferrer">LINEを開く <ArrowUpRight size={16} /></a>}
          <button className="text-button danger" disabled={!!busy} onClick={() => act('LINEでの購入を停止しています', () => api('/api/owner/line/' + active.id + '/revoke', {}))}><Pause size={14} />連携を停止</button></div>
      </> : pending ? <>
        <div className="line-connected"><span><Check size={17} />LINEを確認しました</span><strong>{pending.display_name}</strong></div>
        <p>このLINEからの購入依頼を、{connection.name}に任せます。お店・予算・期限は設定済みの権限が適用されます。</p>
        <label className="line-consent"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /><span>表示されたLINEは自分のアカウントです。条件内の購入を任せ、条件外ではこのLINEで注文ごとの確認を求めることに同意します。</span></label>
        <button className="button primary" disabled={!confirmed || !!busy} onClick={() => act('ウォレットでLINE連携の同意を確認してください', async () => {
          const draft = await api('/api/owner/line/' + pending.id + '/prepare', {});
          const signature = await signConsent(draft.typedData); if (!signature) return;
          await api('/api/owner/line/' + pending.id + '/activate', { signature }); setCode(null);
        })}>署名して、LINEで使う</button><p className="small muted">署名は初回の連携用です。トークから条件内で購入するたびに署名する必要はありません。</p>
      </> : code ? <>
        <ol className="line-instructions"><li>下のボタンから、既存のLINE botを開く。</li><li>入力されている連携コードを送る。</li><li>この画面に戻り、LINE名を確認する。</li></ol>
        {code.url && <a className="button primary" href={code.url} target="_blank" rel="noreferrer">LINEでコードを送る <ArrowUpRight size={16} /></a>}
        <div className="line-link-code"><code>{code.code}</code><button className="icon-button" aria-label="連携コードをコピー" onClick={() => navigator.clipboard.writeText(code.code).then(() => setNotice('コピーしました。LINE botのトークに貼り付けて送信してください。'))}><Copy size={16} /></button></div>
        <p className="small muted">連携コードの有効期限は10分です。</p>
        <button className="text-button" onClick={() => setCode(null)}>コードを発行し直す</button>
      </> : <form onSubmit={e => { e.preventDefault(); act('LINEの連携を準備しています', async () => setCode(await api('/api/owner/line/link', { connectionId: connection.id, email: email.trim() }))); }}>
        <p>最初にLINEを確認し、ウォレットで連携に同意します。</p>
        <label className="line-email">購入時のメールアドレス<input type="email" autoComplete="email" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" /></label>
        <p className="small muted">注文通知のため、購入するお店へ渡します。</p>
        <button className="button primary" disabled={!!busy || !status?.configured}>LINEを接続する <ArrowUpRight size={16} /></button>
      </form>}
    </section>
    <aside className="line-rules-card">
      <ShieldCheck size={21} /><h2>任せる範囲</h2>
      {connection ? <><dl><div><dt>購入を任せるAI</dt><dd>{connection.name}</dd></div><div><dt>1回の上限</dt><dd>¥{yen(fromAtomic(connection.permission.perOrder))}</dd></div><div><dt>24時間の上限</dt><dd>¥{yen(fromAtomic(connection.permission.perPeriod))}</dd></div><div><dt>購入を許可するお店</dt><dd>{connection.permission.merchants.map(m => config?.merchants?.find(s => s.id === m.id)?.name ?? m.id).join('、')}</dd></div></dl><button className="text-button" onClick={onPermission}>購入条件を変更する <ArrowUpRight size={14} /></button></> : <p>予算・お店・期限を指定してから、LINEへつなげます。</p>}
      <div className="line-rule-note">資産はあなたのウォレットに残ります。LINE連携を停止しても、送信済みの支払いは履歴に残ります。</div>
    </aside>
  </div>;
}
