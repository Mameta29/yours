import { createServer, type Server } from "node:http";
import {
  randomBytes,
  randomUUID,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import { createDb, migrate } from "@yours/storage";
import { sha256 } from "@yours/domain";
import { createApp } from "../src/app.js";
import { readConfig } from "../src/config.js";

const db = createDb(
  process.env.TEST_DATABASE_URL ?? "postgresql://localhost/yours_test",
);
const account = randomUUID(),
  connection = randomUUID(),
  session = randomBytes(32).toString("base64url");
const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const signer = {
  kid: "run-test",
  publicJwk: {
    ...pair.publicKey.export({ format: "jwk" }),
    kid: "run-test",
    alg: "ES256",
    use: "sig",
  },
  sign: async (bytes: Uint8Array) =>
    new Uint8Array(
      sign("sha256", bytes, {
        key: pair.privateKey,
        dsaEncoding: "ieee-p1363",
      }),
    ),
};
let server: Server,
  app: ReturnType<typeof createApp>,
  calls = 0,
  lastToken = "",
  duringStatus = 0,
  ownerStatus = 0;
const headers = {
  "Content-Type": "application/json",
  Origin: "http://localhost:8080",
  Cookie: "yours_session=" + session,
};
beforeAll(async () => {
  await migrate(db);
  await db.query(
    "INSERT INTO accounts(id,address,chain_id) VALUES($1,$2,80002)",
    [account, "0x" + randomBytes(20).toString("hex")],
  );
  await db.query(
    "INSERT INTO connections(id,account_id,name,provider,agent_address,token_hash,status) VALUES($1,$2,'ADK test','gemini',$3,$4,'active')",
    [
      connection,
      account,
      "0x" + randomBytes(20).toString("hex"),
      sha256(randomUUID()),
    ],
  );
  await db.query(
    "INSERT INTO owner_sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [sha256(session), account],
  );
  // This transport test doubles only the model runner; authentication and storage
  // are real. Live Gemini evidence is recorded separately after cloud execution.
  server = createServer(async (req, res) => {
    calls++;
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    lastToken = body.agent_token;
    if (lastToken) {
      duringStatus = (
        await app.request("/api/agent/tasks", {
          headers: { Authorization: "Bearer " + lastToken },
        })
      ).status;
      ownerStatus = (
        await app.request("/api/owner/me", {
          headers: { Authorization: "Bearer " + lastToken },
        })
      ).status;
    }
    res.setHeader("Content-Type", "application/json");
    if (body.message === "fail") {
      res.statusCode = 500;
      res.end("{}");
      return;
    }
    res.end(
      JSON.stringify({
        text: "transport test",
        events: [],
        readOnly: !lastToken,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  app = createApp(
    db,
    readConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://localhost/yours_test",
      PUBLIC_ORIGIN: "http://localhost:8080",
      AGENT_URL: "http://127.0.0.1:" + port,
    }),
    signer,
  );
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.end();
});
const post = (body: unknown) =>
  app.request("/api/owner/runs", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
it("issues an agent-only run credential and invalidates it on completion; retries do not rerun", async () => {
  const body = {
    requestId: randomUUID(),
    connectionId: connection,
    message: "商品を調べて",
  };
  const response = await post(body);
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(duringStatus).toBe(200);
  expect(ownerStatus).toBe(403);
  expect(
    (
      await app.request("/api/agent/tasks", {
        headers: { Authorization: "Bearer " + lastToken },
      })
    ).status,
  ).toBe(401);
  const count = calls;
  expect((await (await post(body)).json()).id).toBe(result.id);
  expect(calls).toBe(count);
  expect((await post({ ...body, message: "different" })).status).toBe(409);
  expect(JSON.stringify(result)).not.toContain(lastToken);
  const history = await (
    await app.request("/api/owner/runs", { headers })
  ).json();
  expect(history.runs.find((run: any) => run.id === result.id)).toMatchObject({
    client_request_id: body.requestId,
    connection_id: connection,
    mandate_id: null,
    status: "completed",
  });
  expect(JSON.stringify(history)).not.toContain(lastToken);
  expect((await app.request("/api/owner/runs")).status).toBe(401);
});
it("invalidates the credential when the private runner fails", async () => {
  expect(
    (
      await post({
        requestId: randomUUID(),
        connectionId: connection,
        message: "fail",
      })
    ).status,
  ).toBe(502);
  expect(
    (
      await app.request("/api/agent/tasks", {
        headers: { Authorization: "Bearer " + lastToken },
      })
    ).status,
  ).toBe(401);
});
it("does not issue spending credentials for read-only conversations or foreign connections", async () => {
  const response = await post({
    requestId: randomUUID(),
    message: "検索してください",
  });
  expect(response.status).toBe(200);
  expect(lastToken).toBe(null);
  expect(
    (
      await post({
        requestId: randomUUID(),
        connectionId: randomUUID(),
        message: "買って",
      })
    ).status,
  ).toBe(403);
});

it("public trial cannot receive an agent credential and enforces same-origin requests", async () => {
  const response = await app.request("/api/demo/runs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:8080",
      "X-Forwarded-For": randomUUID(),
    },
    body: JSON.stringify({ message: "商品を探して" }),
  });
  expect(response.status).toBe(200);
  expect((await response.json()).result.readOnly).toBe(true);
  expect(lastToken).toBe(null);
  const foreign = await app.request("/api/demo/runs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://evil.example",
    },
    body: JSON.stringify({ message: "商品を探して" }),
  });
  expect(foreign.status).toBe(403);
  const injected = await app.request("/api/demo/runs", {
    method: "POST",
    headers,
    body: JSON.stringify({
      message: "商品を探して",
      agent_token: "must-not-be-forwarded",
    }),
  });
  expect(injected.status).toBe(422);
});
