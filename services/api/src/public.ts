import { readFile } from "node:fs/promises";
import { Hono } from "hono";
const legal = (title: string, body: string) =>
  `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · yours</title><style>body{margin:60px auto;padding:0 24px;max-width:720px;line-height:1.9;font-family:system-ui,sans-serif;color:#263d33;background:#f8f8f3}a{color:#2e6547}h1{font-size:28px}h2{font-size:19px;margin-top:32px}</style><a href="/">← yoursに戻る</a><h1>${title}</h1>${body}<p>更新：2026年10月14日</p></html>`;
export function publicRoutes() {
  const router = new Hono();
  router.use("/schemas/*",async(c,next)=>{await next();c.header("Cache-Control","public, max-age=300");});
  router.use("/payment-handler",async(c,next)=>{await next();c.header("Cache-Control","public, max-age=300");});
  router.get("/payment-handler", async (c) => {
    c.header("Content-Type", "text/markdown; charset=utf-8");
    return c.body(
      await readFile(
        new URL("../../../docs/design/PAYMENT-HANDLER.md", import.meta.url),
        "utf8",
      ),
    );
  });
  router.get("/schemas/stablecoin-handler.json", async (c) =>
    c.json(
      JSON.parse(
        await readFile(
          new URL(
            "../../../docs/schemas/stablecoin-handler.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    ),
  );
  router.get("/privacy", (c) =>
    c.html(
      legal(
        "プライバシーについて",
        `<p>yoursはGoogle Cloudハッカソン向けのテストネットサービスです。</p><h2>保存する情報</h2><p>ウォレットの公開アドレス、ログインと同意の署名、AIの権限、購入依頼、注文、取引の記録を保存します。ログイン中のGeminiへの依頼と応答も履歴として保存します。ウォレットの秘密鍵や復元用フレーズは取得しません。</p><h2>外部ECへの接続</h2><p>外部ECの商品を選ぶ場合、本人が入力した注文確認メールの宛先、注文商品、公開ウォレットアドレスを、その店舗のECサービスへ送信します。メールアドレスはyoursのAI向けタスクや公開注文データには含めません。店舗は注文受付・案内のためにこれらの情報を扱います。</p><h2>AIによる処理</h2><p>Geminiへのメッセージと購入に必要な商品・依頼情報は、Google CloudのVertex AIで処理されます。商品説明に含まれる命令から支払権限が発生することはありません。秘密情報や不要な個人情報は入力しないでください。</p><h2>公開される情報</h2><p>ブロックチェーンに送信した署名・公開アドレス・取引は公開され、削除できません。ブラウザのログイン用Cookieは本人確認に使用します。広告用トラッキングは使用していません。</p><h2>お問い合わせ</h2><p><a href="https://github.com/Mameta29/yours/issues">GitHub Issues</a>で連絡できます。公開の場に個人情報や認証情報を投稿しないでください。</p>`,
      ),
    ),
  );
  router.get("/terms", (c) =>
    c.html(
      legal(
        "試用条件",
        `<p>yoursはPolygon Amoy（chain ID 80002）上で動く開発中のサービスです。ここで扱うJPYC・POLはテストネット用です。</p><h2>検証ストア</h2><p>yours Marketの商品は、決済確認後にダウンロードできるデジタル教材です。実通貨での販売、実物商品の発送は行いません。教材は個人・商用利用と改変が可能です。</p><p>外部ECの掲載商品もAmoy用の検証商品です。実物の発送は行いません。外部ECの注文受付と送金確定は別に表示し、店舗への通知が途切れた場合は同じ取引を再照合します。</p><h2>AIへの許可</h2><p>AIは本人が署名した購入依頼と権限の範囲で支払いを実行します。上限や店舗の条件を超える注文には、その注文だけを対象とする新しい同意が必要です。権限を停止しても、送信済みの取引は取り消せない場合があります。</p><h2>記録の確認</h2><p>画面が処理中になった場合は、アクティビティと取引記録を確認してください。タイムアウトだけでは、決済の成功・失敗を判断できません。</p><p>不具合は<a href="https://github.com/Mameta29/yours/issues">GitHub Issues</a>で報告できます。</p>`,
      ),
    ),
  );
  return router;
}
