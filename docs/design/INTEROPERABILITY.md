# 固定した仕様と相互運用の検証

- UCP: `2026-08-25`、commit `3a541e135caf9dad212c52c43051f7073d3b65ff`。公式JSON Schemaを改変せずvendorし、profile・応答・ucp_requestによる要求の導出を検証する。
- AP2: v0.2のSDK、commit `e1ea56db72a6385bce3e5c1112b3a56ce60acb43`。PyPIの同名packageへの置き換えは禁止。uv.lockで依存を固定。

AP2はP-256のSD-JWTによるopen mandate、cnf鍵によるclosed mandate、audience・nonce・期限・店舗・商品数量・金額・支払手段・一回限りの使用制約を検証する。checkoutとpaymentはopen checkoutのdigestでも結び付ける。KMS向けissuerと公式SDKのpresent双方で作成した署名を公式SDKのverifyで確認している。レシートはclosed mandateのleaf JWTに結び付け、network confirmationには確定した取引hashを使用する。

## 上流仕様・SDKの不整合

1. UCP安定版の`common/payment_ap2_mandate.json`にあるcheckout_mandateのpatternは、AP2 v0.2 SDKが生成する`~~`区切りのdelegated SD-JWTを受け入れない。yoursは公式スキーマ自体を書き換えず、UCP本体の構造検証とAP2 SDKによる署名・制約検証を分ける。この組合せを「公式の全conformanceを通過」とは表現しない。実トークンを使う相互運用試験を基準にする。
2. SDKのcnf用JsonWebKeyは`use`をPython Enumとして再serializeするため、そのままjwcryptoへ渡すと検証に失敗する。yoursのcnfには標準で許された最小の公開JWK（kty/crv/x/y/alg/kid）を使用する。検証処理や署名検証を迂回していない。
3. SDKの空disclosure rootはchain segment復元時の判定と合わないため、RFC 9901のarray-element disclosureとしてmandate全体を開示する。

UCPの公式仕様: https://ucp.dev/ 、AP2の公式実装: https://github.com/google-agentic-commerce/AP2 。consumer Gemini内で独自stablecoin handlerが採用されることと、yoursのGemini agentがUCPを利用することは別に扱う。
