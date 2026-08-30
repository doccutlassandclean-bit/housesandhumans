/* ============================================================
   D&D 5.5e — AI Dungeon Master chat client for Open WebUI
   Renders text AND images together in one assistant bubble.
   ============================================================ */

const DEFAULT_MODEL_ID = "dd-5e";
const DEFAULT_BASE_URL = "http://localhost:3000";
const DEBUG_STREAM = new URLSearchParams(location.search).get("debug") === "1";
const MAX_CLASSES = 3;

const state = {
  baseUrl: localStorage.getItem("dnd_baseUrl") || DEFAULT_BASE_URL,
  apiKey: localStorage.getItem("dnd_apiKey") || "",
  modelId: localStorage.getItem("dnd_modelId") || DEFAULT_MODEL_ID,
  messages: JSON.parse(localStorage.getItem("dnd_messages") || "[]"),
  character: JSON.parse(localStorage.getItem("dnd_character") || "null"),
  voiceEnabled: localStorage.getItem("dnd_voiceEnabled") === "true",
  voiceName: localStorage.getItem("dnd_voiceName") || "",
  voiceRate: parseFloat(localStorage.getItem("dnd_voiceRate") || "1"),
  voicePitch: parseFloat(localStorage.getItem("dnd_voicePitch") || "1"),
  streaming: false,
};

// ---------- DOM refs ----------
const chatLog = document.getElementById("chatLog");
const chatForm = document.getElementById("chatForm");
const messageInput = document.getElementById("messageInput");
const typingIndicator = document.getElementById("typingIndicator");
const connectionStatus = document.getElementById("connectionStatus");
const gallerySidebar = document.getElementById("gallerySidebar");
const galleryGrid = document.getElementById("galleryGrid");
const galleryEmpty = document.getElementById("galleryEmpty");
const galleryToggleBtn = document.getElementById("galleryToggleBtn");
const galleryCloseBtn = document.getElementById("galleryCloseBtn");

const settingsModal = document.getElementById("settingsModal");
const settingsBtn = document.getElementById("settingsBtn");
const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
const testConnectionBtn = document.getElementById("testConnectionBtn");
const settingsMessage = document.getElementById("settingsMessage");

const baseUrlInput = document.getElementById("baseUrlInput");
const modelIdInput = document.getElementById("modelIdInput");
const apiKeyInput = document.getElementById("apiKeyInput");

const voiceToggleBtn = document.getElementById("voiceToggleBtn");
const voiceEnabledInput = document.getElementById("voiceEnabledInput");
const voiceSelectInput = document.getElementById("voiceSelectInput");
const voiceRateInput = document.getElementById("voiceRateInput");
const voicePitchInput = document.getElementById("voicePitchInput");
const voiceRateValue = document.getElementById("voiceRateValue");
const voicePitchValue = document.getElementById("voicePitchValue");
const testVoiceBtn = document.getElementById("testVoiceBtn");

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

const ttsSupported = "speechSynthesis" in window;
let availableVoices = [];
let speechQueue = [];
let isSpeaking = false;
let currentSpeakingBubble = null;

// ---------- Init ----------
function init() {
  baseUrlInput.value = state.baseUrl;
  modelIdInput.value = state.modelId;
  apiKeyInput.value = state.apiKey;

  if (state.character) {
    charName.value = state.character.name || "";
    charRace.value = state.character.race || "";
    charHP.value = state.character.hp || "";
    charNotes.value = state.character.notes || "";
    renderClassRows(
      state.character.classes && state.character.classes.length
        ? state.character.classes
        : [{ name: "", level: 1 }]
    );
  } else {
    renderClassRows([{ name: "", level: 1 }]);
  }

  renderMessages();
  setGalleryOpen(localStorage.getItem("dnd_galleryOpen") !== "0");
  updateConnectionPill(state.apiKey ? "unknown" : "error", state.apiKey ? "Not tested" : "No API key set");

  voiceEnabledInput.checked = state.voiceEnabled;
  voiceRateInput.value = state.voiceRate;
  voicePitchInput.value = state.voicePitch;
  voiceRateValue.textContent = state.voiceRate.toFixed(1);
  voicePitchValue.textContent = state.voicePitch.toFixed(1);
  updateVoiceToggleBtn();
  loadVoices();
  if (!ttsSupported) {
    voiceToggleBtn.disabled = true;
    voiceToggleBtn.title = "This browser does not support speech synthesis";
    voiceToggleBtn.textContent = "🔇 Voice unsupported";
  }

  if (!state.apiKey) setTimeout(openModal, 400);
}

// ---------- Multiclass rows ----------
function renderClassRows(classes) {
  classList.innerHTML = "";
  classes.slice(0, MAX_CLASSES).forEach((cls) => addClassRow(cls.name, cls.level));
  updateAddClassBtnState();
  updateTotalLevel();
}

function addClassRow(name = "", level = 1) {
  if (classList.children.length >= MAX_CLASSES) return;

  const row = document.createElement("div");
  row.className = "class-row";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "class-name";
  nameInput.placeholder = "Class name";
  nameInput.value = name || "";

  const levelInput = document.createElement("input");
  levelInput.type = "number";
  levelInput.className = "class-level";
  levelInput.min = "1";
  levelInput.max = "20";
  levelInput.value = level || 1;
  levelInput.addEventListener("input", updateTotalLevel);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "remove-class-btn";
  removeBtn.textContent = "✕";
  removeBtn.title = "Remove class";
  removeBtn.addEventListener("click", () => {
    if (classList.children.length <= 1) return;
    row.remove();
    updateAddClassBtnState();
    updateTotalLevel();
    updateRemoveButtons();
  });

  row.appendChild(nameInput);
  row.appendChild(levelInput);
  row.appendChild(removeBtn);
  classList.appendChild(row);
  updateAddClassBtnState();
  updateRemoveButtons();
  updateTotalLevel();
}

function updateRemoveButtons() {
  const rows = classList.querySelectorAll(".class-row");
  rows.forEach((row) => {
    const btn = row.querySelector(".remove-class-btn");
    if (btn) btn.disabled = rows.length <= 1;
  });
}

function updateAddClassBtnState() {
  const atMax = classList.children.length >= MAX_CLASSES;
  addClassBtn.disabled = atMax;
  addClassBtn.textContent = atMax ? "Max 3 classes" : "+ Add Class";
}

function updateTotalLevel() {
  let total = 0;
  classList.querySelectorAll(".class-level").forEach((input) => {
    total += parseInt(input.value, 10) || 0;
  });
  charLevel.value = String(total || "");
}

function getClassesFromDOM() {
  return Array.from(classList.querySelectorAll(".class-row"))
    .map((row) => ({
      name: row.querySelector(".class-name")?.value.trim() || "",
      level: parseInt(row.querySelector(".class-level")?.value, 10) || 1,
    }))
    .filter((c) => c.name);
}

addClassBtn.addEventListener("click", () => addClassRow("", 1));

// ---------- UI helpers ----------
function updateConnectionPill(kind, text) {
  connectionStatus.className = `status-pill status-${kind}`;
  connectionStatus.textContent = `● ${text}`;
}

function scrollToBottom() {
  chatLog.scrollTop = chatLog.scrollHeight;
}

function openModal() {
  baseUrlInput.value = state.baseUrl;
  modelIdInput.value = state.modelId;
  apiKeyInput.value = state.apiKey;
  voiceEnabledInput.checked = state.voiceEnabled;
  voiceRateInput.value = state.voiceRate;
  voicePitchInput.value = state.voicePitch;
  voiceRateValue.textContent = state.voiceRate.toFixed(1);
  voicePitchValue.textContent = state.voicePitch.toFixed(1);
  loadVoices();
  settingsMessage.classList.add("hidden");
  settingsModal.classList.remove("hidden");
}

function closeModal() {
  settingsModal.classList.add("hidden");
}

function persistMessages() {
  localStorage.setItem("dnd_messages", JSON.stringify(state.messages));
}

function appendErrorBubble(text) {
  const div = document.createElement("div");
  div.className = "message error-msg";
  div.textContent = text;
  chatLog.appendChild(div);
  scrollToBottom();
}

// ---------- Formatting ----------
// Removes the model's raw tool-call scaffolding, e.g.
//   <tool_use>
//   { "name": "ImageGeneration", "arguments": { "prompt": "..." } }
//   </tool_use>
// so the giant JSON image prompt never floods the visible reply. Only display
// text is cleaned — the stored history keeps the original model output.
function stripToolUseBlocks(text) {
  if (!text) return "";
  let out = String(text);
  // Complete <tool_use>/<tool_call> blocks, optionally wrapped in ``` fences.
  out = out.replace(/```[^\n]*\n?\s*<(?:tool_use|tool_call)>[\s\S]*?<\/(?:tool_use|tool_call)>\s*```?/gi, "\n");
  out = out.replace(/<(?:tool_use|tool_call)>[\s\S]*?<\/(?:tool_use|tool_call)>/gi, "\n");
  // Dangling open tag (mid-stream): drop everything from the tag onward.
  out = out.replace(/<\/?(?:tool_use|tool_call)>[\s\S]*$/i, "\n");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function formatMessageText(text) {
  if (!text) return "";
  text = stripToolUseBlocks(text);
  if (!text) return "";
  const images = [];
  const withPlaceholders = String(text).replace(/!\[([^\]]*)\]\((.+?)\)/g, (match, alt, url) => {
    images.push({ alt: alt || "Image", url });
    return `\u0000IMG${images.length - 1}\u0000`;
  });

  const escaped = withPlaceholders
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const withBold = escaped.replace(
    /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g,
    (match, bold, italic) => `<strong>${bold || italic}</strong>`
  );

  return withBold.replace(/\u0000IMG(\d+)\u0000/g, (match, idx) => {
    const img = images[Number(idx)];
    if (!img) return "";
    const src = resolveImageUrl(img.url);
    const safeSrc = src.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const safeAlt = (img.alt || "Image").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    return `<a href="${safeSrc}" target="_blank" rel="noopener noreferrer" class="chat-image-link"><img src="${safeSrc}" alt="${safeAlt}" class="chat-image" loading="lazy" referrerpolicy="no-referrer" /></a>`;
  });
}

// ---------- Debug logging ----------
// Image-path events are ALWAYS written to the console (prefix [dnd]) and
// collected in window.__dndDebug so a failing generation can be diagnosed
// from a paste of that array. Open the console with F12 and run
// copy(window.__dndDebug) to copy the whole dump.
function dndLog(label, data) {
  try {
    window.__dndDebug = window.__dndDebug || [];
    window.__dndDebug.push({ t: new Date().toISOString(), label, data });
    console.log(`%c[dnd] ${label}`, "color:#8fd6a0;font-weight:bold;", data);
  } catch {
    /* ignore */
  }
}

function stripForSpeech(text) {
  return String(text || "")
    .replace(/!\[[^\]]*\]\(.*?\)/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Structural detector: returns true when a line is an image-generation status
// marker rather than story prose. Works regardless of bracket style, emoji,
// casing, or punctuation placement — e.g.:
//   (Image generation incoming.)   [Image Generation]   <image generation>
//   🎨 Generating image...          I'm generating the image of Willow.
//   Image generation incoming.      Painting the scene now.
//   The image is on its way.
function isImageStatusLine(line) {
  const t = String(line || "")
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length > 160) return false;

  // Bare marker phrases (brackets/emoji already stripped by cleanup).
  if (
    /^(?:ooc|out of character)?\s*(?:image gen(?:eration)?|image generation incoming|image incoming|generating (?:the |an |a )?image|creating (?:the |an |a )?image|painting the scene)$/.test(
      t
    )
  ) {
    return true;
  }

  const hasNoun = /\b(image|images|picture|portrait|scene|illustration|artwork|art)\b/.test(t);
  const hasVerb = /\b(generat\w*|creat\w*|paint\w*|render\w*|compos\w*|draw\w*|summon\w*|craft\w*|conjur\w*|incoming|produc\w*|coming|on its way)\b/.test(t);
  if (!hasNoun || !hasVerb) return false;

  // Very short noun+verb lines are status notes ("The image is on its way.").
  if (t.length <= 60) return true;

  // Longer lines only count when they lead like a status announcement.
  return /^(?:i'?m|i am|i'?ll|i will|let me|allow me|now|time to|generating|creating|painting|rendering|composing|drawing|image|picture|art)\b/.test(t);
}

function stripImageStatusLines(text) {
  if (!text) return "";
  // Drop whole lines that are image-status markers (any bracket/emoji style).
  const kept = String(text)
    .split(/\r?\n/)
    .filter((ln) => !isImageStatusLine(ln));
  return kept
    .join("\n")
    // "[Image generated: <description>]" / "[Generated image: ...]" placeholder
    // blocks the model writes inline instead of calling the real image tool.
    .replace(/\[\s*(?:generated\s+image|image\s+(?:generated|generation))\s*[:\-]\s*[\s\S]*?\]/gi, "\n")
    // Long engine-prompt blocks.
    .replace(/(?:^|\n)\s*<\s*image[\s_-]*generation\s*>[\s\S]*$/i, "\n")
    .replace(/(?:^|\n)\s*image\s+generation\s*[—–\-:|][\s\S]*$/i, "\n")
    .replace(/(?:^|\n)\s*prompt\s*:\s*[^\n][\s\S]{40,}$/i, "\n")
    // Scaffolding heading before a picture that is now inline.
    .replace(/(?:^|\n)[^\n]*\bthe\s+image\s+you\s+requested\b[^\n]*/gi, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------- Image lightbox ----------
// Clicking any chat image opens it in an in-page viewer instead of navigating
// away or downloading (the server serves images with attachment headers,
// which previously forced a download). Close with the ✕ button, Esc, or a
// click on the dark backdrop.
const imageLightbox = document.getElementById("imageLightbox");
const imageLightboxImg = document.getElementById("imageLightboxImg");
const imageLightboxOpen = document.getElementById("imageLightboxOpen");
const imageLightboxClose = document.getElementById("imageLightboxClose");

function openImageLightbox(src, alt) {
  if (!imageLightbox || !src) return;
  imageLightboxImg.src = src;
  imageLightboxImg.alt = alt || "Image preview";
  imageLightboxOpen.dataset.src = src;
  imageLightbox.classList.remove("hidden");
  document.body.classList.add("lightbox-open");
}

function closeImageLightbox() {
  if (!imageLightbox) return;
  imageLightbox.classList.add("hidden");
  imageLightboxImg.src = "";
  document.body.classList.remove("lightbox-open");
}

// Delegated: works for markdown-rendered images AND generated-image anchors,
// including images re-rendered from saved history.
chatLog.addEventListener("click", (e) => {
  const img = e.target.closest("img.chat-image");
  if (!img) return;
  // Keep the wrapping anchor from navigating/downloading; show the viewer.
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
  // window.open (not a plain href) so blob: URLs open cleanly in a new tab.
  if (src) window.open(src, "_blank", "noopener");
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !imageLightbox.classList.contains("hidden")) {
    closeImageLightbox();
  }
});

// ---------- Adventure gallery ----------
// The gallery derives itself from the stored assistant messages, so every
// image created during the adventure — markdown-embedded by the model or
// fetched by the client fallback (both are persisted as markdown) — appears
// here automatically, survives page reloads, and clears on New Adventure.
function collectAdventureImages() {
  const seen = new Set();
  const out = [];
  for (const msg of state.messages) {
    if (msg.role !== "assistant") continue;
    for (const img of extractMarkdownImages(String(msg.content || ""))) {
      const key = resolveImageUrl(img.url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ url: img.url, alt: img.alt || "Generated image" });
    }
  }
  return out;
}

function renderGallery() {
  const images = collectAdventureImages();
  galleryGrid.innerHTML = "";
  galleryEmpty.classList.toggle("hidden", images.length > 0);
  for (const img of images) {
    galleryGrid.appendChild(createImageAnchor(img.url, img.alt));
  }
}

function setGalleryOpen(open) {
  gallerySidebar.classList.toggle("collapsed", !open);
  galleryToggleBtn.classList.toggle("active", open);
  localStorage.setItem("dnd_galleryOpen", open ? "1" : "0");
}

galleryToggleBtn.addEventListener("click", () =>
  setGalleryOpen(gallerySidebar.classList.contains("collapsed"))
);
galleryCloseBtn.addEventListener("click", () => setGalleryOpen(false));

// Thumbs open in the same in-page viewer as chat images.
galleryGrid.addEventListener("click", (e) => {
  const img = e.target.closest("img.chat-image");
  if (!img) return;
  if (img.closest("a.chat-image-link")) e.preventDefault();
  openImageLightbox(img.currentSrc || img.src, img.alt);
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
      speak(stripForSpeech(joined || content || ""), { bubble: div });
    });
    header.appendChild(speakBtn);
  }

  const body = document.createElement("div");
  body.className = "message-body";

  const addTextSegment = (text) => {
    const seg = document.createElement("div");
    seg.className = "message-text";
    const cleaned = role === "assistant" ? stripImageStatusLines(text || "") : text || "";
    seg.innerHTML = formatMessageText(cleaned);
    body.appendChild(seg);
    return seg;
  };

  const rawContent = String(content || "");
  const mdImgs = extractMarkdownImages(rawContent);

  if (role === "assistant" && mdImgs.length) {
    // History with stored markdown images: interleave text and image blocks so
    // each picture appears exactly where the model placed it in the story.
    let rest = rawContent;
    for (;;) {
      const m = /!\[[^\]]*\]\(([^)]*)\)/.exec(rest);
      if (!m) {
        if (rest.trim()) addTextSegment(rest);
        break;
      }
      if (rest.slice(0, m.index).trim()) addTextSegment(rest.slice(0, m.index));
      const found = mdImgs.find((mi) => mi.url === m[1].trim()) || {
        url: m[1],
        alt: "",
      };
      const imgsAt = document.createElement("div");
      imgsAt.className = "message-images inline";
      imgsAt.appendChild(createImageAnchor(found.url, found.alt || "Generated image"));
      body.appendChild(imgsAt);
      rest = rest.slice(m.index + m[0].length);
    }
    const lastNode = body.lastElementChild;
    if (!lastNode || !lastNode.classList.contains("message-text")) {
      addTextSegment("");
    }
  } else {
    addTextSegment(rawContent);
    const imagesEl = document.createElement("div");
    imagesEl.className = "message-images";
    body.appendChild(imagesEl);
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
      "<br />Open <strong>⚙️ Settings</strong> to add your Open WebUI API key, then say hello to begin your adventure.";
    chatLog.appendChild(scene);
    return;
  }
  for (const msg of state.messages) {
    if (msg.role === "user" || msg.role === "assistant") {
      appendMessageBubble(msg.role, msg.content);
    }
  }
  renderGallery();
  hydrateImages();
}

// ---------- Image helpers ----------
function resolveImageUrl(url) {
  if (!url) return "";
  if (url.startsWith("blob:") || url.startsWith("data:") || /^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return state.baseUrl.replace(/\/+$/, "") + url;
  return url;
}

function createImageAnchor(url, alt) {
  const src = resolveImageUrl(url);
  const anchor = document.createElement("a");
  anchor.className = "chat-image-link";
  anchor.href = src;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.dataset.originalUrl = src;

  const img = document.createElement("img");
  img.className = "chat-image";
  img.alt = alt || "Generated image";
  img.src = src;
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";

  anchor.appendChild(img);
  return anchor;
}

async function fetchImageAsBlob(url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${state.apiKey}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

async function hydrateImages() {
  if (!state.apiKey) return;
  // document-wide so gallery thumbs are auth-hydrated too (blob:/data: skipped)
  const images = Array.from(document.querySelectorAll(".chat-image"));
  for (const imgEl of images) {
    const src = imgEl.getAttribute("src") || "";
    const original =
      imgEl.closest("a")?.dataset?.originalUrl ||
      src;
    if (!original || original.startsWith("blob:") || original.startsWith("data:")) continue;
    // Only auth-fetch URLs that point at our Open WebUI instance
    const base = state.baseUrl.replace(/\/+$/, "");
    if (!original.startsWith(base) && !original.startsWith("/")) continue;
    try {
      const absolute = resolveImageUrl(original);
      const objectUrl = await fetchImageAsBlob(absolute);
      imgEl.onerror = () => URL.revokeObjectURL(objectUrl);
      imgEl.src = objectUrl;
      const anchor = imgEl.closest("a");
      if (anchor) anchor.href = absolute;
    } catch {
      // leave direct URL
    }
  }
}

async function addImageToBubble(imgData, container, collected) {
  const url = resolveImageUrl(imgData.url);
  if (!url) return;
  if (collected && collected.some((c) => c.url === url)) return;
  const anchor = createImageAnchor(url, imgData.alt || "Generated image");
  container.appendChild(anchor);
  if (collected) collected.push({ url, alt: imgData.alt || "Generated image" });
  // Auth-hydrate immediately
  const img = anchor.querySelector("img");
  try {
    if (state.apiKey && (url.startsWith(state.baseUrl) || url.includes("/api/v1/files/"))) {
      img.src = await fetchImageAsBlob(url);
    }
  } catch {
    /* keep direct src */
  }
  scrollToBottom();
}

function extractMarkdownImages(text) {
  if (!text) return [];
  const images = [];
  const re = /!\[([^\]]*)\]\((.+?)\)/g;
  let m;
  while ((m = re.exec(text))) {
    images.push({ alt: (m[1] || "Generated image").trim(), url: m[2].trim() });
  }
  return images;
}

// Open WebUI tool results / content arrays → image URLs
function extractImageUrls(content) {
  const urls = [];
  const pushUrl = (u) => {
    if (!u) return;
    const s = String(u).trim();
    if (/^(\/api\/|https?:|data:)/i.test(s)) urls.push(s);
  };

  const texts = [];
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text") texts.push(part.text || "");
      else if (part.type === "image_url") {
        pushUrl(typeof part.image_url === "string" ? part.image_url : part.image_url?.url);
      } else if (part.type === "image") {
        pushUrl(part.image?.url || part.image?.image_url?.url || part.image_url?.url || part.url);
      } else if (part.type === "file") {
        pushUrl(part.file?.url || part.file?.file_url || part.url);
        if (part.file?.id || part.file_id) {
          pushUrl(`/api/v1/files/${part.file?.id || part.file_id}`);
        }
      }
    }
  } else if (typeof content === "string") {
    texts.push(content);
  } else if (content && typeof content === "object") {
    // e.g. { images: [{url}], url, data }
    if (content.url) pushUrl(content.url);
    if (Array.isArray(content.images)) content.images.forEach((i) => pushUrl(i?.url || i));
    if (Array.isArray(content.data)) content.data.forEach((i) => pushUrl(i?.url || i));
  }

  const joined = texts.join("\n");
  if (joined) {
    // markdown
    for (const img of extractMarkdownImages(joined)) pushUrl(img.url);
    // bare file urls
    const bare =
      /(https?:\/\/[^\s"'<>]+?(?:\.(?:png|jpe?g|gif|webp|bmp|avif|svg)|\/api\/v1\/files\/[^\s"'<>]+))|(data:image\/[^\s"'<>]+)|(\/api\/v1\/files\/[^\s"'<>]+)/gi;
    let mm;
    while ((mm = bare.exec(joined))) pushUrl(mm[1] || mm[2] || mm[3]);
    // JSON payload
    try {
      const parsed = JSON.parse(joined);
      const walk = (v) => {
        if (typeof v === "string") pushUrl(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") {
          if (v.url) pushUrl(v.url);
          Object.values(v).forEach(walk);
        }
      };
      walk(parsed);
    } catch {
      /* not JSON */
    }
  }

  // de-dupe
  return [...new Set(urls)];
}

function parseToolPrompt(argsJson) {
  try {
    const args = JSON.parse(argsJson);
    if (args.prompt) return args.prompt;
    if (args.Prompt) return args.Prompt;
    if (args.description) return args.description;
  } catch {
    /* fall through */
  }
  const raw = (argsJson || "").trim();
  return raw.length >= 8 ? raw : "";
}

async function generateImageFromPrompt(prompt) {
  const endpoint = `${state.baseUrl}/api/v1/images/generations`;
  dndLog("image request", {
    endpoint,
    prompt: String(prompt).slice(0, 600),
    model: state.modelId,
    hasApiKey: !!state.apiKey,
  });
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.apiKey}`,
      },
      body: JSON.stringify({ prompt }),
    });
  } catch (networkErr) {
    dndLog("image network error", String(networkErr));
    throw new Error(
      `Image generation network error: ${networkErr.message} (server down, wrong Base URL, or CORS blocked from file://)`
    );
  }
  const rawText = await res.text();
  dndLog("image response", {
    status: res.status,
    statusText: res.statusText,
    contentType: res.headers.get("content-type"),
    bodyPreview: rawText.slice(0, 1500),
  });
  if (!res.ok) {
    throw new Error(
      `Image generation failed (HTTP ${res.status}): ${rawText.slice(0, 300)}`
    );
  }
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(`Image endpoint returned non-JSON: ${rawText.slice(0, 200)}`);
  }
  dndLog("image response parsed", data);
  const list = Array.isArray(data) ? data : data?.data || data?.images || [];
  const imgs = list
    .map((item) => {
      const url = typeof item === "string" ? item : item?.url || item?.image_url?.url || "";
      return url ? { url: resolveImageUrl(url), alt: "Generated image" } : null;
    })
    .filter(Boolean);
  dndLog("image urls extracted", imgs);
  if (!imgs.length) {
    throw new Error(`Image endpoint returned no usable URLs. Raw: ${rawText.slice(0, 200)}`);
  }
  return imgs;
}

// ---------- Voice ----------
function getFreshVoices() {
  if (!ttsSupported) return [];
  const fresh = window.speechSynthesis.getVoices();
  if (fresh && fresh.length) {
    availableVoices = fresh;
    return fresh;
  }
  return availableVoices;
}

function loadVoices() {
  if (!ttsSupported) return;
  const voices = getFreshVoices();
  const previous = voiceSelectInput.value || state.voiceName;
  voiceSelectInput.innerHTML = "";
  if (!voices.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Loading voices...";
    voiceSelectInput.appendChild(opt);
    return;
  }
  for (const v of voices) {
    const opt = document.createElement("option");
    opt.value = v.name;
    opt.textContent = `${v.name} (${v.lang})`;
    voiceSelectInput.appendChild(opt);
  }
  if (previous && [...voiceSelectInput.options].some((o) => o.value === previous)) {
    voiceSelectInput.value = previous;
  } else if (state.voiceName) {
    voiceSelectInput.value = state.voiceName;
  }
}

if (ttsSupported) {
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

function updateVoiceToggleBtn() {
  if (!ttsSupported) return;
  voiceToggleBtn.textContent = state.voiceEnabled ? "🔊 Voice: On" : "🔇 Voice: Off";
}

function stopSpeaking() {
  if (!ttsSupported) return;
  speechQueue = [];
  isSpeaking = false;
  window.speechSynthesis.cancel();
  if (currentSpeakingBubble) {
    currentSpeakingBubble.classList.remove("speaking");
    currentSpeakingBubble = null;
  }
}

function enqueueSpeech(text, bubble) {
  if (!state.voiceEnabled || !ttsSupported || !text || !text.trim()) return;
  speechQueue.push({ text: text.trim(), bubble });
  if (!isSpeaking) speakNextChunk();
}

function speak(text, opts = {}) {
  stopSpeaking();
  enqueueSpeech(text, opts.bubble || null);
}

function speakNextChunk() {
  if (!speechQueue.length) {
    isSpeaking = false;
    if (currentSpeakingBubble) {
      currentSpeakingBubble.classList.remove("speaking");
      currentSpeakingBubble = null;
    }
    return;
  }
  isSpeaking = true;
  const { text, bubble } = speechQueue.shift();
  if (currentSpeakingBubble && currentSpeakingBubble !== bubble) {
    currentSpeakingBubble.classList.remove("speaking");
  }
  currentSpeakingBubble = bubble || null;
  if (currentSpeakingBubble) currentSpeakingBubble.classList.add("speaking");

  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = state.voiceRate;
  utter.pitch = state.voicePitch;
  const voices = getFreshVoices();
  if (state.voiceName) {
    const match = voices.find((v) => v.name === state.voiceName);
    if (match) utter.voice = match;
  }
  utter.onend = () => speakNextChunk();
  utter.onerror = () => speakNextChunk();
  window.speechSynthesis.speak(utter);
}

// ---------- Character context ----------
function buildCharacterContext() {
  const name = charName.value.trim();
  const race = charRace.value.trim();
  const classes = getClassesFromDOM();
  const level = charLevel.value.trim();
  const hp = charHP.value.trim();
  const notes = charNotes.value.trim();

  const lines = [];
  if (name) lines.push(`- Name: ${name}`);
  if (race) lines.push(`- Race: ${race}`);
  if (classes.length) {
    const classText = classes.map((cls) => `${cls.name} ${cls.level}`).join(" / ");
    lines.push(classes.length > 1 ? `- Classes (multiclass): ${classText}` : `- Class: ${classText}`);
  }
  if (level) lines.push(`- Total Level: ${level}`);
  if (hp) lines.push(`- HP: ${hp}`);
  if (notes) lines.push(`- Backstory / Notes: ${notes}`);
  if (!lines.length) return "";

  return (
    "[Character Context] Keep the following details about the player character in mind " +
    "throughout the entire session, and remind yourself of them as the story continues:\n" +
    lines.join("\n")
  );
}

// ---------- Image policy (system rules) ----------
// The native image-generation tool fails silently in this setup (tool calls
// complete but never produce a usable file), so the model must NEVER use it.
// The only supported method is generating the image off-tool and embedding it
// as a direct markdown file link, which this client renders inline.
const IMAGE_POLICY_SYSTEM = [
  "[Image Policy — MANDATORY]",
  "When you want to show an image to the player, follow these rules exactly:",
  "1. NEVER use the image generation tool. Never attempt a tool call of any kind to produce an image — tool-based image generation fails silently here and never produces a usable file. Do not try it, not even as a fallback, and do not announce that you are calling it.",
  "2. The ONLY supported method: generate the image yourself, off-tool, and embed it directly in your reply as a markdown file link, like:",
  "![what the image shows](https://example.com/path/image.png)",
  "3. The link must point directly at an actual image file (png, jpg, or webp) — never at a tool call, a placeholder, or a prose description. Place the markdown image exactly where it belongs within the story text.",
  "4. WHEN to create an image: every time a NEW setting or location is introduced (tavern, dungeon, forest, city, realm…), or a NEW character, creature, or NPC appears for the first time, generate an image of it in that same reply, placed at its first mention. Later mentions of something already depicted do not need a new image.",
  "5. ART STYLE — mandatory for EVERY image without exception: compose each image prompt in the style of 'A fantastical tactical RPG art in the style of Akihiko Yoshida'. Describe the subject (character, creature, or setting) and always apply that style so all images share one cohesive look.",
  "6. If you cannot produce a working direct file link, do not attempt the tool. Simply continue the narration without an image.",
].join("\n");

// ---------- Settings / header events ----------
settingsBtn.addEventListener("click", openModal);
closeSettingsBtn.addEventListener("click", closeModal);
settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) closeModal();
});

voiceToggleBtn.addEventListener("click", () => {
  state.voiceEnabled = !state.voiceEnabled;
  localStorage.setItem("dnd_voiceEnabled", String(state.voiceEnabled));
  voiceEnabledInput.checked = state.voiceEnabled;
  updateVoiceToggleBtn();
  if (!state.voiceEnabled) stopSpeaking();
});

voiceRateInput.addEventListener("input", () => {
  voiceRateValue.textContent = parseFloat(voiceRateInput.value).toFixed(1);
});
voicePitchInput.addEventListener("input", () => {
  voicePitchValue.textContent = parseFloat(voicePitchInput.value).toFixed(1);
});

testVoiceBtn.addEventListener("click", () => {
  if (!ttsSupported) {
    settingsMessage.classList.remove("hidden");
    settingsMessage.textContent = "Voice unsupported in this browser.";
    return;
  }
  const previewEnabled = voiceEnabledInput.checked;
  const savedName = state.voiceName;
  const savedRate = state.voiceRate;
  const savedPitch = state.voicePitch;
  state.voiceEnabled = true;
  state.voiceName = voiceSelectInput.value || state.voiceName;
  state.voiceRate = parseFloat(voiceRateInput.value) || 1;
  state.voicePitch = parseFloat(voicePitchInput.value) || 1;
  speak("The candlelight flickers across an old tavern table. Your adventure awaits.");
  // restore enable flag (name/rate/pitch stay as preview until Save)
  state.voiceEnabled = previewEnabled;
  state.voiceName = savedName;
  state.voiceRate = savedRate;
  state.voicePitch = savedPitch;
});

saveSettingsBtn.addEventListener("click", () => {
  const oldBaseUrl = state.baseUrl;
  const oldApiKey = state.apiKey;

  state.baseUrl = baseUrlInput.value.trim().replace(/\/+$/, "") || DEFAULT_BASE_URL;
  state.modelId = modelIdInput.value.trim() || DEFAULT_MODEL_ID;
  state.apiKey = apiKeyInput.value.trim();
  state.voiceEnabled = voiceEnabledInput.checked;
  state.voiceName = voiceSelectInput.value || "";
  state.voiceRate = parseFloat(voiceRateInput.value) || 1;
  state.voicePitch = parseFloat(voicePitchInput.value) || 1;

  localStorage.setItem("dnd_baseUrl", state.baseUrl);
  localStorage.setItem("dnd_modelId", state.modelId);
  localStorage.setItem("dnd_apiKey", state.apiKey);
  localStorage.setItem("dnd_voiceEnabled", String(state.voiceEnabled));
  localStorage.setItem("dnd_voiceName", state.voiceName);
  localStorage.setItem("dnd_voiceRate", String(state.voiceRate));
  localStorage.setItem("dnd_voicePitch", String(state.voicePitch));
  localStorage.removeItem("dnd_systemPrompt");

  updateVoiceToggleBtn();
  if (!state.voiceEnabled) stopSpeaking();
  hydrateImages();

  const connectionChanged = oldBaseUrl !== state.baseUrl || oldApiKey !== state.apiKey;
  if (connectionChanged) updateConnectionPill("unknown", "Not tested");

  settingsMessage.textContent = connectionChanged
    ? "✅ Settings saved. Retest your connection."
    : "✅ Settings saved.";
  settingsMessage.classList.remove("hidden");
  setTimeout(closeModal, 700);
});

testConnectionBtn.addEventListener("click", async () => {
  settingsMessage.classList.remove("hidden");
  settingsMessage.textContent = "Testing connection...";
  const baseUrl = baseUrlInput.value.trim().replace(/\/+$/, "") || DEFAULT_BASE_URL;
  const apiKey = apiKeyInput.value.trim();
  try {
    const res = await fetch(`${baseUrl}/api/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const count = Array.isArray(data?.data) ? data.data.length : Array.isArray(data) ? data.length : "?";
    settingsMessage.textContent = `✅ Connected! Found ${count} model(s).`;
    updateConnectionPill("ok", "Connected");
  } catch (err) {
    settingsMessage.textContent = `❌ Connection failed: ${err.message}`;
    updateConnectionPill("error", "Connection failed");
  }
});

newAdventureBtn.addEventListener("click", () => {
  if (!confirm("Start a new adventure? This clears the current chat history.")) return;
  stopSpeaking();
  state.messages = [];
  persistMessages();
  renderMessages();
});

characterForm.addEventListener("submit", (e) => {
  e.preventDefault();
  state.character = {
    name: charName.value.trim(),
    race: charRace.value.trim(),
    classes: getClassesFromDOM(),
    level: charLevel.value,
    hp: charHP.value.trim(),
    notes: charNotes.value.trim(),
  };
  localStorage.setItem("dnd_character", JSON.stringify(state.character));
  charSavedHint.classList.remove("hidden");
  setTimeout(() => charSavedHint.classList.add("hidden"), 2000);
});

document.querySelectorAll(".die").forEach((btn) => {
  btn.addEventListener("click", () => {
    const sides = parseInt(btn.dataset.die, 10);
    const roll = Math.floor(Math.random() * sides) + 1;
    diceResult.textContent = `🎲 d${sides} → ${roll}`;
  });
});

// ---------- Streaming chat ----------
async function streamChat(payload, onChunk) {
  const res = await fetch(`${state.baseUrl}/api/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${state.apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }
  if (!res.body) throw new Error("Streaming not supported by this browser/response.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const json = JSON.parse(data);
        if (DEBUG_STREAM) console.debug("[owu-stream]", json);
        if (json.done) return;
        onChunk(json);
      } catch {
        /* keep-alive / partial */
      }
    }
  }
}

async function runAssistantTurn() {
  state.streaming = true;
  typingIndicator.classList.remove("hidden");
  messageInput.disabled = true;

  const bubble = appendMessageBubble("assistant", "");
  const textEl = bubble.querySelector(".message-text");
  const imagesEl = bubble.querySelector(".message-images");

  const statusEl = document.createElement("div");
  statusEl.className = "image-gen-status";
  statusEl.style.display = "none";
  imagesEl.appendChild(statusEl);

  const showStatus = (msg, isError) => {
    statusEl.style.display = "";
    statusEl.textContent = msg;
    statusEl.classList.toggle("error", !!isError);
  };

  // Request messages = image policy (system) + character context + history.
  // The model's own Open WebUI system prompt still applies on top of these.
  const requestMessages = [{ role: "system", content: IMAGE_POLICY_SYSTEM }];
  const characterContext = buildCharacterContext();
  if (characterContext) {
    requestMessages.push({ role: "user", content: characterContext });
  }
  for (const m of state.messages) {
    if (m.role === "user" || m.role === "assistant") {
      requestMessages.push({ role: m.role, content: m.content });
    }
  }

  const payload = {
    model: state.modelId,
    messages: requestMessages,
    stream: true,
    // image_generation is intentionally NOT enabled: exposing the native
    // tool invites the silent-failing tool calls the model kept making.
    // The model must embed images as direct markdown file links instead
    // (see IMAGE_POLICY_SYSTEM).
  };

  let fullReply = "";
  const streamedImages = [];
  const toolPrompts = []; // image prompts gathered from native tool calls
  const pendingToolCalls = new Map(); // index -> { name, args }
  let spokenUpTo = 0;

  const appendText = (t) => {
    if (!t) return;
    fullReply += t;
    textEl.innerHTML = formatMessageText(stripImageStatusLines(fullReply));
    scrollToBottom();

    if (state.voiceEnabled) {
      const speakable = stripImageStatusLines(fullReply);
      const unspoken = speakable.slice(spokenUpTo);
      const lastBreak = Math.max(
        unspoken.lastIndexOf(". "),
        unspoken.lastIndexOf("! "),
        unspoken.lastIndexOf("? "),
        unspoken.lastIndexOf("\n")
      );
      if (lastBreak !== -1) {
        const readyText = unspoken.slice(0, lastBreak + 1);
        spokenUpTo += readyText.length;
        enqueueSpeech(stripForSpeech(readyText), bubble);
      }
    }
  };

  const queueImage = async (url, alt) => {
    if (!url) return;
    showStatus("🖼️ An image appears…");
    await addImageToBubble({ url, alt: alt || "Generated image" }, imagesEl, streamedImages);
  };

  const handleToolCallPart = (tc) => {
    if (!tc || !tc.function) return;
    const idx = tc.index ?? 0;
    const entry = pendingToolCalls.get(idx) || { name: "", args: "" };
    if (tc.function.name) entry.name = tc.function.name;
    if (tc.function.arguments) entry.args += tc.function.arguments;
    pendingToolCalls.set(idx, entry);
    if (/image/i.test(entry.name || "")) {
      showStatus("🖼️ The Dungeon Master is summoning an image…");
    }
  };

  const onChunk = (json) => {
    // Top-level file events some Open WebUI builds emit
    if (json?.type === "files" || json?.type === "chat:message:files") {
      const files = json?.data?.files || json?.files || [];
      for (const f of files) {
        if (!f) continue;
        const isImg =
          f.type === "image" ||
          (f.content_type || "").startsWith("image/") ||
          /\.(png|jpe?g|gif|webp|bmp|avif|svg)(\?|$)/i.test(f.url || "");
        if (isImg && f.url) queueImage(f.url);
      }
      return;
    }

    const choice = json.choices && json.choices[0];
    if (!choice) return;
    const msg = choice.delta || choice.message || {};

    // Tool result message carries generated image data.
    if (msg.role === "tool") {
      extractImageUrls(msg.content).forEach((u) => queueImage(u));
      return;
    }

    // Native tool_calls on the delta (do NOT render as text)
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) handleToolCallPart(tc);
    }

    const content = msg.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        switch (part.type) {
          case "text":
            appendText(part.text || "");
            break;
          case "image_url": {
            const u = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
            if (u) queueImage(u);
            break;
          }
          case "image": {
            const u = part.image?.url || part.image?.image_url?.url || part.image_url?.url || part.url;
            if (u) queueImage(u);
            break;
          }
          case "file": {
            const u =
              part.file?.url ||
              part.file?.file_url ||
              part.url ||
              (part.file?.id || part.file_id
                ? `/api/v1/files/${part.file?.id || part.file_id}`
                : "");
            if (u) queueImage(u);
            break;
          }
          case "tool_call":
            handleToolCallPart(part.tool_call || part);
            break;
          case "reasoning":
            break;
          default:
            break;
        }
      }
    } else if (typeof content === "string") {
      appendText(content);
    }
  };

  try {
    await streamChat(payload, onChunk);

    // ---- Consolidated image pipeline (after the stream ends) ----
    // Prompt sources, in priority order:
    //   1. Native generate_image tool calls (arguments contain the prompt)
    //   2. "[Image generated: ...]" / "[Generated image: ...]" narration blocks
    //   3. Free-form markers ("I'm generating...", "(Image generation incoming.)")
    //      -> uses the story text above the marker as the prompt
    if (streamedImages.length === 0) {
      for (const entry of pendingToolCalls.values()) {
        if (!/image/i.test(entry.name || "")) continue;
        const p = parseToolPrompt(entry.args);
        if (p) toolPrompts.push(p);
        break;
      }
      dndLog("fallback detection", {
        streamedImages: streamedImages.length,
        toolPromptsSoFar: toolPrompts.length,
        bracketedFound: extractBracketedImagePrompts(fullReply).length,
        freeformFound: !!extractFreeformImagePrompt(fullReply),
        replyLength: fullReply.length,
        replyHead: fullReply.slice(0, 250),
        replyTail: fullReply.slice(-400),
        statusLinesFound: fullReply
          .split(/\r?\n/)
          .filter(isImageStatusLine)
          .slice(0, 3),
      });

      if (!toolPrompts.length) {
        toolPrompts.push(...extractBracketedImagePrompts(fullReply));
      }
      if (!toolPrompts.length) {
        const free = extractFreeformImagePrompt(fullReply);
        if (free) toolPrompts.push(free);
      }
      dndLog(
        "prompts to generate",
        toolPrompts.map((p) => String(p).slice(0, 200))
      );

      if (toolPrompts.length) {
        showStatus("🖼️ The Dungeon Master is summoning an image…");
        for (const prompt of toolPrompts) {
          try {
            const imgs = await generateImageFromPrompt(prompt);
            for (const img of imgs) {
              await addImageToBubble(img, imagesEl, streamedImages);
            }
          } catch (err) {
            dndLog("image generation failed", String(err.message || err));
            showStatus(`⚠️ Image generation failed: ${err.message}`, true);
            break; // one failure is enough — don't hammer the endpoint
          }
        }
      } else {
        dndLog("no image prompt detected", null);
      }
    }
  } catch (err) {
    const hint = String(err.message).includes("400")
      ? "\n\n(400 = Bad Request — check the Model ID and that Admin → Images uses a working engine.)"
      : "";
    if (!fullReply) {
      textEl.textContent = `⚠️ ${err.message}${hint}`;
    } else {
      appendErrorBubble(`Failed to reach the Dungeon Master: ${err.message}`);
    }
    updateConnectionPill("error", "Request failed");
  } finally {
    typingIndicator.classList.add("hidden");
    messageInput.disabled = false;
    state.streaming = false;
  }

  // Finalize visible text (markers stripped) + images in the SAME bubble.
  fullReply = stripImageStatusLines(fullReply).trim();
  textEl.innerHTML = formatMessageText(fullReply);

  if (streamedImages.length && statusEl.parentNode && !statusEl.classList.contains("error")) {
    statusEl.remove();
  }

  if (!fullReply && streamedImages.length === 0) {
    fullReply = "(The Dungeon Master falls silent...)";
    textEl.textContent = fullReply;
  }

  // Speak trailing text
  if (state.voiceEnabled) {
    const remaining = fullReply.slice(spokenUpTo);
    if (remaining.trim()) enqueueSpeech(stripForSpeech(remaining), bubble);
  }

  // Persist: text + image markdown so history reloads with pictures
  const imageMarkdown = streamedImages
    .map((img) => `![${img.alt || "Generated image"}](${img.url})`)
    .join("\n");
  const stored = imageMarkdown ? `${fullReply}\n\n${imageMarkdown}` : fullReply;
  state.messages.push({ role: "assistant", content: stored });
  persistMessages();
  renderGallery();
  hydrateImages();
  updateConnectionPill("ok", "Connected");
  scrollToBottom();
}

// Extracts generation prompts from "[Image generated: ...]" / "[Generated
// image: ...]" narration blocks the model writes when it decides on an image
// without calling the generate_image tool.
function extractBracketedImagePrompts(text) {
  if (!text) return [];
  const out = [];
  const re = /\[\s*(?:generated\s+image|image\s+(?:generated|generation))\s*[:\-]\s*([\s\S]*?)\]/gi;
  let m;
  while ((m = re.exec(text))) {
    const prompt = (m[1] || "").trim();
    if (prompt.length >= 10 && !out.includes(prompt)) out.push(prompt);
  }
  return out.slice(0, 2);
}

// Free-form prompt extraction when the model writes a status instead of a tool call.
function extractFreeformImagePrompt(text) {
  if (!text) return null;
  if (/!\[[^\]]*\]\(.+?\)/.test(text) || /data:image\//i.test(text)) return null;

  const patterns = [
    /(?:^|\n)\s*<\s*image[\s_-]*generation\s*>\s*(?:\n|\r\n?)*\s*(?:prompt\s*:\s*)?([\s\S]+)$/i,
    /(?:^|\n)\s*image\s+generation\s*[—–\-:|]\s*(?:setting\s*[—–\-:|]\s*)?([\s\S]+)$/i,
    /\[\s*image[\s_-]*generation\s*\]\s*(?:\n|\r\n?)*\s*(?:prompt\s*:\s*)?([\s\S]*)$/i,
    /(?:i(?:'|’)?m|i(?:'|’)?ll|i\s+am)\s+generat(?:e|ing)(?:\s+the|\s+an?)?\s+image\b[^\n]*\n+(?:prompt\s*:\s*)?([\s\S]+)$/i,
    /(?:^|\n)\s*prompt\s*:\s*([^\n][\s\S]{40,})$/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      let prompt = (m[1] || "")
        .replace(/^prompt\s*:\s*/i, "")
        .replace(/<\/?\s*image[\s_-]*generation\s*>/gi, "")
        .replace(/\[\s*image[\s_-]*generation\s*\]/gi, "")
        .trim();
      if (prompt.length >= 20) return prompt;
    }
  }

  // Marker with no long prompt — use narration or "of X"
  // Line-based marker detection: any line that *is* an image-status marker.
  const lines = text.split(/\r?\n/);
  const hasMarker = lines.some(isImageStatusLine);

  if (!hasMarker) return null;

  const markerLine = lines.find(isImageStatusLine) || "";
  const ofMatch = markerLine.match(
    /\b(?:of|for|showing|depicting)\s+([^.\n!?]+)/i
  );
  const narrative = stripImageStatusLines(text).trim();
  const trimmedNarration = narrative.slice(0, 900);
  if (trimmedNarration.length >= 15) return trimmedNarration;
  if (ofMatch) {
    const subject = ofMatch[1].trim().replace(/\s+as\s+described\s*$/i, "").trim();
    if (subject) return `A detailed portrait/scene of ${subject}`;
  }
  return null;
}

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || state.streaming) return;

  if (!state.apiKey) {
    appendErrorBubble("No API key set. Open ⚙️ Settings to add your Open WebUI API key.");
    openModal();
    return;
  }

  messageInput.value = "";
  appendMessageBubble("user", text);
  state.messages.push({ role: "user", content: text });
  persistMessages();
  await runAssistantTurn();
});

messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

// Boot
init();
