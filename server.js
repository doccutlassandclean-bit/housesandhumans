/* ============================================================
   Houses & Humans — Phase 1 backend
   Serves the static frontend same-origin and proxies chat,
   model-list, and image requests to Open WebUI with server-held
   credentials. The browser never sees the provider API key.

   Identity — DEVELOPMENT ONLY:
   - In development, clients send a stable X-User-Id header; the
     server upserts it into `users` so the multi-user data model
     can be exercised before real authentication exists. It is
     spoofable by design.
   - In production (NODE_ENV=production) no authentication exists
     yet, so every protected/token-spending route FAILS CLOSED
     with 401. X-User-Id is never consulted in production.
   ============================================================ */

const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { createDb } = require("./db");

const USER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_CHAT_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 20000;
const MAX_TITLE_CHARS = 120;
const PROVIDER_TIMEOUT_MS = 5000;

function createApp(options) {
  const opts = Object.assign(
    {
      dbPath: ":memory:",
      owuBaseUrl: "",
      owuApiKey: "",
      defaultModelId: "dd-5e",
      devUserId: "dev",
      isProduction: false,
      systemPromptPath: path.join(__dirname, "system-prompt.txt"),
      rateLimitPerMin: 30,
      healthTtlMs: 60000,
    },
    options || {}
  );

  const OWU_BASE_URL = String(opts.owuBaseUrl || "").replace(/\/+$/, "");
  const OWU_API_KEY = String(opts.owuApiKey || "");
  const DEFAULT_MODEL_ID = String(opts.defaultModelId || "dd-5e");
  const DEV_USER_ID = String(opts.devUserId || "dev");
  const providerConfigured = () => Boolean(OWU_BASE_URL && OWU_API_KEY);

  // Fail fast at boot instead of silently sending an empty DM prompt.
  const systemPrompt = fs.readFileSync(opts.systemPromptPath, "utf8");
  if (!systemPrompt.trim()) {
    throw new Error(
      "system-prompt.txt is missing or empty; refusing to boot with an empty DM prompt."
    );
  }

  // ---------- SQLite ----------
  const db = createDb(opts.dbPath);
  const stmts = {
    ensureUser: db.prepare(
      "INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)"
    ),
    listAdventures: db.prepare(
      "SELECT * FROM adventures WHERE user_id = ? ORDER BY updated_at DESC"
    ),
    getAdventure: db.prepare(
      "SELECT * FROM adventures WHERE id = ? AND user_id = ?"
    ),
    insertAdventure: db.prepare(
      "INSERT INTO adventures (id, user_id, title, spine, hook, status, character, created_at, updated_at) " +
        "VALUES (@id, @user_id, @title, NULL, NULL, 'active', @character, @now, @now)"
    ),
    updateAdventure: db.prepare(
      "UPDATE adventures SET title = @title, character = @character, updated_at = @now " +
        "WHERE id = @id AND user_id = @user_id"
    ),
  };

  function ensureUser(id) {
    stmts.ensureUser.run(id, new Date().toISOString());
  }

  function strVal(v, max) {
    return typeof v === "string" ? v.trim().slice(0, max) : "";
  }

  // Adventure-owned character snapshot: {name, race, classes:[{name,level}], hp, notes}.
  // Unknown fields are dropped; lengths and counts are clamped.
  function sanitizeCharacter(raw) {
    const out = { name: "", race: "", classes: [], hp: "", notes: "" };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    out.name = strVal(raw.name, 80);
    out.race = strVal(raw.race, 80);
    out.hp = strVal(raw.hp, 40);
    out.notes = strVal(raw.notes, 2000);
    if (Array.isArray(raw.classes)) {
      out.classes = raw.classes
        .slice(0, 3)
        .map((c) => ({
          name: strVal(c && c.name, 60),
          level: Math.min(20, Math.max(1, parseInt(c && c.level, 10) || 1)),
        }))
        .filter((c) => c.name);
    }
    return out;
  }

  function rowToAdventure(row) {
    let character = { name: "", race: "", classes: [], hp: "", notes: "" };
    try {
      character = JSON.parse(row.character);
    } catch {
      /* corrupt snapshot: fall back to empty */
    }
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      spine: row.spine,
      hook: row.hook,
      character,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ---------- System context (server-authoritative) ----------
  // The DM prompt, the adventure context, and the character snapshot are
  // assembled here. The client is only allowed to send user/assistant
  // history, so it can no longer inject system content.
  function buildSystemMessages(row) {
    const out = [{ role: "system", content: systemPrompt }];
    const adventure = rowToAdventure(row);
    if (adventure.spine || adventure.hook) {
      const lines = [
        "ADVENTURE CONTEXT (fixed for this adventure; do not contradict it):",
      ];
      if (adventure.spine) lines.push(`- Story spine: ${adventure.spine}`);
      if (adventure.hook) lines.push(`- Plot hook: ${adventure.hook}`);
      out.push({ role: "system", content: lines.join("\n") });
    }
    const c = adventure.character || {};
    const classes = (Array.isArray(c.classes) ? c.classes : [])
      .filter((k) => k && k.name)
      .map((k) => `${k.name} ${k.level}`)
      .join(" / ");
    if (c.name || c.race || classes || c.notes) {
      const lines = [
        "PLAYER CHARACTER SNAPSHOT (authoritative, player-managed — keep this in mind; ask for anything missing):",
        `- Name: ${c.name || "(not set)"}`,
        `- Race: ${c.race || "(not set)"}`,
        `- Class/Level: ${classes || "(not set)"}`,
        `- HP: ${c.hp || "(player-tracked)"}`,
      ];
      if (c.notes) lines.push(`- Visual & Backstory: ${c.notes}`);
      out.push({ role: "system", content: lines.join("\n") });
    }
    return out;
  }

  // ---------- App ----------
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  // Same-origin static serving via an explicit allowlist, so server files
  // (server.js, system-prompt.txt, *.db, .env, ...) are never reachable.
  const PUBLIC_FILES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/script.js": "script.js",
    "/style.css": "style.css",
  };
  for (const [route, file] of Object.entries(PUBLIC_FILES)) {
    app.get(route, (req, res) => res.sendFile(path.join(__dirname, file)));
  }

  // ---------- Identity (development only; production fails closed) ----------
  function requireIdentity(req, res, next) {
    if (opts.isProduction) {
      // Real authentication does not exist yet: refuse protected routes in
      // production rather than letting the spoofable header act as auth.
      return res.status(401).json({
        error: {
          message:
            "Authentication is not available yet; this route is disabled in production.",
        },
      });
    }
    const header = String(req.get("X-User-Id") || "").trim();
    const userId = USER_ID_RE.test(header) ? header : DEV_USER_ID;
    ensureUser(userId);
    req.userId = userId;
    next();
  }

  // ---------- Per-IP rate limit (chat is token-spending) ----------
  const hits = new Map(); // ip -> {count, windowStart}
  function rateLimit(req, res, next) {
    const limit = Math.max(0, Number(opts.rateLimitPerMin) || 0);
    if (!limit) return next();
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || now - entry.windowStart >= 60000) {
      hits.set(ip, { count: 1, windowStart: now });
      if (hits.size > 10000) {
        for (const [k, v] of hits) {
          if (now - v.windowStart >= 60000) hits.delete(k);
        }
      }
      return next();
    }
    entry.count += 1;
    if (entry.count > limit) {
      return res.status(429).json({
        error: { message: "Too many requests; please slow down." },
      });
    }
    next();
  }

  // ---------- Provider plumbing ----------
  function providerHeaders(extra) {
    return Object.assign(
      { Authorization: "Bearer " + OWU_API_KEY },
      extra || {}
    );
  }

  // Pipe a provider body into the response without leaving an unhandled
  // 'error' behind when the client disconnects mid-stream (the upstream
  // stream errors with AbortError after an abort).
  function pipeThrough(webBody, res) {
    const nodeStream = Readable.fromWeb(webBody);
    nodeStream.on("error", () => {
      if (!res.headersSent) {
        if (!res.writableEnded) res.status(502).end();
      } else if (!res.writableEnded) {
        res.destroy();
      }
    });
    nodeStream.pipe(res);
  }

  let healthCache = { at: 0, provider: "unknown" };
  async function checkProvider() {
    if (!providerConfigured()) return "unconfigured";
    const now = Date.now();
    if (now - healthCache.at < opts.healthTtlMs) return healthCache.provider;
    try {
      const res = await fetch(OWU_BASE_URL + "/api/models", {
        headers: providerHeaders(),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      healthCache = { at: now, provider: res.ok ? "ok" : "error" };
    } catch {
      healthCache = { at: now, provider: "error" };
    }
    return healthCache.provider;
  }

  // ---------- Routes ----------
  app.get("/api/health", async (req, res) => {
    const provider = await checkProvider();
    res.json({
      ok: true,
      provider,
      mode: opts.isProduction ? "production" : "development",
    });
  });

  app.get("/api/models", requireIdentity, async (req, res) => {
    if (!providerConfigured()) {
      return res.status(503).json({
        error: { message: "The server is not configured with a model provider." },
      });
    }
    try {
      const up = await fetch(OWU_BASE_URL + "/api/models", {
        headers: providerHeaders(),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      res.status(up.status);
      const ct = up.headers.get("content-type");
      if (ct) res.setHeader("Content-Type", ct);
      if (up.body) pipeThrough(up.body, res);
      else res.end();
    } catch {
      res.status(502).json({
        error: { message: "Could not reach the model provider." },
      });
    }
  });

  app.get("/api/adventures", requireIdentity, (req, res) => {
    const rows = stmts.listAdventures.all(req.userId);
    res.json({ adventures: rows.map(rowToAdventure) });
  });

  app.post("/api/adventures", requireIdentity, (req, res) => {
    const body = req.body || {};
    const title = strVal(body.title, MAX_TITLE_CHARS) || "New Adventure";
    const character = sanitizeCharacter(body.character);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    stmts.insertAdventure.run({
      id,
      user_id: req.userId,
      title,
      character: JSON.stringify(character),
      now,
    });
    const row = stmts.getAdventure.get(id, req.userId);
    res.status(201).json({ adventure: rowToAdventure(row) });
  });

  app.patch("/api/adventures/:id", requireIdentity, (req, res) => {
    const row = stmts.getAdventure.get(req.params.id, req.userId);
    if (!row) {
      return res
        .status(404)
        .json({ error: { message: "Adventure not found." } });
    }
    const body = req.body || {};
    const title =
      body.title !== undefined
        ? strVal(body.title, MAX_TITLE_CHARS) || row.title
        : row.title;
    const character =
      body.character !== undefined
        ? sanitizeCharacter(body.character)
        : JSON.parse(row.character);
    const now = new Date().toISOString();
    stmts.updateAdventure.run({
      title,
      character: JSON.stringify(character),
      now,
      id: row.id,
      user_id: req.userId,
    });
    res.json({
      adventure: rowToAdventure(stmts.getAdventure.get(row.id, req.userId)),
    });
  });

  app.post(
    "/api/chat/completions",
    requireIdentity,
    rateLimit,
    async (req, res) => {
      const body = req.body || {};
      const adventureId =
        typeof body.adventureId === "string" ? body.adventureId.trim() : "";
      const messages = body.messages;
      if (!adventureId) {
        return res
          .status(400)
          .json({ error: { message: "adventureId is required." } });
      }
      if (!Array.isArray(messages) || messages.length === 0) {
        return res
          .status(400)
          .json({ error: { message: "messages must be a non-empty array." } });
      }
      if (messages.length > MAX_CHAT_MESSAGES) {
        return res
          .status(400)
          .json({ error: { message: "Too many messages in this request." } });
      }
      for (const m of messages) {
        if (
          !m ||
          typeof m !== "object" ||
          (m.role !== "user" && m.role !== "assistant") ||
          typeof m.content !== "string"
        ) {
          return res.status(400).json({
            error: {
              message:
                "Each message must be {role: 'user'|'assistant', content: string}.",
            },
          });
        }
        if (m.content.length > MAX_MESSAGE_CHARS) {
          return res
            .status(400)
            .json({ error: { message: "A message is too long." } });
        }
      }
      const row = stmts.getAdventure.get(adventureId, req.userId);
      if (!row) {
        return res
          .status(404)
          .json({ error: { message: "Adventure not found." } });
      }
      if (!providerConfigured()) {
        return res.status(503).json({
          error: { message: "The server is not configured with a model provider." },
        });
      }

      const composed = buildSystemMessages(row).concat(messages);

      // Client disconnects (e.g. New Adventure cancelling a turn) abort the
      // upstream request so provider tokens stop being spent.
      const ac = new AbortController();
      const onClientGone = () => {
        if (!res.writableEnded) ac.abort();
      };
      req.on("aborted", onClientGone);
      res.on("close", onClientGone);

      let upstream;
      try {
        upstream = await fetch(OWU_BASE_URL + "/api/chat/completions", {
          method: "POST",
          headers: providerHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            model: DEFAULT_MODEL_ID,
            messages: composed,
            stream: true,
          }),
          signal: ac.signal,
        });
      } catch (err) {
        if (err && err.name === "AbortError") return res.end(); // client went away
        return res.status(502).json({
          error: { message: "Could not reach the model provider." },
        });
      }

      if (!upstream.ok) {
        // Forward the provider's status and body verbatim so the frontend's
        // existing error parser keeps producing the same messages.
        let text = "";
        try {
          text = await upstream.text();
        } catch {
          /* body read failure: fall back to the status line */
        }
        const ct = upstream.headers.get("content-type");
        res.status(upstream.status);
        if (ct) res.setHeader("Content-Type", ct);
        return res.end(text || `${upstream.status} ${upstream.statusText}`);
      }

      // Stream the SSE response through byte-for-byte: the frontend's
      // hardened stream parser keeps working unchanged.
      const ct = upstream.headers.get("content-type") || "text/event-stream";
      res.status(200);
      res.setHeader("Content-Type", ct);
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      pipeThrough(upstream.body, res);
    }
  );

  app.get("/api/images/proxy", requireIdentity, async (req, res) => {
    if (!providerConfigured()) {
      return res.status(503).json({
        error: { message: "The server is not configured with a model provider." },
      });
    }
    const raw = String(req.query.url || "").trim();
    if (!raw) {
      return res
        .status(400)
        .json({ error: { message: "Missing url parameter." } });
    }
    let target;
    try {
      target = new URL(raw, OWU_BASE_URL);
    } catch {
      return res
        .status(400)
        .json({ error: { message: "Invalid image url." } });
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return res
        .status(400)
        .json({ error: { message: "Unsupported image url scheme." } });
    }
    let base;
    try {
      base = new URL(OWU_BASE_URL);
    } catch {
      return res
        .status(503)
        .json({ error: { message: "Server misconfigured." } });
    }
    // Fail closed like the old client-side guard: only the configured
    // provider origin may be fetched with the server-held key.
    if (
      target.protocol !== base.protocol ||
      target.hostname !== base.hostname ||
      target.port !== base.port
    ) {
      return res.status(403).json({
        error: { message: "Image url is not on the configured provider origin." },
      });
    }

    const ac = new AbortController();
    const onClientGone = () => {
      if (!res.writableEnded) ac.abort();
    };
    req.on("aborted", onClientGone);
    res.on("close", onClientGone);

    let up;
    try {
      up = await fetch(target.href, {
        headers: providerHeaders(),
        redirect: "manual", // never follow a redirect with the key attached
        signal: ac.signal,
      });
    } catch (err) {
      if (err && err.name === "AbortError") return res.end();
      return res.status(502).json({
        error: { message: "Could not fetch the image." },
      });
    }
    const ct = up.headers.get("content-type") || "application/octet-stream";
    res.status(up.status);
    res.setHeader("Content-Type", ct);
    if (up.headers.get("location")) {
      res.setHeader("Location", up.headers.get("location"));
    }
    if (up.body) pipeThrough(up.body, res);
    else res.end();
  });

  app.use("/api", (req, res) =>
    res.status(404).json({ error: { message: "Not found." } })
  );

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === "entity.parse.failed") {
      return res
        .status(400)
        .json({ error: { message: "Invalid JSON body." } });
    }
    // eslint-disable-next-line no-unused-vars
    next(err);
  });

  return app;
}

if (require.main === module) {
  const cfg = {
    dbPath: process.env.DB_PATH || path.join(__dirname, "housesandhumans.db"),
    owuBaseUrl: process.env.OWU_BASE_URL || "",
    owuApiKey: process.env.OWU_API_KEY || "",
    defaultModelId: process.env.DEFAULT_MODEL_ID || "dd-5e",
    devUserId: process.env.DEV_USER_ID || "dev",
    isProduction: process.env.NODE_ENV === "production",
    rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN) || 30,
  };
  if (cfg.isProduction) {
    console.warn(
      "[housesandhumans] NODE_ENV=production: authentication does not exist yet, so every protected /api route will fail closed with 401. The static site is still served."
    );
  } else {
    console.warn(
      "[housesandhumans] Development mode: X-User-Id is a spoofable, development-only identity. Never expose this mode to real users."
    );
  }
  if (!cfg.owuBaseUrl || !cfg.owuApiKey) {
    console.warn(
      "[housesandhumans] OWU_BASE_URL / OWU_API_KEY are not set — chat, models, and image routes will answer 503 until configured."
    );
  }
  const app = createApp(cfg);
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`[housesandhumans] listening on http://localhost:${port}`);
  });
}

module.exports = { createApp };
