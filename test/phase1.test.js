/* ============================================================
   Houses & Humans — Phase 1 tests
   Deterministic: every provider call goes to a local mock Open
   WebUI server. No live/authenticated provider requests are made.
   ============================================================ */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { createApp } = require("../server");

const MOCK_KEY = "test-owu-key";
const FIXTURE_PROMPT = path.join(__dirname, "fixtures", "system-prompt.txt");
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const JSON_HEADERS = { "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Mock Open WebUI ----------
function startMockOwu() {
  const state = {
    chatRequests: 0,
    modelRequests: 0,
    abortedChat: 0,
    lastChatBody: null,
  };
  const server = http.createServer((req, res) => {
    res.on("error", () => {
      /* client aborted mid-stream; never crash the mock */
    });
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/api/models") {
      state.modelRequests += 1;
      if (req.headers.authorization !== "Bearer " + MOCK_KEY) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "mock: bad key" } }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "dd-5e", name: "D&D 5e" }] }));
    }
    if (url.pathname === "/api/chat/completions") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        let body = {};
        try {
          body = JSON.parse(raw);
        } catch {
          /* malformed body: treat as empty */
        }
        // Phase 2A: every chat turn may first trigger a non-streamed
        // premise-generation call. Answer it with a fixed valid premise and
        // leave lastChatBody for the chat call only.
        const isPremiseCall =
          body.stream === false &&
          Array.isArray(body.messages) &&
          body.messages.some(
            (m) =>
              m.role === "system" &&
              typeof m.content === "string" &&
              m.content.includes("premise generator")
          );
        if (isPremiseCall) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      '{"spine":"p1 spine","hook":"p1 hook"}',
                  },
                  finish_reason: "stop",
                },
              ],
            })
          );
        }
        state.chatRequests += 1;
        state.lastChatBody = body;
        const trigger = (name) =>
          (body.messages || []).some(
            (m) =>
              m.role === "user" &&
              typeof m.content === "string" &&
              m.content.includes("TRIGGER_" + name)
          );
        if (trigger("HTTP_ERROR")) {
          res.writeHead(401, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: { message: "mock upstream error" } }));
        }
        if (trigger("NONSSE")) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(
            JSON.stringify({
              choices: [
                { message: { content: "full completion" }, finish_reason: "stop" },
              ],
            })
          );
        }
        // Default: deterministic SSE stream. The first data line echoes the
        // composed messages so tests can assert server-side context injection.
        // Chunks are paced so the connection stays open long enough for the
        // abort-propagation test to interrupt it mid-stream.
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        const writeSafe = (chunk) => {
          if (res.destroyed || res.writableEnded) return false;
          res.write(chunk);
          return true;
        };
        writeSafe(
          "data: " +
            JSON.stringify({
              mock_echo: {
                messages: (body.messages || []).map((m) => ({
                  role: m.role,
                  content: m.content,
                })),
              },
            }) +
            "\n\n"
        );
        const chunks = [
          'data: {"choices":[{"delta":{"content":"The "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"rain "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"falls."}}]}\n\n',
        ];
        for (const c of chunks) {
          await sleep(30);
          if (!writeSafe(c)) return;
        }
        if (trigger("INSTREAM_ERROR")) {
          await sleep(30);
          if (!writeSafe('data: {"error":{"message":"mock mid-stream boom"}}\n\n')) return;
        }
        await sleep(30);
        if (!writeSafe('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')) return;
        res.end("data: [DONE]\n\n");
      });
      // Response-side abort detection: only counts when the response did NOT
      // complete (the upstream fetch was aborted mid-stream).
      let counted = false;
      res.on("close", () => {
        if (!counted && !res.writableEnded) {
          counted = true;
          state.abortedChat += 1;
        }
      });
      return;
    }
    if (url.pathname === "/api/v1/files/portrait.png") {
      if (req.headers.authorization !== "Bearer " + MOCK_KEY) {
        res.writeHead(401);
        return res.end();
      }
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(PNG_BYTES);
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "mock: not found" } }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: server.address().port, state })
    );
  });
}

// ---------- Shared fixtures ----------
let mock;
let mockState;
let appServer;
let base;
const servers = [];

async function listen(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  return server;
}

before(async () => {
  mock = await startMockOwu();
  mockState = mock.state;
  servers.push(mock.server);
  const app = createApp({
    dbPath: ":memory:",
    owuBaseUrl: `http://127.0.0.1:${mock.port}`,
    owuApiKey: MOCK_KEY,
    defaultModelId: "dd-5e",
    devUserId: "dev-user-01",
    isProduction: false,
    systemPromptPath: FIXTURE_PROMPT,
    rateLimitPerMin: 10000,
    healthTtlMs: 0,
  });
  appServer = await listen(app);
  base = `http://127.0.0.1:${appServer.address().port}`;
});

after(() => {
  for (const s of servers) {
    try {
      if (typeof s.closeAllConnections === "function") s.closeAllConnections();
    } catch {
      /* ignore */
    }
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
});

async function createAdventure(userId, character) {
  const res = await fetch(`${base}/api/adventures`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "X-User-Id": userId },
    body: JSON.stringify({ character: character || {} }),
  });
  assert.equal(res.status, 201);
  const data = await res.json();
  return data.adventure;
}

async function postChat(userId, body, appBase = base) {
  return fetch(`${appBase}/api/chat/completions`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "X-User-Id": userId },
    body: JSON.stringify(body),
  });
}

// ---------- Static serving ----------
test("serves only the public frontend files same-origin", async () => {
  const cases = [
    ["/", /text\/html/, "AI Dungeon Master"],
    ["/index.html", /text\/html/, "AI Dungeon Master"],
    ["/script.js", /javascript/, "runAssistantTurn"],
    ["/style.css", /text\/css/, "--gold"],
  ];
  for (const [p, type, needle] of cases) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get("content-type") || "", type, p);
    const text = await res.text();
    assert.ok(text.includes(needle), `${p} should contain ${needle}`);
  }
  const secrets = [
    "/server.js",
    "/db.js",
    "/schema.sql",
    "/system-prompt.txt",
    "/package.json",
    "/.env",
    "/housesandhumans.db",
    "/test/phase1.test.js",
  ];
  for (const p of secrets) {
    const res = await fetch(base + p);
    assert.equal(res.status, 404, `${p} must not be served`);
  }
});

// ---------- Health ----------
test("GET /api/health reports provider reachability without auth", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const h = await res.json();
  assert.equal(h.ok, true);
  assert.equal(h.provider, "ok");
  assert.equal(h.mode, "development");
});

// ---------- Adventures ----------
test("adventures: create, sanitize, scope by user, patch with ownership", async () => {
  const character = {
    name: " Elara ",
    race: 5,
    classes: [
      { name: "Ranger", level: 99 },
      { name: "", level: 2 },
      { name: "Bard", level: -3 },
    ],
    hp: "24/24",
    notes: "quiet",
    evil: "dropped",
  };
  const a1 = await createAdventure("user-aaaa-01", character);
  assert.ok(a1.id, "adventure id assigned");
  assert.equal(a1.title, "New Adventure");
  assert.equal(a1.spine, null);
  assert.equal(a1.hook, null);
  assert.equal(a1.status, "active");
  assert.equal(a1.character.name, "Elara");
  assert.equal(a1.character.race, "");
  assert.deepEqual(a1.character.classes, [
    { name: "Ranger", level: 20 },
    { name: "Bard", level: 1 },
  ]);
  assert.equal(a1.character.hp, "24/24");
  assert.equal(a1.character.evil, undefined);

  await createAdventure("user-bbbb-02", {});

  // Scoping: each user only sees their own adventures.
  let res = await fetch(`${base}/api/adventures`, {
    headers: { "X-User-Id": "user-aaaa-01" },
  });
  let data = await res.json();
  assert.deepEqual(
    data.adventures.map((a) => a.id),
    [a1.id]
  );
  res = await fetch(`${base}/api/adventures`, {
    headers: { "X-User-Id": "user-bbbb-02" },
  });
  data = await res.json();
  assert.equal(data.adventures.length, 1);

  // Patch by owner.
  res = await fetch(`${base}/api/adventures/${a1.id}`, {
    method: "PATCH",
    headers: { ...JSON_HEADERS, "X-User-Id": "user-aaaa-01" },
    body: JSON.stringify({
      title: "The Oak & Antler",
      character: { name: "Elara Voss" },
    }),
  });
  assert.equal(res.status, 200);
  data = await res.json();
  assert.equal(data.adventure.title, "The Oak & Antler");
  assert.equal(data.adventure.character.name, "Elara Voss");
  assert.deepEqual(data.adventure.character.classes, []);

  // Patch by non-owner is a 404.
  res = await fetch(`${base}/api/adventures/${a1.id}`, {
    method: "PATCH",
    headers: { ...JSON_HEADERS, "X-User-Id": "user-bbbb-02" },
    body: JSON.stringify({ title: "stolen" }),
  });
  assert.equal(res.status, 404);

  // Missing id is a 404.
  res = await fetch(`${base}/api/adventures/nope`, {
    method: "PATCH",
    headers: { ...JSON_HEADERS, "X-User-Id": "user-aaaa-01" },
    body: JSON.stringify({ title: "x" }),
  });
  assert.equal(res.status, 404);
});

test("development identity: missing X-User-Id falls back to DEV_USER_ID", async () => {
  const res = await fetch(`${base}/api/adventures`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 201);
  const created = (await res.json()).adventure;

  const listRes = await fetch(`${base}/api/adventures`, {
    headers: { "X-User-Id": "dev-user-01" },
  });
  const list = await listRes.json();
  assert.ok(list.adventures.some((a) => a.id === created.id));
});

// ---------- Chat proxy ----------
test("chat proxy streams SSE and injects server-side system context", async () => {
  const adv = await createAdventure("user-chat-01", {
    name: "Elara",
    race: "Half-elf",
    classes: [{ name: "Ranger", level: 3 }],
    hp: "24",
    notes: "",
  });
  const res = await postChat("user-chat-01", {
    adventureId: adv.id,
    messages: [{ role: "user", content: "Hello, innkeeper." }],
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
  const text = await res.text();
  // Wire-level checks: deltas are JSON payloads on the wire, so assert each
  // payload (and the stream terminator) rather than the joined prose.
  assert.ok(text.includes('"content":"The "'), "first delta passes through");
  assert.ok(text.includes('"content":"rain "'), "second delta passes through");
  assert.ok(text.includes('"content":"falls."'), "third delta passes through");
  assert.ok(text.includes("data: [DONE]"), "[DONE] passes through");
  assert.ok(text.includes('"finish_reason":"stop"'), "finish_reason passes through");

  const echoLine = text.split("\n\n").find((l) => l.includes("mock_echo"));
  assert.ok(echoLine, "mock echo line present");
  const echo = JSON.parse(echoLine.replace(/^data: /, "")).mock_echo;
  // Phase 2A: system context is [DM prompt, ADVENTURE CONTEXT (premise),
  // character snapshot] followed by the client's user/assistant history.
  assert.equal(echo.messages.length, 4);
  assert.equal(echo.messages[0].role, "system");
  assert.ok(
    echo.messages[0].content.includes("TEST DM PROMPT VERSION 1"),
    "server-held DM prompt is prepended"
  );
  assert.equal(echo.messages[1].role, "system");
  assert.ok(
    echo.messages[1].content.includes("- Story spine: p1 spine") &&
      echo.messages[1].content.includes("- Plot hook: p1 hook"),
    "stored premise is injected as adventure context"
  );
  assert.equal(echo.messages[2].role, "system");
  assert.ok(
    echo.messages[2].content.includes("- Name: Elara"),
    "character snapshot is injected as system context"
  );
  assert.equal(echo.messages[3].role, "user");
  assert.equal(echo.messages[3].content, "Hello, innkeeper.");
  assert.equal(mockState.lastChatBody.model, "dd-5e");
  assert.equal(mockState.lastChatBody.stream, true);
});

test("chat validation: rejects malformed requests and foreign adventures", async () => {
  const adv = await createAdventure("user-val-01", {});
  const bad = [
    [{}, 400],
    [{ adventureId: "", messages: [{ role: "user", content: "hi" }] }, 400],
    [{ adventureId: adv.id, messages: [] }, 400],
    [{ adventureId: adv.id, messages: "nope" }, 400],
    [{ adventureId: adv.id, messages: [{ role: "system", content: "hi" }] }, 400],
    [{ adventureId: adv.id, messages: [{ role: "user", content: 5 }] }, 400],
  ];
  for (const [body, expected] of bad) {
    const res = await postChat("user-val-01", body);
    assert.equal(res.status, expected, JSON.stringify(body));
  }
  const other = await createAdventure("user-other-99", {});
  const res = await postChat("user-val-01", {
    adventureId: other.id,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(res.status, 404, "foreign adventure must not be usable");
});

test("chat proxy forwards provider HTTP errors verbatim", async () => {
  const adv = await createAdventure("user-err-01", {});
  const res = await postChat("user-err-01", {
    adventureId: adv.id,
    messages: [{ role: "user", content: "TRIGGER_HTTP_ERROR" }],
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.message, "mock upstream error");
});

test("chat proxy passes through non-stream JSON completions", async () => {
  const adv = await createAdventure("user-nonsse-01", {});
  const res = await postChat("user-nonsse-01", {
    adventureId: adv.id,
    messages: [{ role: "user", content: "TRIGGER_NONSSE" }],
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /application\/json/);
  const data = await res.json();
  assert.equal(data.choices[0].message.content, "full completion");
});

test("in-stream provider errors pass through the SSE stream", async () => {
  const adv = await createAdventure("user-streamerr-01", {});
  const res = await postChat("user-streamerr-01", {
    adventureId: adv.id,
    messages: [{ role: "user", content: "TRIGGER_INSTREAM_ERROR" }],
  });
  const text = await res.text();
  assert.ok(text.includes("mock mid-stream boom"));
});

test("client abort propagates upstream to the provider", async () => {
  const adv = await createAdventure("user-abort-01", {});
  const abortedBefore = mockState.abortedChat;
  const ac = new AbortController();
  const res = await fetch(`${base}/api/chat/completions`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "X-User-Id": "user-abort-01" },
    body: JSON.stringify({
      adventureId: adv.id,
      messages: [{ role: "user", content: "hi" }],
    }),
    signal: ac.signal,
  });
  const reader = res.body.getReader();
  await reader.read(); // first chunk arrived
  ac.abort();
  try {
    await reader.read();
  } catch {
    /* expected abort */
  }
  let sawAbort = false;
  for (let i = 0; i < 40; i++) {
    await sleep(50);
    if (mockState.abortedChat > abortedBefore) {
      sawAbort = true;
      break;
    }
  }
  assert.ok(sawAbort, "provider request must be aborted on client disconnect");
});

// ---------- Image proxy ----------
test("image proxy only serves the configured provider origin, with the server key", async () => {
  const good = [
    `/api/images/proxy?url=${encodeURIComponent("/api/v1/files/portrait.png")}`,
    `/api/images/proxy?url=${encodeURIComponent(
      `http://127.0.0.1:${mock.port}/api/v1/files/portrait.png`
    )}`,
  ];
  for (const p of good) {
    const res = await fetch(base + p, { headers: { "X-User-Id": "user-img-01" } });
    assert.equal(res.status, 200, p);
    assert.equal(res.headers.get("content-type"), "image/png", p);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], p);
  }
  let res = await fetch(
    `${base}/api/images/proxy?url=${encodeURIComponent("http://evil.example/portrait.png")}`,
    { headers: { "X-User-Id": "user-img-01" } }
  );
  assert.equal(res.status, 403, "foreign origin must be refused");
  res = await fetch(
    `${base}/api/images/proxy?url=${encodeURIComponent("javascript:alert(1)")}`,
    { headers: { "X-User-Id": "user-img-01" } }
  );
  assert.equal(res.status, 400, "non-http scheme must be refused");
  res = await fetch(`${base}/api/images/proxy`, {
    headers: { "X-User-Id": "user-img-01" },
  });
  assert.equal(res.status, 400, "missing url must be refused");
});

// ---------- Rate limiting ----------
test("per-IP rate limit applies to the chat route", async () => {
  const app = createApp({
    dbPath: ":memory:",
    owuBaseUrl: `http://127.0.0.1:${mock.port}`,
    owuApiKey: MOCK_KEY,
    devUserId: "dev-user-01",
    isProduction: false,
    systemPromptPath: FIXTURE_PROMPT,
    rateLimitPerMin: 2,
    healthTtlMs: 0,
  });
  const s = await listen(app);
  const rbase = `http://127.0.0.1:${s.address().port}`;
  const advRes = await fetch(`${rbase}/api/adventures`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "X-User-Id": "user-rate-01" },
    body: JSON.stringify({}),
  });
  const adv = (await advRes.json()).adventure;
  const statuses = [];
  for (let i = 0; i < 3; i++) {
    const res = await postChat(
      "user-rate-01",
      {
        adventureId: adv.id,
        messages: [{ role: "user", content: "hi" }],
      },
      rbase
    );
    await res.text();
    statuses.push(res.status);
  }
  assert.deepEqual(statuses, [200, 200, 429]);
});

// ---------- Production fail-closed ----------
test("production mode fails closed on all protected routes and never calls the provider", async () => {
  const app = createApp({
    dbPath: ":memory:",
    owuBaseUrl: `http://127.0.0.1:${mock.port}`,
    owuApiKey: MOCK_KEY,
    devUserId: "dev-user-01",
    isProduction: true,
    systemPromptPath: FIXTURE_PROMPT,
    rateLimitPerMin: 0,
  });
  const s = await listen(app);
  const pbase = `http://127.0.0.1:${s.address().port}`;

  const page = await fetch(pbase + "/");
  assert.equal(page.status, 200, "static site must still be served");

  const health = await (await fetch(pbase + "/api/health")).json();
  assert.equal(health.ok, true);
  assert.equal(health.mode, "production");

  // Health is public and may probe the provider; capture the baseline
  // AFTER it so the fail-closed assertion below is exact.
  const chatBefore = mockState.chatRequests;
  const modelsBefore = mockState.modelRequests;

  const cases = [
    ["GET", "/api/adventures", undefined],
    ["POST", "/api/adventures", {}],
    ["PATCH", "/api/adventures/whatever", {}],
    ["GET", "/api/models", undefined],
    ["GET", "/api/images/proxy?url=/x.png", undefined],
    ["POST", "/api/chat/completions", { adventureId: "a", messages: [] }],
  ];
  for (const [method, p, body] of cases) {
    const res = await fetch(pbase + p, {
      method,
      headers: { ...JSON_HEADERS, "X-User-Id": "user-prod-01" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(res.status, 401, `${method} ${p} must fail closed in production`);
  }
  assert.equal(mockState.chatRequests, chatBefore, "no provider chat request in production");
  assert.equal(mockState.modelRequests, modelsBefore, "no provider models request in production");
});

// ---------- Unconfigured provider ----------
test("unconfigured provider: chat/models/images answer 503, health reports unconfigured", async () => {
  const app = createApp({
    dbPath: ":memory:",
    owuBaseUrl: "",
    owuApiKey: "",
    devUserId: "dev-user-01",
    isProduction: false,
    systemPromptPath: FIXTURE_PROMPT,
    rateLimitPerMin: 0,
  });
  const s = await listen(app);
  const ubase = `http://127.0.0.1:${s.address().port}`;

  const h = await (await fetch(ubase + "/api/health")).json();
  assert.equal(h.ok, true);
  assert.equal(h.provider, "unconfigured");

  const advRes = await fetch(`${ubase}/api/adventures`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "X-User-Id": "user-noprov-01" },
    body: JSON.stringify({}),
  });
  const adv = (await advRes.json()).adventure;

  const chat = await postChat(
    "user-noprov-01",
    {
      adventureId: adv.id,
      messages: [{ role: "user", content: "hi" }],
    },
    ubase
  );
  assert.equal(chat.status, 503);

  const models = await fetch(`${ubase}/api/models`, {
    headers: { "X-User-Id": "user-noprov-01" },
  });
  assert.equal(models.status, 503);
});
