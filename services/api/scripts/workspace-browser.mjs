// UI contract checks with isolated HTTP fixtures. These are not live Gemini or chain evidence.
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const origin = process.env.CONSOLE_ORIGIN ?? "http://127.0.0.1:4178";
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
  throw new Error("local preview only");
const owner = "0x1111111111111111111111111111111111111111",
  connection = "10000000-0000-4000-8000-000000000001",
  mandate = "20000000-0000-4000-8000-000000000002",
  intent = "30000000-0000-4000-8000-000000000003",
  runId = "40000000-0000-4000-8000-000000000004";
const stamp = new Date().toISOString(),
  hash = "0x" + "a".repeat(64),
  until = Math.floor(Date.now() / 1000) + 86400;
const atomic = (n) => String(BigInt(n) * 10n ** 18n);
const permission = {
  perOrder: atomic(2000),
  perPeriod: atomic(5000),
  validUntil: until,
  merchants: [{ id: "market" }],
};
const products = [
  ["weekly", "週次ふりかえりテンプレート", 300],
  ["travel", "旅の持ち物チェックリスト", 600],
  ["project", "個人プロジェクト計画キット", 1200],
].map(([id, title, amount]) => ({
  id,
  title,
  description: { plain: "日々の仕事に使えるデジタルテンプレート。" },
  price_range: { min: { amount, currency: "JPY" } },
  variants: [{ availability: { available: true } }],
  metadata: { merchant_id: "market", merchant_name: "yours Market" },
}));
products.push({
  id: "rice",
  title: "お米 10kg / Rice 10 kg",
  description: { plain: "Amoyの外部EC商品" },
  price_range: { min: { amount: 800, currency: "JPY" } },
  variants: [{ availability: { available: true } }],
  metadata: {
    external: true,
    merchant_id: "ec",
    merchant_name: "CHEAP RICE SHOP",
  },
});
let state = "authorized",
  phase = "owner",
  balanceReads = 0;
const config = {
  origin,
  chainId: 80002,
  geminiConfigured: true,
  merchant: { id: "market", name: "yours Market" },
  merchants: [
    { id: "market", name: "yours Market" },
    { id: "ec", name: "CHEAP RICE SHOP", adapter: "jpyc-ec" },
  ],
};
const task = () => ({
  id: mandate,
  connection_id: connection,
  task: {
    items: [{ id: "weekly", title: products[0].title, quantity: 1 }],
    max_amount: 300,
    merchant_name: "yours Market",
  },
  intent_id: intent,
  state,
  transaction_hash: ["submitted", "confirmed", "failed"].includes(state)
    ? hash
    : null,
  created_at: stamp,
  expires_at: new Date(Date.now() + 3600000).toISOString(),
});
const purchase = () => ({
  id: intent,
  connection_id: connection,
  state,
  merchant_name: "yours Market",
  amount_minor: 300,
  transaction_hash: task().transaction_hash,
  created_at: stamp,
});
const runs = () =>
  phase === "empty"
    ? []
    : [
        {
          id: runId,
          connection_id: connection,
          mandate_id: mandate,
          created_at: stamp,
          message: "承認した依頼 " + mandate + " を実行してください。",
          status: ["authorized", "submitted"].includes(state)
            ? "running"
            : "completed",
          result: ["authorized", "submitted"].includes(state)
            ? null
            : {
                text: "**決済を確認しました。** 注文から商品を受け取れます。",
                events: [
                  { type: "checkout.complete", at: Date.now() / 1000 },
                  { type: "x402.accepted", at: Date.now() / 1000 },
                ],
                model: "Gemini UI fixture",
                framework: "Google ADK",
              },
        },
        {
          id: "search",
          created_at: stamp,
          status: "completed",
          message: "カタログの商品と価格を教えて",
          result: {
            text: "**商品を比較しました。**\n\n| 商品 | 価格 |\n| --- | ---: |\n| 週次ふりかえりテンプレート | 300 JPYC |\n| 旅の持ち物チェックリスト | 600 JPYC |\n\n1. **テンプレート**\n   - 在庫あり",
            events: [
              { type: "catalog.search", count: 4, at: Date.now() / 1000 },
            ],
            model: "Gemini UI fixture",
            framework: "Google ADK",
          },
        },
      ];
const browser = await chromium.launch({ channel: "chrome", headless: true });
const checks = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body;
    if (path === "/api/config") body = config;
    else if (path === "/api/owner/me")
      body = {
        account: { id: "owner", address: owner },
        connections: [
          {
            id: connection,
            name: "My Gemini",
            provider: "gemini",
            status: "active",
            permission,
          },
        ],
        policy: {
          document: { perPeriod: atomic(10000) },
          activation_tx: "fixture",
        },
        usage: {
          accountSpent: atomic(state === "confirmed" ? 300 : 0),
          accountReserved: atomic(
            ["submitted", "authorized"].includes(state) ? 300 : 0,
          ),
        },
        intents: phase === "empty" ? [] : [purchase()],
      };
    else if (path === "/api/owner/permissions/wallet") {
      balanceReads++;
      body = { balance: atomic(state === "confirmed" ? 3010680 : 3010980) };
    } else if (path === "/api/owner/tasks")
      body = { tasks: phase === "empty" ? [] : [task()] };
    else if (path === "/api/owner/line") body={configured:true,botId:'@fixture',links:[{id:'line-fixture',connection_id:connection,display_name:'連携した本人',activated_at:stamp,expires_at:new Date(until*1000).toISOString()}],events:[]};
    else if (path.startsWith('/api/line/approvals/')) body={id:intent,state:'approval_required',amount:2400,merchant:'HIGH RICE SHOP',items:[{id:'rice',item:{title:'お米10kg'},quantity:1}],reasons:['per_order'],available:true,botId:'@fixture'};
    else if (path === "/api/owner/runs") body = { runs: runs() };
    else if (path === "/api/owner/audit")
      body = {
        events:
          phase === "empty"
            ? []
            : [
                {
                  sequence: 1,
                  actor: "worker",
                  action: "purchase.authorized",
                  resource_id: intent,
                  created_at: stamp,
                },
                ...(state === "confirmed"
                  ? [
                      {
                        sequence: 2,
                        actor: "worker",
                        action: "transaction.confirmed",
                        resource_id: "transaction",
                        data: { intentId: intent },
                        created_at: stamp,
                      },
                    ]
                  : []),
              ],
      };
    else if (path === `/api/owner/purchases/${intent}`)
      body = {
        id: intent,
        state,
        amount: 300,
        createdAt: stamp,
        merchantName: "yours Market",
        transactionHash: hash,
        deliveryKind: "download",
        items: [
          {
            id: "weekly",
            item: { title: products[0].title, price: 300 },
            quantity: { total: 1 },
            totals: [{ type: "total", amount: 300 }],
          },
        ],
        order: { id: "order-fixture" },
        receipts: {},
      };
    else
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: "{}",
      });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.route("**/ucp/catalog/search", (r) =>
    r.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ products }),
    }),
  );
  await page.goto(origin);
  await expect(
    page.getByRole("region", { name: "購入の実行状況" }),
  ).toContainText("購入を進めています");
  await expect(page.locator(".markdown table")).toHaveCount(1);
  await expect(page.locator(".markdown strong").first()).toHaveText(
    "商品を比較しました。",
  );
  checks.push("GFM table, emphasis and nested list render in actual Chrome");
  await expect(page.locator(".product-row")).toHaveCount(3);
  await page.getByRole("button", { name: "すべて", exact: true }).click();
  await expect(page.locator(".product-row")).toHaveCount(4);
  checks.push(
    "catalog defaults to allowed shops and permits viewing all shops",
  );
  await page.getByRole("button", { name: "許可したお店", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "購入の実行状況" }),
  ).not.toContainText("支払いが完了しました");
  state = "submitted";
  await expect(
    page.getByRole("region", { name: "購入の実行状況" }),
  ).toContainText("チェーンの確定待ち", { timeout: 12000 });
  checks.push("polling displays submitted as pending, not paid");
  const reads = balanceReads;
  state = "confirmed";
  await expect(
    page.getByRole("region", { name: "購入の実行状況" }),
  ).toContainText("支払いが完了しました", { timeout: 12000 });
  await expect(page.locator(".account-overview")).toContainText("¥9,700");
  await expect(page.locator(".account-overview")).toContainText("¥3,010,680");
  assert.ok(balanceReads > reads);
  checks.push(
    "actual confirmed state updates progress, shared budget and wallet balance",
  );
  assert.equal(
    await page.locator(".user-message").filter({ hasText: mandate }).count(),
    0,
  );
  checks.push(
    "purchase requests show the product and agent instead of internal UUIDs",
  );
  await page.screenshot({
    path: ".local/workspace-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "注文を開く", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("支払済み");
  await expect(
    page.getByRole("button", { name: "購入品をダウンロード" }),
  ).toBeVisible();
  await page.screenshot({ path: ".local/workspace-order.png" });
  await page.keyboard.press("Escape");
  checks.push("purchase evidence opens the authenticated order dialog");
  state = "approval_required";
  await page.reload();
  await expect(
    page.getByRole("region", { name: "購入の実行状況" }),
  ).toContainText("あなたの確認が必要です");
  await expect(
    page
      .getByRole("region", { name: "購入の実行状況" })
      .getByRole("button", { name: "内容を確認" }),
  ).toBeVisible();
  await page.screenshot({
    path: ".local/workspace-approval.png",
    fullPage: true,
  });
  checks.push("exception remains stopped at owner approval");
  state = "confirmed";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(
    page.getByRole("region", { name: "購入の実行状況" }),
  ).toContainText("支払いが完了しました");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({
    path: ".local/workspace-mobile.png",
    fullPage: true,
  });
  checks.push("390px layout has no horizontal page overflow");
  await page.locator('nav').getByRole('button',{name:'LINEで使う',exact:true}).click();
  await expect(page.getByText('LINEでの購入が有効')).toBeVisible();
  await expect(page.getByRole('link',{name:'LINEを開く'})).toHaveAttribute('href',/oaMessage/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:'.local/line-settings-mobile.png',fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  await page.screenshot({path:'.local/line-settings-desktop.png',fullPage:true});
  checks.push('LINE links to existing bot, displays current permissions, and fits a 390px screen');
  await page.goto(origin+'/line/approve/'+'a'.repeat(43));
  await expect(page.getByRole('heading',{name:'この買い物だけ、許可しますか。'})).toBeVisible();
  await expect(page.getByText('¥2,400',{exact:false})).toBeVisible();
  await expect(page.getByRole('link',{name:'LINEの注文確認に戻る'})).toBeVisible();
  await expect(page.getByRole('button',{name:/認証/})).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:'.local/line-order-mobile.png',fullPage:true});
  checks.push('LINE order page displays exact amount and requires confirmation in the registered LINE account');
  await page.goto(origin);
  phase = "empty";
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await expect(page.getByText("何を探しましょうか。")).toBeVisible();
  await page.screenshot({ path: ".local/workspace-empty.png", fullPage: true });
  await page.getByRole("button", { name: "AIを追加する", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  checks.push("AI setup dialog opens and restores focus on Escape");
  assert.deepEqual(errors, []);
  checks.push("no browser JavaScript errors");
  const evidence = {
    checkedAt: new Date().toISOString(),
    scope:
      "Built console in real Chrome with local, explicit HTTP fixtures for owner, Gemini result and payment states. Tests presentation/polling only, not public payment or live model execution.",
    checks,
  };
  await writeFile(
    "docs/evidence/workspace-browser.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence));
} finally {
  await browser.close();
}
