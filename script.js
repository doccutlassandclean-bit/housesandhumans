/* ============================================================
   D&D 5.5e — AI Dungeon Master (Houses & Humans, Phase 1)
   Chat client for the Houses & Humans backend, which proxies
   Open WebUI server-side. The browser holds no API keys.
   Text-only DM: image generation, the gallery sidebar, and voice
   settings have been removed. Markdown images already present in
   saved history still render inline and open in the lightbox.
   ============================================================ */

const DEBUG_STREAM =
  new URLSearchParams(location.search).get("debug") === "1";

// Safe load of the message history. Malformed JSON, a non-array value, or
// entries that don't match the message shape are cleared and ignored so they
// can never break boot or later code paths.
function safeLoadMessages(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    localStorage.removeItem(key);
    return [];
  }
  if (!Array.isArray(parsed)) {
    localStorage.removeItem(key);
    return [];
  }
  return parsed.filter(
    (m) =>
      m &&
      typeof m === "object" &&
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string"
  );
}

// Development-only identity: a stable, locally generated id sent as
// X-User-Id. It is spoofable by design and exists only until real
// authentication is implemented (the server rejects it in production).
function makeUserId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function getOrCreateUserId() {
  const USER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
  const existing = localStorage.getItem("hh_user_id");
  if (existing && USER_ID_RE.test(existing)) return existing;
  const id = makeUserId();
  localStorage.setItem("hh_user_id", id);
  return id;
}

const state = {
  userId: getOrCreateUserId(),
  activeAdventure: null, // adventure object from the backend (id/title/spine/hook/character)
  messages: [],
  streaming: false,
  activeChatController: null, // AbortController for the in-flight chat request
  turnSeq: 0, // bumped by New Adventure to invalidate stale turns
};

function messagesKey() {
  return state.activeAdventure
    ? "dnd_messages:" + state.activeAdventure.id
    : "dnd_messages"; // pre-adventure edge case only
}

// ---------- DOM refs ----------
const chatLog = document.getElementById("chatLog");
const chatForm = document.getElementById("chatForm");
const messageInput = document.getElementById("messageInput");
const typingIndicator = document.getElementById("typingIndicator");
const connectionStatus = document.getElementById("connectionStatus");

const newAdventureBtn = document.getElementById("newAdventureBtn");

const characterForm = document.getElementById("characterForm");
const charName = document.getElementById("charName");
const charRace = document.getElementById("charRace");
const classList = document.getElementById("classList");
const addClassBtn = document.getElementById("addClassBtn");
const charLevel = document.getElementById("charLevel");
const charHP = document.getElementById("charHP");
const charNotes = document.getElementById("charNotes");
const charSavedHint = document.getElementById("charSavedHint");

const diceResult = document.getElementById("diceResult");

const imageLightbox = document.getElementById("imageLightbox");
const imageLightboxImg = document.getElementById("imageLightboxImg");
const imageLightboxOpen = document.getElementById("imageLightboxOpen");
const imageLightboxClose = document.getElementById("imageLightboxClose");

// ---------- Text-to-speech (per-message 🔊 buttons only; no settings) ----------
const ttsSupported = "speechSynthesis" in window;

function pickVoice() {
  if (!ttsSupported) return null;
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find((v) => (v.lang || "").toLowerCase().startsWith("en")) ||
    voices[0] ||
    null
  );
}

function stripForSpeech(text) {
  return String(text || "")
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/[*_`#>]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function speak(text) {
  if (!ttsSupported || !text) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(stripForSpeech(text));
  const voice = pickVoice();
  if (voice) u.voice = voice;
  u.rate = 1;
  u.pitch = 1;
  window.speechSynthesis.speak(u);
}

// The DM system prompt now lives server-side (system-prompt.txt) and is
// prepended by the backend together with the adventure context and the
// character snapshot. The browser sends only user/assistant history.

// ---------- Utilities & text formatting ----------
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function extractMarkdownImages(text) {
  if (!text) return [];
  const out = [];
  const re = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g;
  let m;
  while ((m = re.exec(String(text)))) out.push({ alt: m[1], url: m[2] });
  return out;
}

// Render text to HTML. Markdown images become lightbox-ready anchors
// (display only — nothing is generated here).
function formatMessageText(text) {
  const raw = String(text || "");
  const images = [];
  const working = raw.replace(
    /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g,
    (m, alt, url) => {
      images.push({ alt, url });
      return "\u0000IMG" + (images.length - 1) + "\u0000";
    }
  );
  let html = escapeHtml(working);
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  html = html.replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>");
  html = html.replace(
    /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  html = html.replace(/\n/g, "<br />");
  html = html.replace(/\u0000IMG(\d+)\u0000/g, (m, i) => {
    const img = images[Number(i)];
    if (!img) return "";
    const resolved = resolveImageUrl(img.url);
    if (!isSafeImageUrl(resolved)) return ""; // fail closed: no executable URLs
    const src = escapeHtml(resolved);
    const alt = escapeHtml(img.alt || "Image");
    return `<a href="${src}" target="_blank" rel="noopener noreferrer" class="chat-image-link"><img src="${src}" alt="${alt}" class="chat-image" loading="lazy" referrerpolicy="no-referrer" /></a>`;
  });
  return html;
}

// ---------- Image display helpers (existing images only) ----------
// Relative image URLs (emitted by the model for provider-hosted files)
// are routed through the backend's authenticated image proxy; absolute
// URLs are left untouched so external images keep loading directly.
function resolveImageUrl(url) {
  if (!url) return "";
  if (url.startsWith("blob:") || url.startsWith("data:") || /^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return "/api/images/proxy?url=" + encodeURIComponent(url);
  return url;
}

// ---------- URL safety ----------
// Display/render allowlist: only schemes this app genuinely uses may be
// placed into <img>/<a> attributes or opened from the lightbox. Same-origin
// relative paths ("/api/images/proxy?...") are allowed for proxied images;
// everything else (javascript:, vbscript:, data:text/html, file:, ...) is
// rejected. Provider credentials never leave the backend anymore, so the
// old client-side same-origin API-key guard is gone.
const SAFE_IMAGE_SCHEME_RE = /^(https?:|blob:|data:image\/|\/)/i;
function isSafeImageUrl(url) {
  if (!url) return false;
  return SAFE_IMAGE_SCHEME_RE.test(String(url).trim());
}

function createImageAnchor(url, alt) {
  const src = resolveImageUrl(url);
  if (!isSafeImageUrl(src)) return null;
  const anchor = document.createElement("a");
  anchor.className = "chat-image-link";
  anchor.href = src;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  const img = document.createElement("img");
  img.className = "chat-image";
  img.alt = alt || "Image";
  img.src = src;
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  anchor.appendChild(img);
  return anchor;
}

// Hydrate a provider-hosted image through the backend proxy, which holds
// the provider credentials server-side and only proxies URLs on the
// configured provider origin.
async function fetchImageViaProxy(url) {
  const res = await fetch(
    "/api/images/proxy?url=" + encodeURIComponent(url),
    { headers: { "X-User-Id": state.userId } }
  );
  if (!res.ok) throw new Error("HTTP " + res.status);
  return URL.createObjectURL(await res.blob());
}

async function hydrateImages() {
  const images = Array.from(chatLog.querySelectorAll("img.chat-image"));
  for (const imgEl of images) {
    const src = imgEl.getAttribute("src") || "";
    if (!src || src.startsWith("blob:") || src.startsWith("data:")) continue;
    if (src.startsWith("/api/images/proxy")) continue; // already proxied at render time
    // Absolute provider-hosted URLs fail without credentials; retry once
    // through the backend's authenticated proxy, which only accepts URLs
    // on the configured provider origin. External images load directly.
    const swap = async () => {
      imgEl.onerror = null;
      try {
        const objectUrl = await fetchImageViaProxy(src);
        imgEl.src = objectUrl;
        const anchor = imgEl.closest("a");
        if (anchor) anchor.href = src;
      } catch {
        /* leave direct URL */
      }
    };
    if (imgEl.complete && imgEl.naturalWidth === 0) {
      swap(); // failed before this handler attached
    } else {
      imgEl.onerror = swap;
    }
  }
}

// ---------- UI helpers ----------
function updateConnectionPill(kind, text) {
  connectionStatus.className = `status-pill status-${kind}`;
  connectionStatus.textContent = `● ${text}`;
}

function scrollToBottom() {
  chatLog.scrollTop = chatLog.scrollHeight;
}

function persistMessages() {
  localStorage.setItem(messagesKey(), JSON.stringify(state.messages));
}

// ---------- Lightbox (view existing images in-page; never downloads) ----------
function openImageLightbox(src, alt) {
  if (!isSafeImageUrl(src)) return; // never display executable/unsafe URLs
  imageLightboxImg.src = src;
  imageLightboxImg.alt = alt || "Image preview";
  imageLightboxOpen.dataset.src = src;
  imageLightbox.classList.remove("hidden");
  document.body.classList.add("lightbox-open");
}

function closeImageLightbox() {
  imageLightbox.classList.add("hidden");
  imageLightboxImg.src = "";
  document.body.classList.remove("lightbox-open");
}

// Delegated: covers markdown-rendered images, including re-rendered history.
chatLog.addEventListener("click", (e) => {
  const img = e.target.closest("img.chat-image");
  if (!img) return;
  if (img.closest("a.chat-image-link")) e.preventDefault();
  openImageLightbox(img.currentSrc || img.src, img.alt);
});

imageLightbox.addEventListener("click", (e) => {
  if (e.target === imageLightbox) closeImageLightbox();
});
imageLightboxClose.addEventListener("click", closeImageLightbox);
imageLightboxOpen.addEventListener("click", (e) => {
  e.preventDefault();
  const src = imageLightboxOpen.dataset.src;
  if (!src) return;
  const resolved = resolveImageUrl(src);
  // Only safe display schemes may ever be opened in a new tab.
  if (!isSafeImageUrl(resolved)) return;
  window.open(resolved, "_blank", "noopener");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !imageLightbox.classList.contains("hidden")) {
    closeImageLightbox();
  }
});

// ---------- Bubbles ----------
function appendMessageBubble(role, content) {
  const div = document.createElement("div");
  div.className = `message ${role === "user" ? "user" : "assistant"}`;

  const header = document.createElement("div");
  header.className = "message-header";
  const label = document.createElement("span");
  label.className = "role-label";
  label.textContent = role === "user" ? "You" : "Dungeon Master";
  header.appendChild(label);

  if (role === "assistant") {
    const speakBtn = document.createElement("button");
    speakBtn.type = "button";
    speakBtn.className = "speak-btn";
    speakBtn.title = "Read this aloud";
    speakBtn.textContent = "🔊";
    speakBtn.addEventListener("click", () => {
      const segments = Array.from(div.querySelectorAll(".message-text"));
      const joined = segments.map((t) => t.textContent || "").join(" ");
      speak(joined || content || "");
    });
    header.appendChild(speakBtn);
  }

  const body = document.createElement("div");
  body.className = "message-body";

  const addTextSegment = (text) => {
    const seg = document.createElement("div");
    seg.className = "message-text";
    seg.innerHTML = formatMessageText(text);
    body.appendChild(seg);
    return seg;
  };

  const rawContent = String(content || "");
  const mdImgs = extractMarkdownImages(rawContent);

  if (role === "assistant" && mdImgs.length) {
    // Interleave text and already-existing markdown images in story order.
    let rest = rawContent;
    for (;;) {
      const m = /!\[[^\]]*\]\(([^)]*)\)/.exec(rest);
      if (!m) {
        if (rest.trim()) addTextSegment(rest);
        break;
      }
      if (rest.slice(0, m.index).trim()) addTextSegment(rest.slice(0, m.index));
      const found =
        mdImgs.find((mi) => mi.url === m[1].trim()) || { url: m[1], alt: "" };
      const wrap = document.createElement("div");
      wrap.className = "message-images inline";
      const anchor = createImageAnchor(found.url, found.alt || "Image");
      if (anchor) wrap.appendChild(anchor);
      body.appendChild(wrap);
      rest = rest.slice(m.index + m[0].length);
    }
    const lastNode = body.lastElementChild;
    if (!lastNode || !lastNode.classList.contains("message-text")) {
      addTextSegment("");
    }
  } else {
    addTextSegment(rawContent);
  }

  div.appendChild(header);
  div.appendChild(body);
  chatLog.appendChild(div);
  scrollToBottom();
  return div;
}

function renderMessages() {
  chatLog.innerHTML = "";
  if (!state.messages.length) {
    const scene = document.createElement("div");
    scene.className = "scene-message";
    scene.innerHTML =
      "🕯️ The candlelight flickers across an old tavern table. Your Dungeon Master awaits..." +
      "<br />Say hello to begin your adventure.";
    chatLog.appendChild(scene);
    return;
  }
  for (const msg of state.messages) {
    if (msg.role === "user" || msg.role === "assistant") {
      appendMessageBubble(msg.role, msg.content);
    }
  }
  hydrateImages();
}

// ---------- Dice tray ----------
document.querySelectorAll(".die").forEach((btn) => {
  btn.addEventListener("click", () => {
    const sides = parseInt(btn.dataset.die, 10);
    const roll = 1 + Math.floor(Math.random() * sides);
    diceResult.textContent = `🎲 d${sides} → ${roll}`;
  });
});

// ---------- Character sheet ----------
const CLASS_OPTIONS = ["Artificer","Barbarian", "Bard", "Cleric", "Druid", "Fighter", "Monk", "Paladin", "Pugilist", "Ranger", "Rogue", "Sorcerer", "Warlock", "Wizard"];
let charData = { name: "", race: "", classes: [{ name: "", level: 1 }], hp: "", notes: "" };

function updateCharLevel() {
  let total = 0;
  classList.querySelectorAll(".class-row").forEach((row) => {
    const sel = row.querySelector("select");
    const lvl = parseInt(row.querySelector("input").value, 10);
    if (sel && sel.value && Number.isFinite(lvl)) total += lvl;
  });
  charLevel.value = total > 0 ? total : "";
}

function buildClassRow(cls) {
  const row = document.createElement("div");
  row.className = "class-row";
  const select = document.createElement("select");
  select.appendChild(new Option("— class —", ""));
  for (const name of CLASS_OPTIONS) select.appendChild(new Option(name, name));
  select.value = cls.name || "";
  const level = document.createElement("input");
  level.type = "number";
  level.min = "1";
  level.max = "20";
  level.value = cls.level || 1;
  level.title = "Level in this class";
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "btn ghost small";
  removeBtn.textContent = "✕";
  removeBtn.title = "Remove class";
  removeBtn.addEventListener("click", () => {
    if (classList.children.length > 1) {
      row.remove();
      updateCharLevel();
    }
  });
  level.addEventListener("input", updateCharLevel);
  select.addEventListener("change", updateCharLevel);
  row.appendChild(select);
  row.appendChild(level);
  row.appendChild(removeBtn);
  return row;
}

function renderClassRows(classes) {
  classList.innerHTML = "";
  (classes && classes.length ? classes : [{ name: "", level: 1 }]).forEach((c) =>
    classList.appendChild(buildClassRow(c))
  );
  updateCharLevel();
}

addClassBtn.addEventListener("click", () => {
  if (classList.children.length >= 3) return;
  classList.appendChild(buildClassRow({ name: "", level: 1 }));
  updateCharLevel();
});

characterForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const classes = [];
  classList.querySelectorAll(".class-row").forEach((row) => {
    const name = row.querySelector("select").value;
    const level = parseInt(row.querySelector("input").value, 10) || 1;
    if (name) classes.push({ name, level });
  });
  charData = {
    name: charName.value.trim(),
    race: charRace.value.trim(),
    classes: classes.length ? classes : [{ name: "", level: 1 }],
    hp: charHP.value.trim(),
    notes: charNotes.value.trim(),
  };
  localStorage.setItem("dnd_char", JSON.stringify(charData));
  updateCharLevel();
  charSavedHint.textContent = "✅ Saved — the DM will remember this.";
  charSavedHint.classList.remove("hidden");
  // The adventure owns the authoritative snapshot; keep the server copy in
  // sync whenever the player edits the sheet.
  if (state.activeAdventure) {
    apiPatchAdventure(state.activeAdventure.id, { character: charData })
      .then((adventure) => {
        state.activeAdventure = adventure;
      })
      .catch(() => {
        charSavedHint.textContent =
          "⚠️ Saved locally, but the server could not be reached.";
      });
  }
  setTimeout(() => charSavedHint.classList.add("hidden"), 2500);
});

// Load saved character data, migrating once from the legacy "dnd_character"
// key to "dnd_char". Never overwrites an existing valid dnd_char value;
// malformed data fails safely (returns null).
function loadCharacterData() {
  const current = localStorage.getItem("dnd_char");
  if (current !== null) {
    try {
      const parsed = JSON.parse(current);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      /* corrupt current value: treat as no character */
    }
    return null;
  }
  const legacy = localStorage.getItem("dnd_character");
  if (legacy === null) return null;
  try {
    const parsed = JSON.parse(legacy);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      localStorage.setItem("dnd_char", JSON.stringify(parsed)); // migrate once
      return parsed;
    }
  } catch {
    /* malformed legacy: fail safe */
  }
  return null;
}

function restoreCharacter() {
  const saved = loadCharacterData();
  if (saved) charData = Object.assign(charData, saved);
  charName.value = charData.name || "";
  charRace.value = charData.race || "";
  charHP.value = charData.hp || "";
  charNotes.value = charData.notes || "";
  renderClassRows(charData.classes);
}

// ---------- Backend API helpers & connection status ----------
function apiHeaders(extra) {
  return Object.assign({ "X-User-Id": state.userId }, extra || {});
}

// Minimal JSON API helper. Errors use the same {error:{message}} shape the
// chat parser already understands, so failure messages stay consistent.
async function apiJson(method, path, body) {
  const opts = { method, headers: apiHeaders() };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let text = "";
  try {
    text = await res.text();
  } catch {
    /* ignore body read failures */
  }
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const serverMsg =
      data && data.error && typeof data.error.message === "string"
        ? data.error.message
        : "HTTP " + res.status;
    throw new Error(serverMsg);
  }
  return data;
}

async function apiListAdventures() {
  const data = await apiJson("GET", "/api/adventures");
  return Array.isArray(data && data.adventures) ? data.adventures : [];
}

async function apiCreateAdventure(character) {
  const data = await apiJson("POST", "/api/adventures", { character });
  return data.adventure;
}

async function apiPatchAdventure(id, patch) {
  const data = await apiJson(
    "PATCH",
    "/api/adventures/" + encodeURIComponent(id),
    patch
  );
  return data.adventure;
}

async function checkHealth() {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const h = await res.json();
    if (h && h.ok) {
      if (h.provider === "ok") return { kind: "ok", text: "Connected" };
      if (h.provider === "unconfigured") {
        return { kind: "error", text: "Server not configured" };
      }
      return { kind: "error", text: "Provider unreachable" };
    }
    return { kind: "error", text: "Server error" };
  } catch {
    return { kind: "error", text: "Server unreachable" };
  }
}

async function refreshConnectionPill() {
  updateConnectionPill("unknown", "Connecting...");
  const result = await checkHealth();
  updateConnectionPill(result.kind, result.text);
}

// ---------- Chat & streaming (text only — no tool calls, no image payloads) ----------

// Extract a human-readable message from an Open WebUI / OpenAI-style error
// body or SSE error event. Recognizes {error:{message}}, error as a string,
// {detail}, and {message}. Returns "" when nothing recognizable is present.
function extractServerError(body) {
  if (body === undefined || body === null) return "";
  let parsed = body;
  if (typeof body === "string") {
    const text = body.trim();
    if (!text) return "";
    if (text.startsWith("<")) return ""; // HTML gateway page: not an error message
    try {
      parsed = JSON.parse(text);
    } catch {
      return text.slice(0, 300); // plain-text server message
    }
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const e = parsed.error;
    if (e !== undefined && e !== null) {
      if (typeof e === "string" && e) return e;
      if (e && typeof e === "object" && typeof e.message === "string" && e.message) {
        return e.message;
      }
    }
    if (typeof parsed.detail === "string" && parsed.detail) return parsed.detail;
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
    return "";
  }
  return typeof parsed === "string" ? parsed.slice(0, 300) : "";
}

// Persisted markers appended to truncated/interrupted replies. They are part
// of the saved message content, so they survive reloads.
const INTERRUPTION_MARKER = "\n\n*(Interrupted — the connection was lost.)*";
const FINISH_REASON_MARKERS = {
  length: "\n\n*(Truncated — the response hit the length limit.)*",
  content_filter: "\n\n*(Filtered — part of the response was removed by content filtering.)*",
};

// The backend proxies the model call and prepends the system prompt,
// adventure context, and character snapshot server-side. The browser
// sends only user/assistant history — and holds no provider credentials.
async function ensureAdventure() {
  if (state.activeAdventure) return true;
  try {
    state.activeAdventure = await apiCreateAdventure(charData);
    return true;
  } catch (err) {
    updateConnectionPill("error", "Connection failed");
    alert("Could not reach the server: " + err.message);
    return false;
  }
}

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || state.streaming) return;
  if (!(await ensureAdventure())) {
    messageInput.value = text; // keep the player's message for retry
    return;
  }
  messageInput.value = "";
  state.messages.push({ role: "user", content: text });
  appendMessageBubble("user", text);
  persistMessages();
  await runAssistantTurn();
});

async function runAssistantTurn() {
  state.streaming = true;
  typingIndicator.classList.remove("hidden");
  messageInput.disabled = true;

  // Own the cancellation + staleness guard for this turn. New Adventure
  // bumps turnSeq and aborts the controller, which guarantees nothing from
  // this turn can write into the reset adventure afterwards.
  const controller = new AbortController();
  state.activeChatController = controller;
  const turnSeq = state.turnSeq;
  const turnStillCurrent = () => turnSeq === state.turnSeq;

  const bubble = appendMessageBubble("assistant", "");
  const textEl = bubble.querySelector(".message-text");
  let acc = "";
  const appendText = (t) => {
    if (!t) return;
    if (!turnStillCurrent()) return; // stale turn: never touch the new DOM
    acc += t;
    textEl.innerHTML = formatMessageText(acc);
    scrollToBottom();
  };

  let streamError = ""; // real server error reported inside the SSE stream
  let finishReason = ""; // last non-empty finish_reason reported by the server

  try {
    const requestMessages = [];
    for (const m of state.messages) {
      if (m.role === "user" || m.role === "assistant") {
        requestMessages.push({ role: m.role, content: m.content });
      }
    }

    const res = await fetch("/api/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-User-Id": state.userId,
      },
      body: JSON.stringify({
        adventureId: state.activeAdventure ? state.activeAdventure.id : "",
        messages: requestMessages,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      // Surface the real server error message when the body carries one;
      // fall back to the bare HTTP status line otherwise.
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch {
        /* body read failure: fall back to status line */
      }
      const serverMsg = extractServerError(bodyText);
      throw new Error(
        serverMsg
          ? `HTTP ${res.status}: ${serverMsg}`
          : `HTTP ${res.status} ${res.statusText}`.trim()
      );
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/event-stream")) {
      // A 200 that is not an event stream. Surface a real error if the body
      // carries one; otherwise accept a plain JSON completion body (some
      // servers ignore stream:true). Anything else is a protocol failure —
      // never the fake "silence" fallback.
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch {
        /* ignore body read failures */
      }
      const serverMsg = extractServerError(bodyText);
      if (serverMsg) throw new Error(serverMsg);
      let parsed = null;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        /* not JSON */
      }
      const choice = parsed && parsed.choices ? parsed.choices[0] : null;
      const msg = choice ? choice.message || choice : {};
      const fullContent = typeof msg.content === "string" ? msg.content : "";
      if (fullContent) {
        appendText(fullContent);
        if (choice && choice.finish_reason) finishReason = String(choice.finish_reason);
      } else {
        throw new Error("The server returned an unexpected non-stream response.");
      }
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let streamEnded = false;

      const processLine = (rawLine) => {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data) return;
        if (data === "[DONE]") {
          streamEnded = true; // finish immediately; do not wait for socket close
          return;
        }
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          return; /* keep-alive / partial / malformed chunk */
        }
        const evErr = extractServerError(json);
        if (evErr) {
          // Error object inside the stream: capture the real message instead
          // of silently treating the partial text as a complete reply.
          streamError = evErr;
          return;
        }
        const choice = json.choices && json.choices[0];
        if (!choice) return;
        if (choice.finish_reason) finishReason = String(choice.finish_reason);
        const msg = choice.delta || choice.message || {};
        if (typeof msg.content === "string" && msg.content) appendText(msg.content);
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          processLine(line);
          if (streamEnded) break;
        }
        if (streamEnded) break;
      }
      if (!streamEnded) {
        // EOF: flush the decoder and process a final data line that arrived
        // without a trailing newline so its content is never lost.
        buf += decoder.decode();
        if (buf.trim()) processLine(buf);
      }
      if (streamEnded) {
        try {
          await reader.cancel(); // release the connection instead of waiting
        } catch {
          /* already released */
        }
      }
    }

    // ---------- Turn finished: commit (or deliberately not) ----------
    if (!turnStillCurrent()) return; // reset happened: leave no trace

    if (streamError) {
      // The server reported an error mid-stream. Preserve any partial text
      // with a persisted interruption/error marker; never invent DM dialogue.
      updateConnectionPill("error", "Connection failed");
      if (acc.trim()) {
        acc += `\n\n*(Interrupted — the server reported an error: ${streamError})*`;
        textEl.innerHTML = formatMessageText(acc);
        state.messages.push({ role: "assistant", content: acc });
        persistMessages();
        hydrateImages();
      } else {
        appendText(`⚠️ ${streamError}`);
      }
      return;
    }

    if (!acc.trim()) {
      // Genuinely successful but empty response: the silence fallback, once.
      acc = "*(The Dungeon Master stares in silence — the connection may have dropped.)*";
      textEl.innerHTML = formatMessageText(acc);
    } else if (finishReason && finishReason !== "stop") {
      const marker = FINISH_REASON_MARKERS[finishReason];
      if (marker) {
        acc += marker;
        textEl.innerHTML = formatMessageText(acc);
      }
    }
    updateConnectionPill("ok", "Connected");
    state.messages.push({ role: "assistant", content: acc });
    persistMessages();
    hydrateImages();
  } catch (err) {
    if (err && err.name === "AbortError") {
      // Intentionally cancelled (New Adventure): no error UI, no history.
    } else if (!turnStillCurrent()) {
      // Stale turn after a reset: the new adventure stays untouched.
    } else {
      updateConnectionPill("error", "Connection failed");
      if (acc.trim()) {
        // Preserve the partial text with a persisted interruption marker so
        // a reload never shows it as a successful complete response.
        acc += INTERRUPTION_MARKER;
        state.messages.push({ role: "assistant", content: acc });
        persistMessages();
        appendText(`\n\n⚠️ Connection problem: ${err.message}`);
      } else {
        appendText(`⚠️ Connection problem: ${err.message}`);
      }
    }
  } finally {
    if (state.activeChatController === controller) {
      state.activeChatController = null;
    }
    state.streaming = false;
    typingIndicator.classList.add("hidden");
    messageInput.disabled = false;
    scrollToBottom();
  }
}

// ---------- New adventure ----------
newAdventureBtn.addEventListener("click", async () => {
  if (state.messages.length && !confirm("Start a new adventure? The current story will be cleared.")) {
    return;
  }
  if (ttsSupported) window.speechSynthesis.cancel();
  state.turnSeq++; // invalidate any in-flight turn so it can never write back
  if (state.activeChatController) {
    state.activeChatController.abort(); // cancel the active chat request
  }
  try {
    // A fresh adventure context server-side: new character snapshot, new
    // spine/hook slots, and — later — its own messages and NPC roster.
    state.activeAdventure = await apiCreateAdventure(charData);
    state.messages = [];
    persistMessages();
    renderMessages();
    updateConnectionPill("ok", "Connected");
  } catch (err) {
    updateConnectionPill("error", "Connection failed");
    alert("Could not start a new adventure: " + err.message);
  }
});

// ---------- Init ----------
// Legacy adoption: a story saved by the pre-backend app lives under the
// plain "dnd_messages" key. If the server has no adventures yet, adopt it
// into a freshly created adventure so no saved story is lost.
const LEGACY_MESSAGES_KEY = "dnd_messages";

function hasLegacyMessages() {
  const raw = localStorage.getItem(LEGACY_MESSAGES_KEY);
  if (!raw) return false;
  try {
    return Array.isArray(JSON.parse(raw));
  } catch {
    return false;
  }
}

function adoptLegacyMessages(adventureId) {
  const raw = localStorage.getItem(LEGACY_MESSAGES_KEY);
  if (raw === null) return;
  localStorage.setItem("dnd_messages:" + adventureId, raw);
  localStorage.removeItem(LEGACY_MESSAGES_KEY);
}

async function bootAdventure() {
  let adventures = [];
  try {
    adventures = await apiListAdventures();
  } catch {
    /* server unreachable: stay offline; the pill will report it */
  }
  if (!adventures.length && hasLegacyMessages()) {
    try {
      const adventure = await apiCreateAdventure(charData);
      adoptLegacyMessages(adventure.id);
      adventures = [adventure];
    } catch {
      /* server unreachable: leave legacy data untouched for the next boot */
    }
  }
  if (!adventures.length) return;
  // Phase 1 keeps the most recently updated adventure active (no switcher UI yet).
  state.activeAdventure = adventures[0];
  const snapshot =
    state.activeAdventure.character &&
    typeof state.activeAdventure.character === "object"
      ? state.activeAdventure.character
      : null;
  if (snapshot) {
    const hasContent =
      snapshot.name ||
      snapshot.race ||
      snapshot.hp ||
      snapshot.notes ||
      (Array.isArray(snapshot.classes) && snapshot.classes.length > 0);
    if (hasContent) {
      // The adventure owns the authoritative character snapshot; refresh the
      // sheet (and the local prefill cache) from it.
      charData = Object.assign(
        { name: "", race: "", classes: [{ name: "", level: 1 }], hp: "", notes: "" },
        snapshot
      );
      if (!Array.isArray(charData.classes) || !charData.classes.length) {
        charData.classes = [{ name: "", level: 1 }];
      }
      localStorage.setItem("dnd_char", JSON.stringify(charData));
      restoreCharacter();
    }
    // else: empty server snapshot — keep the local sheet rather than
    // wiping it (e.g. an earlier save never reached the server).
  }
  state.messages = safeLoadMessages("dnd_messages:" + state.activeAdventure.id);
}

function init() {
  restoreCharacter();
  renderMessages();
  updateConnectionPill("unknown", "Connecting...");
  (async () => {
    await bootAdventure();
    renderMessages();
    refreshConnectionPill();
  })();
}

// Boot
init();
