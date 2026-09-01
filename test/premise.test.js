/* ============================================================
   Houses & Humans — Phase 2A tests (spine/hook premise)
   Deterministic: every provider call goes to a local mock Open
   WebUI server. No live/authenticated provider requests are made.
   ============================================================ */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createApp } = require("../server");

const MOCK_KEY = "test-owu-key";
const FIXTURE_PROMPT = path.join(__dirname, "fixtures", "system-prompt.txt");
const JSON_HEADERS = { "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PREMISE_FAIL_MESSAGE = "The adventure could not be prepared. Please try again.";

// ---------- Mock Open WebUI ----------
function startMockOwu() {
  const state = {
    premiseCalls: 0,
    premiseBodies: [],
    chatCalls: 0,
  };
  const server = http.createServer((req, res) => {
    res.on("error", () => {
      /* client aborted mid-stream; never crash the mock */
    });
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/api/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "dd-5e" }] }));
    }
    if (url.pathname !== "/api/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "mock: not found" } }));
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* malformed body: treat as empty */
      }
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
        state.premiseCalls += 1;
        state.premiseBodies.push(body);
        const userContent = String(
          ((body.messages || []).find((m) => m.role === "user") || {}).content || ""
        );
        const scenario = /TRIGGER_([A-Z_]+)/.exec(userContent);
        const key = scenario ? scenario[1] : "";

        if (key === "HTTP") {
          res.writeHead(500, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: { message: "mock premise boom" } }));
        }
        if (key === "SLOW") {
          await sleep(800);
          if (res.destroyed || res.writableEnded) return;
        }
        // Deterministic valid premise derived from the request itself, so
        // tests can prove exactly which inputs reached the generator.
        const nameMatch = /- Name: (\S+)/.exec(userContent);
        const name = nameMatch ? nameMatch[1] : "the hero";
        const curMatch = /CURRENT PLAYER MESSAGE \(first message of the adventure\):\s*\n\s*([^\n]+)/.exec(
          userContent
        );
        const cur = curMatch ? curMatch[1].trim().slice(0, 60) : "the player's first step";
        const premise = {
          spine: "A dead god stirs beneath the moors, drawn to " + name + ".",
          hook: "The adventure opens as " + name + " faces: " + cur,
        };
        let content = JSON.stringify(premise);
        if (key === "GARBAGE") {
          content = "definitely not json at all";
        } else if (key === "FENCE") {
          content = "```json\n" + content + "\n```";
        } else if (key === "TRAILING") {
          content = content + "\n(here you go, hope that helps!)";
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            choices: [{ message: { content }, finish_reason: "stop" }],
          })
        );
      }

      // Normal chat call: deterministic SSE with a composed-messages echo.
      state.chatCalls += 1;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.write(
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
      res.write('data: {"choices":[{"delta":{"content":"The "}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"tale "}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"begins."}}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      res.end("data: [DONE]\n\n");
    });
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
const tempFiles = [];

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
  for (const f of tempFiles) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(f + suffix);
      } catch {
        /* best effort; temp dir */
      }
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

async function getAdventure(userId, id) {
  const res = await fetch(`${base}/api/adventures`, {
    headers: { "X-User-Id": userId },
  });
  const data = await res.json();
  return data.adventures.find((a) => a.id === id) || null;
}

function echoMessages(sseText) {
  const echoLine = sseText.split("\n\n").find((l) => l.includes("mock_echo"));
  assert.ok(echoLine, "mock echo line present");
  return JSON.parse(echoLine.replace(/^data: /, "")).mock_echo.messages;
}

// ---------- Tests ----------
test("first turn generates and persists one premise", async () => {
  const before = mockState.premiseCalls;
  const adv = await createAdventure("user-gen-01", {
    name: "Elara",
    race: "Half-elf",
    classes: [],
    hp: "24",
    notes: "",
  });
  const res = await postChat("user-gen-01", {
    adventureId: adv.id,
    messages: [{ role: "user", content: "I walk into the inn." }],
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
  await res.text();
  assert.equal(mockState.premiseCalls - before, 1, "exactly one premise call");

  const stored = await getAdventure("user-gen-01", adv.id);
  assert.ok(stored.spine && stored.hook, "spine and hook persisted");
  assert.ok(stored.spine.includes("Elara"), "premise derived from the character snapshot");
});

test("later turns never regenerate the premise", async () => {
  const before = mockState.premiseCalls;
  const adv = await createAdventure("user-reuse-01", {
    name: "Garrick",
    race: "Human",
    classes: [],
    hp: "",
    notes: "",
  });
  const first = await postChat("user-reuse-01", {
    adventureId: adv.id,
    messages: [{ role: "user", content: "Hello." }],
  });
  await first.text();
  const second = await postChat("user-reuse-01", {
    adventureId: adv.id,
    messages: [
      { role: "user", content: "Hello." },
      { role: "assistant", content: "The innkeeper nods." },
      { role: "user", content: "I order a drink." },
    ],
  });
  const text = await second.text();
  assert.equal(mockState.premiseCalls - before, 1, "no regeneration on later turns");

  const stored = await getAdventure("user-reuse-01", adv.id);
  const echo = echoMessages(text);
  const ctx = echo.find(
    (m) => m.role === "system" && m.content.includes("ADVENTURE CONTEXT")
  );
  assert.ok(ctx, "adventure context injected");
  assert.ok(ctx.content.includes(stored.spine), "same spine injected on later turns");
  assert.ok(ctx.content.includes(stored.hook), "same hook injected on later turns");
});

test("premise input scope: character snapshot + current message only, plus knowledge references", async () => {
  const adv = await createAdventure("user-scope-01", {
    name: "Elara",
    race: "Half-elf",
    classes: [],
    hp: "",
    notes: "",
  });
  const res = await postChat("user-scope-01", {
    adventureId: adv.id,
    messages: [
      { role: "user", content: "first light" },
      { role: "assistant", content: "HISTORY_SHOULD_NOT_APPEAR_12345" },
      { role: "user", content: "I draw my blade." },
    ],
  });
  await res.text();
  assert.ok(mockState.premiseBodies.length >= 1);
  const premiseBody = mockState.premiseBodies[mockState.premiseBodies.length - 1];
  assert.equal(premiseBody.stream, false);
  assert.equal(premiseBody.model, "dd-5e");
  const prompt = premiseBody.messages.find((m) => m.role === "user").content;
  assert.ok(prompt.includes("- Name: Elara"), "character snapshot included");
  assert.ok(prompt.includes("I draw my blade."), "current player message included");
  assert.ok(prompt.includes("50 Campaign Spines"), "spine knowledge reference included");
  assert.ok(prompt.includes("Plot Hooks.txt"), "hook knowledge reference included");
  assert.ok(!prompt.includes("first light"), "prior user history excluded");
  assert.ok(
    !prompt.includes("HISTORY_SHOULD_NOT_APPEAR_12345"),
    "prior assistant history excluded"
  );
  const stored = await getAdventure("user-scope-01", adv.id);
  assert.ok(stored.hook.includes("I draw my blade."), "hook tailored by the current message");
});

test("lenient parsing: fenced JSON is accepted", async () => {
  const adv = await createAdventure("user-fence-01", { name: "Elara", race: "", classes: [], hp: "", notes: "" });
  const res = await postChat("user-fence-01", {
    adventureId: adv.id,
    messages: [{ role: "user", content: "TRIGGER_FENCE" }],
  });
  assert.equal(res.status, 200);
  await res.text();
  const stored = await getAdventure("user-fence-01", adv.id);
  assert.ok(stored.spine && stored.hook, "fenced JSON parsed and persisted");
});

test("lenient parsing: trailing prose after JSON is accepted", async () => {
  const adv = await createAdventure("user-trail-01", { name: "Elara", race: "", classes: [], hp: "", notes: "" });
  const res = await postChat("user-trail-01", {
    adventureId: adv.id,
    messages: [{ role: "user", content: "TRIGGER_TRAILING" }],
  });
  assert.equal(res.status, 200);
  await res.text();
  const stored = await getAdventure("user-trail-01", adv.id);
  assert.ok(stored.spine && stored.hook, "trailing prose tolerated");
});

test("invalid output twice fails closed with 502 and nothing persisted; retry heals", async () => {
  const before = mockState.premiseCalls;
  const adv = await createAdventure("user-bad-01", { name: "Elara", race: "", classes: [], hp: "", notes: "" });
  const res = await postChat("user-bad-01", {
    adventureId: adv.id,
    messages: [{ role: "user", content: "TRIGGER_GARBAGE" }],
  });
  assert.equal(res.status, 502, "chat must not proceed without a valid premise");
  const body = await res.json();
  assert.equal(body.error.message, PREMISE_FAIL_MESSAGE);
  assert.equal(mockState.premiseCalls - before, 2, "one retry for invalid output");

  let stored = await getAdventure("user-bad-01", adv.id);
  assert.equal(stored.spine, null);
  assert.equal(stored.hook, null);

  const heal = await postChat("user-bad-01", {
    adventureId: adv.id,
    messages: [
      { role: "user", content: "TRIGGER_GARBAGE" },
      { role: "user", content: "I try again." },
    ],
  });
  assert.equal(heal.status, 200, "retry with a healthy provider succeeds");
  await heal.text();
  stored = await getAdventure("user-bad-01", adv.id);
  assert.ok(stored.spine && stored.hook, "premise persisted after healing retry");
});

test("provider HTTP error fails closed without retry; retry heals", async () => {
  const before = mockState.premiseCalls;
  const adv = await createAdventure("user-http-01", { name: "Elara", race: "", classes: [], hp: "", notes: "" });
  const res = await postChat("user-http-01", {
    adventureId: adv.id,
    messages: [{ role: "user", content: "TRIGGER_HTTP" }],
  });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.message, PREMISE_FAIL_MESSAGE);
  assert.equal(mockState.premiseCalls - before, 1, "no retry for transport errors");

  const heal = await postChat("user-http-01", {
    adventureId: adv.id,
    messages: [
      { role: "user", content: "TRIGGER_HTTP" },
      { role: "user", content: "Let's go anyway." },
    ],
  });
  assert.equal(heal.status, 200);
  await heal.text();
  const stored = await getAdventure("user-http-01", adv.id);
  assert.ok(stored.spine && stored.hook);
});

test("concurrent first turns share one generation", async () => {
  const before = mockState.premiseCalls;
  const adv = await createAdventure("user-race-01", { name: "Mira", race: "Tiefling", classes: [], hp: "", notes: "" });
  const [r1, r2] = await Promise.all([
    postChat("user-race-01", {
      adventureId: adv.id,
      messages: [{ role: "user", content: "A" }],
    }),
    postChat("user-race-01", {
      adventureId: adv.id,
      messages: [{ role: "user", content: "B" }],
    }),
  ]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  const t1 = await r1.text();
  const t2 = await r2.text();
  assert.equal(mockState.premiseCalls - before, 1, "exactly one generation for two concurrent turns");
  const stored = await getAdventure("user-race-01", adv.id);
  for (const t of [t1, t2]) {
    const ctx = echoMessages(t).find(
      (m) => m.role === "system" && m.content.includes("ADVENTURE CONTEXT")
    );
    assert.ok(ctx.content.includes(stored.spine), "both turns use the same premise");
  }
});

test("pre-seeded premise is used verbatim and never regenerated", async () => {
  const dbPath = path.join(
    os.tmpdir(),
    "hh-premise-seed-" + process.pid + "-" + Date.now() + ".db"
  );
  tempFiles.push(dbPath);
  const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  const rawDb = new Database(dbPath);
  rawDb.exec(schema);
  const now = new Date().toISOString();
  const seededId = "seed-adv-0001";
  rawDb
    .prepare(
      "INSERT INTO users (id, created_at) VALUES (?, ?)"
    )
    .run("user-seed-01", now);
  rawDb
    .prepare(
      "INSERT INTO adventures (id, user_id, title, spine, hook, status, character, created_at, updated_at) " +
        "VALUES (?, ?, 'Seeded', ?, ?, 'active', '{}', ?, ?)"
    )
    .run(seededId, "user-seed-01", "SEEDED_SPINE_TEXT", "SEEDED_HOOK_TEXT", now, now);
  rawDb.close();

  const app = createApp({
    dbPath,
    owuBaseUrl: `http://127.0.0.1:${mock.port}`,
    owuApiKey: MOCK_KEY,
    devUserId: "dev-user-01",
    isProduction: false,
    systemPromptPath: FIXTURE_PROMPT,
    rateLimitPerMin: 10000,
    healthTtlMs: 0,
  });
  const s = await listen(app);
  const sbase = `http://127.0.0.1:${s.address().port}`;

  const before = mockState.premiseCalls;
  const res = await postChat(
    "user-seed-01",
    { adventureId: seededId, messages: [{ role: "user", content: "Continue." }] },
    sbase
  );
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(mockState.premiseCalls, before, "no premise call for a seeded adventure");
  const ctx = echoMessages(text).find(
    (m) => m.role === "system" && m.content.includes("ADVENTURE CONTEXT")
  );
  assert.ok(ctx.content.includes("SEEDED_SPINE_TEXT"), "seeded spine used verbatim");
  assert.ok(ctx.content.includes("SEEDED_HOOK_TEXT"), "seeded hook used verbatim");
});

test("client abort during slow generation persists nothing", async () => {
  const before = mockState.premiseCalls;
  const adv = await createAdventure("user-abort2-01", { name: "Elara", race: "", classes: [], hp: "", notes: "" });
  const ac = new AbortController();
  // Do NOT await the fetch: it resolves only once response headers arrive,
  // which is after the premise call completes. Abort while headers are
  // still pending so the in-flight generation is what gets cancelled.
  const resPromise = fetch(`${base}/api/chat/completions`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "X-User-Id": "user-abort2-01" },
    body: JSON.stringify({
      adventureId: adv.id,
      messages: [{ role: "user", content: "TRIGGER_SLOW" }],
    }),
    signal: ac.signal,
  });
  await sleep(150); // premise call is in flight (800ms)
  ac.abort();
  try {
    const res = await resPromise;
    await res.text();
  } catch {
    /* expected abort */
  }
  await sleep(900); // let the mock's delayed write no-op
  assert.equal(mockState.premiseCalls - before, 1, "generation was attempted");
  const stored = await getAdventure("user-abort2-01", adv.id);
  assert.equal(stored.spine, null, "aborted generation must not persist");
  assert.equal(stored.hook, null);
});

test("adventure creation is unchanged: fast 201 with null premise, no provider call", async () => {
  const before = mockState.premiseCalls;
  const adv = await createAdventure("user-create-01", { name: "Bran", race: "", classes: [], hp: "", notes: "" });
  assert.ok(adv.id);
  assert.equal(adv.spine, null);
  assert.equal(adv.hook, null);
  assert.equal(mockState.premiseCalls, before, "POST /api/adventures never calls the provider");
});

test("production mode fails closed with no premise call", async () => {
  const before = mockState.premiseCalls;
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
  const res = await postChat(
    "user-prod2-01",
    { adventureId: "whatever", messages: [{ role: "user", content: "hi" }] },
    pbase
  );
  assert.equal(res.status, 401);
  assert.equal(mockState.premiseCalls, before, "production never reaches premise generation");
});

test("unconfigured provider fails closed with no premise call", async () => {
  const before = mockState.premiseCalls;
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
  const advRes = await fetch(`${ubase}/api/adventures`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "X-User-Id": "user-noprov2-01" },
    body: JSON.stringify({}),
  });
  const adv = (await advRes.json()).adventure;
  const res = await postChat(
    "user-noprov2-01",
    { adventureId: adv.id, messages: [{ role: "user", content: "hi" }] },
    ubase
  );
  assert.equal(res.status, 503);
  assert.equal(mockState.premiseCalls, before, "no premise call when unconfigured");
});
