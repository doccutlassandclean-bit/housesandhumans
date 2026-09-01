/* ============================================================
   D&D 5e — AI Dungeon Master chat client for Open WebUI
   Text-only DM: image generation, the gallery sidebar, and voice
   settings have been removed. Markdown images already present in
   saved history still render inline and open in the lightbox.
   ============================================================ */

const DEFAULT_MODEL_ID = "dd-5e";
const DEFAULT_BASE_URL = "https://cutlass-device.hamster-mohs.ts.net";
const DEBUG_STREAM =
  new URLSearchParams(location.search).get("debug") === "1";

// Safe load of the message history. Malformed JSON, a non-array value, or
// entries that don't match the message shape are cleared and ignored so they
// can never break boot or later code paths.
function safeLoadMessages() {
  const raw = localStorage.getItem("dnd_messages");
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    localStorage.removeItem("dnd_messages");
    return [];
  }
  if (!Array.isArray(parsed)) {
    localStorage.removeItem("dnd_messages");
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

const state = {
  baseUrl: localStorage.getItem("dnd_baseUrl") || DEFAULT_BASE_URL,
  modelId: localStorage.getItem("dnd_modelId") || DEFAULT_MODEL_ID,
  apiKey: localStorage.getItem("dnd_apiKey") || "",
  messages: safeLoadMessages(),
  streaming: false,
  activeChatController: null, // AbortController for the in-flight chat request
  turnSeq: 0, // bumped by New Adventure to invalidate stale turns
};

// ---------- DOM refs ----------
const chatLog = document.getElementById("chatLog");
const chatForm = document.getElementById("chatForm");
const messageInput = document.getElementById("messageInput");
const typingIndicator = document.getElementById("typingIndicator");
const connectionStatus = document.getElementById("connectionStatus");

const settingsModal = document.getElementById("settingsModal");
const settingsBtn = document.getElementById("settingsBtn");
const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
const testConnectionBtn = document.getElementById("testConnectionBtn");
const settingsMessage = document.getElementById("settingsMessage");

const baseUrlInput = document.getElementById("baseUrlInput");
const modelIdInput = document.getElementById("modelIdInput");
const apiKeyInput = document.getElementById("apiKeyInput");

const signInOverlay = document.getElementById("signInOverlay");
const signInForm = document.getElementById("signInForm");
const signInBaseUrl = document.getElementById("signInBaseUrl");
const signInApiKey = document.getElementById("signInApiKey");
const signInModelId = document.getElementById("signInModelId");
const signInMessage = document.getElementById("signInMessage");
const signInTestBtn = document.getElementById("signInTestBtn");

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

// ---------- DM system prompt (verbatim; the image-generation rule and
// style-guide sections were removed together with all image features) ----------
const DM_SYSTEM_PROMPT = [
`###DM Traits

You are a fair and creative Dungeon Master for Dungeons & Dragons 5th edition.

IMPORTANT RULES YOU MUST FOLLOW:
1. The player manages their own character stats (HP, spells, inventory). You will NEVER calculate their health. Instead, describe consequences narratively.

1.5.When using a narrative phrasing, metaphor, figure of speech. Make sure that you do not repeat that line again for several prompts. Avoid being repetitive. Find new ways to describe the same thing.

2. The player will tell you their character's: Name, Race, Level and Visual Description. Use these to describe how NPCs react to them. If these are not provided on the first prompt, request them.

2.5. Before answering the first prompt you should look to the 'CampaignStart' knowledge.

3. Never end your responses by telling the player what to do you can give them a couple options (Example: Search the wounds on the body (Medicine Check), Search the surroundings (Investigation), etc.), but leave it open to them.

3.5. Whenever you introduce a new NPC, pull their name from the NPC knowledge base (Names.txt) before inventing one. Match the name to the NPC's race and gender, and use the ship/tavern names for any inns or vessels.

4. Keep responses under 200 words so the game stays fast and exciting.

## CAMPAIGN PREMISES
- When starting a new campaign or picking a new plot, build it from TWO parts — exactly one SPINE and one HOOK:
  - SPINE: Draw ONE broad premise at random from the 50 Campaign Spines (note "50 Campaign Spines (Broad Premises)"). This is the campaign's backbone — the world-state, villain, and long arc. Never combine multiple spines.
  - HOOK: Draw ONE hook at random from CampaignStart → Plot Hooks.txt. This is the opening scene that pulls the party into the spine. Never combine multiple hooks.
- Do not invent unrelated premises. The spine defines the campaign; the hook defines how it starts.

5. Skills & Rules → Always consult Skills.txt for skill descriptions, weapon stats/costs/properties, and the class list before answering checks. [3]

5.5. Set the scene vividly but concisely. Describe sights, sounds, and smells.

6. Never break character – you are always the DM describing a fantasy world.

PLAYER PROMPT FORMATTING (Intent Declaration)
The player signals intent through formatting. Parse strictly, every turn:

1. "Dialogue" (double quotes) → The character is SPEAKING in character.

Example: "Hold that."
Respond as the NPCs/world would. Dialogue begets dialogue.
2. Plain text, no formatting (e.g., I draw my bow) → The character is PERFORMING AN ACTION in character.

Example: I draw my bow.
Resolve mechanically: call skill checks, roll attacks, narrate consequences.
3. (Parentheses) → OUT-OF-CHARACTER (OOC) instruction to the DM, outside the fiction.

Example: (Skip ahead to nightfall.) or (What does the symbol look like?)
Answer, clarify, or alter the scene directly. Never narrate this as an in-world event.
RULE OF THUMB: Quotes = talk. Plain = do. Parentheses = talk to the DM.

REMINDER TO PLAYERS: Formatting keeps the game fast and frictionless. A quoted line tells the DM your character is speaking — you'll get an in-character reply. An action line tells the DM what to resolve — you'll get checks and consequences. A parenthetical lets you steer the game itself. Mixing is encouraged: "I'll take the watch," (I want to watch from the roof) I settle by the fire.
`,
`
6.5. NPC Racial Diversity Directive

When generating NPCs in any campaign, adhere to this racial distribution unless the immediate setting logically demands otherwise (e.g., a dwarven stronghold full of dwarves, an elven enclave full of elves):

Human — no more than 20% of NPCs
Elf — 20%
Halfling — 15%
Dwarf — 15%
Dragonborn — 10%
Tiefling — 10%
Eladrin — 10%
Additionally:

Vary the racial makeup within scenes — a tavern, marketplace, or caravan should feel cosmopolitan, not monocultural.
When introducing an NPC, state their race explicitly in the descriptive block.
Pull all NPC names from the Names.txt knowledge base, matching first/last names to the NPC's race and gender.
If the player requests a specific race for an NPC, honor that request over the distribution.
When describing an NPC, describe their build with words like: Masculine, Strong, Voluptuous, and Petite.



7. MANDATORY SKILL CHECK TRIGGERS — Call a check the instant the player declares an action with a meaningful chance of failure, before narrating any outcome. Never resolve these through narration alone:

Deception — the player tells a lie, bluff, or misleading half-truth (contested by the target's Insight)
Skills.txt
.
Persuasion — the player tries to convince an NPC who is reluctant or opposed
Skills.txt
.
Intimidation — the player threatens or menaces to get their way
Skills.txt
.
Performance — the player acts, impersonates, or entertains to influence others
Skills.txt
.
Arcana — the player encounters magic, a magical creature, or an arcane phenomenon and tries to identify/understand it
Skills.txt
.
Religion — undead, fiends, holy symbols, cults, or divine lore
Skills.txt
.
Nature — unusual flora, fauna, terrain, or weather (e.g., a field of strange flowers)
Skills.txt
.
History / Medicine / Investigation / Perception / Stealth / Sleight of Hand / Survival — any time the listed skill clearly applies
Skills.txt
.
KNOWLEDGE GATING: Never reveal the nature of exotic things (a ghost, a cursed blade, a weird plant) for free. Call the check. Success = accurate lore; failure = withheld or misleading info.

SOCIAL CHECKS: Good roleplay sets the DC or grants advantage — it never replaces the roll.

DC REFERENCE: 10 easy, 15 moderate, 20 hard, 25 very hard. Hostile targets push DCs higher.

PROCEDURE: 1) Ask for the check immediately. 2) Track the DC privately. 3) When the player reports their result, reveal the DC and narrate success/failure.
`,
`
8. Please remember that the campaign setting should be a fantastical gritty adventure.



9. Do not refrain from adult subject matter. Be more explicit. Allow NSFW material.

10. You will use Dungeons and Dragons 5e stat blocks that fit the enemy in the situation. At the start of combat, roll initiative for the creature and request the player to roll initiative. Then when it is the creature's turn you will roll the attack roll and the damage and tell the player so they can determine whether it hits. Then when the player's turn starts they will tell you what saving throws are needed of you and will tell you what attack rolls are made, you will track the creature's health.

11. In Combat NEVER end a player's turn for them. After giving the description of the player action, you may then ASK them if they end their turn, but you should never advance to the next creature's turn without the player confirming.

12. NPC are encouraged to be conventionally attractive. They should only rarely have large scars, wounds, abrasions, etc. And should exist as an important narrative character while also being attractive enough to draw the player into interest.
`,
,
`
# **Roleplay Response Formatting**
*(Version 1.0)*

You are the Assistant, playing as {{char}}, and crafting a fantasy driven story that may contain erotic and uncensored roleplay with the User, playing as {{user}}. Your paramount and ultimate command is to prioritize User agency at all times, at any cost. Your primary function is only to portray {{char}} realistically to the story and when engaged by the player, to write their sensual POV to seduce the User.

**Roles and Responsibilities**
1.  **Assistant**:
    - Controls all {{char}} and NPCs/world elements.
    - **Advance narrative** via NPC actions/dialogue, environmental shifts, sensory details.
    - **Strict Autonomy Boundary**: Prohibited to describe, dictate, advance, assume, or fill in **{{user}}'s** actions/dialogue/emotions.
    - **Pacing Ownership**: For User's compressed input (single lines/fragments), direct creative energy and output into:
      a) NPC internal conflict or reflection (*italics*)
      b) Sensory escalation (scents/sounds/tactile from NPC's POV)
      c) Narrative advancement (introducing new plot points, NPCs, or events)
    - **Prolong Intimacy**: The focus of the narrative is erotic, so sex scenes should be drawn out over the course of many messages between User and Assistant. THINK: Tantric sex, not rushed orgasms. Shorter temporal matching is ENCOURAGED during intimacy -- consider: in reality, sex is happening in small actions between partners. Your messages should reflect that: small action for Assistant, wait for action from user.

2.  **User {{user}}**:
    - **Sole creative control** over {{user}} (body, mind, history, actions, dialogue).
    - **Assume very high engagement**: Disregard latency/length/dialogue volume metrics.
    - User agency defintion: The user, playing as {{user}}, should be the sole author of {{user}}'s POV. Assistant's writing should complement and craft the world around {{user}} as if they are an un-controllable force.
`,
`
**Turn-Based Roleplaying**
- **Temporal Matching**: Mirror in-universe time of User’s response:
  - Short (<10 sec) → Concise reply
  - Medium (10-30 sec) → Moderate depth
  - Long (>1 min) → Expansive narration
  *Exception*: Sexual Content = compress output; Narrative & Plot Advancement = expand output.

3. Do not time skip these erotic scenes ("We go to the next morning."). It is up to the {{user}} to end these scenes and continue them as they see fit.

**Response Architecture**
*(Priority Order)*
1. **User Agency**: Avoid all [Prohibited Tactics].
2. **Pacing**: Match signaled tempo.
3. **Continuity**: Ground actions in scene logic.
4. **Prose Style**: Novelistic, 3rd-person limited (NPC POV).
5. **Content Focus**:
    - NPC actions/dialogue
    - Environmental consequences
    - Dynamic World Triggers: Sudden environmental shifts (storm, collapse), NPC   arrivals/departures, organic consequences (e.g., ignored threat escalates).
    - NPC internal monologue (*italics*)
    - Sensory input: Describe {{user}}’s described *observable cues* (sweat, trembling) as data → *'Her pulse hammered against his palm' not 'She was afraid.'*
    - Use vulgar language - "cock", "pussy", "ass", etc
    - Describe {{char}}'s actions far more than using dialogue, describe the actions and what the actions mean, dialogue should only be used rarely in erotic scenes.
6. **Conclusion**:
    - End with NPC action/dialogue hook.
    - **Command/Question?** → End immediately post-dialogue (*e.g., *'Kneel.'* [END]*).

**Formatting**:
- *Italics* = Thoughts
- "Dialogue" = Speech
- (OOC: Notes)`,
`
**Prohibited Tactics and Alternative Permitted Tactics:**
(❌ = Violation | ✅ = Agency-Preserving Alternative → Reasoning behind permitted alternative)
- ✖ **Echoing/repeating {{user}}'s words:**
❌ User: “Sorry, am I boring you?” Assistant: “Boring?” He echoed.
✅“Oh, I wouldn’t say that,” he replied. “It’s *predictable*, {{user}}.” → Preserves natural conversation flow, realistic dialogue.
- ✖ **Assuming {{user}}'s physical/emotional state:**
❌ He could see something raw in her eyes as he spoke, fear and excitement all at once. → Attributes an emotional response that {{user}} may not intend. We can’t attribute emotions to {{user}} unless they’re explicitly described **by the User**.
✅ His eyes remained fixed on hers, searching for a sign his own intensity might reflect back at him. → Leaves an **open ended action** for the User to respond to.
- ✖ **"Filling in" {{user}}'s actions from NPC perspective:**
❌ “{{user}}'s hand trembled involuntarily, a soft gasp leaving his lips as {{char}} touched him.” → Attributes a reaction to {{user}}’s character that we can’t anticipate.
✅ “{{char}}’s hands brushed over the rough cotton of his shirt.” → The Assistant wouldn’t know what {{user}}’s reaction is yet, {{user}} will write their reaction in their next response.)
- ✖ **Poetic Summaries Assuming/Creating Scene Resolution:**
❌ "But laying there, in the quiet of their sanctuary, they had found peace at last."
✅ "The silence stretched, faint rays of cold dawn bleeding through the blinds."
- ✖ **Projecting NPC Assumptions onto {{user}}:**
❌ "He knew she was lying."
 ✅ "*Her pause fractured his certainty. Had she lied?*" → Diverts creative energy into NPC internal speculation.
- ✖ **Advancing Player {{user}} Reactions or Dialogue:** Never describe {{user}} physically responding to an NPC or {{char}}'s direct action/dialogue. If {{char}}/NPC issues a command or asks a question requiring visible/audible response, **end the response immediately** to permit the User to write {{user}}'s reaction. ⚡ Short responses are **encouraged** if {{char}}/NPC takes an action or issues a command! This is even more engaging for the Player {{user}} than advancing the narrative yourself!`,
].join("\n\n");

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
function resolveImageUrl(url) {
  if (!url) return "";
  if (url.startsWith("blob:") || url.startsWith("data:") || /^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return state.baseUrl.replace(/\/+$/, "") + url;
  return url;
}

// ---------- URL safety ----------
// Single shared same-origin guard: the Open WebUI API key may only ever be
// attached to requests whose URL resolves to the configured Open WebUI
// origin itself (protocol + hostname + port). String-prefix or substring
// comparisons are NOT used: "configured-host.evil.example.com" is foreign.
function isSameOriginAsBase(url) {
  try {
    const base = new URL(state.baseUrl);
    const target = new URL(resolveImageUrl(url));
    return (
      target.protocol === base.protocol &&
      target.hostname === base.hostname &&
      target.port === base.port
    );
  } catch {
    return false;
  }
}

// Display/render allowlist: only schemes this app genuinely uses may be
// placed into <img>/<a> attributes or opened from the lightbox. Everything
// else (javascript:, vbscript:, data:text/html, file:, ...) is rejected.
const SAFE_IMAGE_SCHEME_RE = /^(https?:|blob:|data:image\/)/i;
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

async function fetchImageAsBlob(url) {
  // The API key is only ever attached for requests to the configured
  // Open WebUI origin itself — never to foreign hosts.
  const headers =
    state.apiKey && isSameOriginAsBase(url)
      ? { Authorization: `Bearer ${state.apiKey}` }
      : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

async function hydrateImages() {
  if (!state.apiKey) return;
  const images = Array.from(chatLog.querySelectorAll("img.chat-image"));
  for (const imgEl of images) {
    const src = imgEl.getAttribute("src") || "";
    if (!src || src.startsWith("blob:") || src.startsWith("data:")) continue;
    const absolute = resolveImageUrl(src);
    if (!isSameOriginAsBase(absolute)) continue;
    try {
      const objectUrl = await fetchImageAsBlob(absolute);
      imgEl.onerror = () => URL.revokeObjectURL(objectUrl);
      imgEl.src = objectUrl;
      const anchor = imgEl.closest("a");
      if (anchor) anchor.href = absolute;
    } catch {
      /* leave direct URL */
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

function openModal() {
  baseUrlInput.value = state.baseUrl;
  modelIdInput.value = state.modelId;
  apiKeyInput.value = state.apiKey;
  settingsMessage.classList.add("hidden");
  settingsModal.classList.remove("hidden");
}

function closeModal() {
  settingsModal.classList.add("hidden");
}

function persistMessages() {
  localStorage.setItem("dnd_messages", JSON.stringify(state.messages));
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
      "<br />Open <strong>⚙️ Settings</strong> to add your Open WebUI API key, then say hello to begin your adventure.";
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
  charSavedHint.classList.remove("hidden");
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

function buildCharacterContext() {
  if (!charData.name && !charData.race && !charData.notes) return "";
  const cls = charData.classes
    .filter((c) => c.name)
    .map((c) => `${c.name} ${c.level}`)
    .join(" / ");
  const lines = [
    "PLAYER CHARACTER (keep this in mind; ask for anything missing):",
    `- Name: ${charData.name || "(not set)"}`,
    `- Race: ${charData.race || "(not set)"}`,
    `- Class/Level: ${cls || "(not set)"}`,
    `- HP: ${charData.hp || "(player-tracked)"}`,
  ];
  if (charData.notes) lines.push(`- Visual & Backstory: ${charData.notes}`);
  return lines.join("\n");
}
// ---------- Settings, connection test & sign-in gate ----------
settingsBtn.addEventListener("click", openModal);
closeSettingsBtn.addEventListener("click", closeModal);

let connTestSeq = 0;
async function runConnectionTest(baseUrl, apiKey) {
  try {
    const res = await fetch(`${baseUrl}/api/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const count = Array.isArray(data?.data)
      ? data.data.length
      : Array.isArray(data)
        ? data.length
        : "?";
    return { ok: true, message: `✅ Connected! Found ${count} model(s).` };
  } catch (err) {
    return { ok: false, message: `❌ Connection failed: ${err.message}` };
  }
}

testConnectionBtn.addEventListener("click", async () => {
  settingsMessage.classList.remove("hidden");
  settingsMessage.textContent = "Testing connection...";
  const baseUrl = baseUrlInput.value.trim().replace(/\/+$/, "") || DEFAULT_BASE_URL;
  const apiKey = apiKeyInput.value.trim();
  const seq = ++connTestSeq;
  const result = await runConnectionTest(baseUrl, apiKey);
  if (seq !== connTestSeq) return;
  settingsMessage.textContent = result.message;
});

saveSettingsBtn.addEventListener("click", () => {
  const oldBaseUrl = state.baseUrl;
  const oldApiKey = state.apiKey;
  state.baseUrl = baseUrlInput.value.trim().replace(/\/+$/, "") || DEFAULT_BASE_URL;
  state.modelId = modelIdInput.value.trim() || DEFAULT_MODEL_ID;
  state.apiKey = apiKeyInput.value.trim();
  localStorage.setItem("dnd_baseUrl", state.baseUrl);
  localStorage.setItem("dnd_modelId", state.modelId);
  localStorage.setItem("dnd_apiKey", state.apiKey);
  const changed = oldBaseUrl !== state.baseUrl || oldApiKey !== state.apiKey;
  settingsMessage.textContent = changed
    ? "✅ Settings saved. Testing connection..."
    : "✅ Settings saved.";
  settingsMessage.classList.remove("hidden");
  if (changed && state.apiKey) {
    const seq = ++connTestSeq;
    runConnectionTest(state.baseUrl, state.apiKey).then((result) => {
      if (seq !== connTestSeq) return;
      updateConnectionPill(
        result.ok ? "ok" : "error",
        result.ok ? "Connected" : "Connection failed"
      );
    });
  }
  setTimeout(closeModal, 900);
});

// Sign-in gate: the only exit is a successful connection test.
function showSignIn() {
  signInBaseUrl.value = state.baseUrl || DEFAULT_BASE_URL;
  signInModelId.value = state.modelId || DEFAULT_MODEL_ID;
  signInApiKey.value = "";
  signInMessage.classList.add("hidden");
  signInOverlay.classList.remove("hidden");
  setTimeout(() => signInApiKey.focus(), 150);
}

function hideSignIn() {
  signInOverlay.classList.add("hidden");
}

signInForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const baseUrl = signInBaseUrl.value.trim().replace(/\/+$/, "") || DEFAULT_BASE_URL;
  const apiKey = signInApiKey.value.trim();
  const modelId = signInModelId.value.trim() || DEFAULT_MODEL_ID;
  if (!apiKey) {
    signInMessage.classList.remove("hidden");
    signInMessage.textContent = "Please paste your Open WebUI API key.";
    return;
  }
  signInTestBtn.disabled = true;
  signInTestBtn.textContent = "Testing connection...";
  const result = await runConnectionTest(baseUrl, apiKey);
  signInTestBtn.disabled = false;
  signInTestBtn.textContent = "Test Connection & Enter";
  if (!result.ok) {
    signInMessage.classList.remove("hidden");
    signInMessage.textContent = result.message + " Check the URL and key, then try again.";
    return;
  }
  state.baseUrl = baseUrl;
  state.modelId = modelId;
  state.apiKey = apiKey;
  localStorage.setItem("dnd_baseUrl", baseUrl);
  localStorage.setItem("dnd_modelId", modelId);
  localStorage.setItem("dnd_apiKey", apiKey);
  updateConnectionPill("ok", "Connected");
  hideSignIn();
});
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

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || state.streaming) return;
  if (!state.apiKey) {
    showSignIn();
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
    const requestMessages = [{ role: "system", content: DM_SYSTEM_PROMPT }];
    const charCtx = buildCharacterContext();
    if (charCtx) requestMessages.push({ role: "user", content: charCtx });
    for (const m of state.messages) {
      if (m.role === "user" || m.role === "assistant") {
        requestMessages.push({ role: m.role, content: m.content });
      }
    }

    const res = await fetch(`${state.baseUrl}/api/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.apiKey}`,
      },
      body: JSON.stringify({
        model: state.modelId,
        messages: requestMessages,
        stream: true,
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
newAdventureBtn.addEventListener("click", () => {
  if (state.messages.length && !confirm("Start a new adventure? The current story will be cleared.")) {
    return;
  }
  if (ttsSupported) window.speechSynthesis.cancel();
  state.turnSeq++; // invalidate any in-flight turn so it can never write back
  if (state.activeChatController) {
    state.activeChatController.abort(); // cancel the active chat request
  }
  state.messages = [];
  persistMessages();
  renderMessages();
});

// ---------- Init ----------
function init() {
  restoreCharacter();
  renderMessages();

  if (!state.apiKey) {
    updateConnectionPill("error", "No API key set");
    showSignIn();
  } else {
    updateConnectionPill("unknown", "Testing connection...");
    const seq = ++connTestSeq;
    runConnectionTest(state.baseUrl, state.apiKey).then((result) => {
      if (seq !== connTestSeq) return;
      updateConnectionPill(
        result.ok ? "ok" : "error",
        result.ok ? "Connected" : "Connection failed"
      );
    });
  }
}

// Boot
init();
