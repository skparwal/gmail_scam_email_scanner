import { analyze, verdictFor } from "./lib/rules.js";
import { PERSONAS, fallbackRoast } from "./lib/personas.js";

const DEFAULT_SERVER = "http://localhost:3456";
const LOADING = {
  granny: ["Putting on her reading glasses...", "Clutching pearls..."],
  detective: ["Dusting the links for prints...", "Interrogating the sender..."],
  chef: ["Tasting the phish...", "Checking if it's RAW..."],
};

const $ = (id) => document.getElementById(id);
let email = null;
let rules = null;
let inbox = [];
let view = "email";
let folder = "inbox";
const REPORT_ONLY = new Set(["spam", "trash"]);
const triage = new Map(); // inbox row key -> { verdict, quip } from the AI triage
const unticked = new Set(); // clean-up candidates the user chose to keep
const trashedLog = []; // what this session moved to Trash, for the report

const store = {
  async get(key, fallback) {
    try {
      return (await chrome.storage.sync.get(key))[key] ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    return chrome.storage.sync.set({ [key]: value }).catch(() => {});
  },
};

async function init() {
  const sel = $("persona");
  for (const [id, p] of Object.entries(PERSONAS)) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = `${p.emoji} ${p.name.split(" ")[0]}`;
    sel.appendChild(o);
  }
  sel.value = await store.get("persona", "granny");
  sel.onchange = () => {
    store.set("persona", sel.value);
    updateRoastButton();
    renderInbox();
  };

  $("server").value = await store.get("server", DEFAULT_SERVER);
  $("gear").onclick = () => {
    const s = $("settings");
    s.hidden = !s.hidden;
    $("gear").setAttribute("aria-expanded", String(!s.hidden));
    if (!s.hidden) pingServer();
  };
  $("saveServer").onclick = async () => {
    await store.set("server", $("server").value.trim().replace(/\/+$/, "") || DEFAULT_SERVER);
    pingServer();
  };
  $("roast").onclick = roast;
  $("triage").onclick = runTriage;
  $("showAll").onchange = renderInbox;
  $("threshold").value = String(await store.get("threshold", 70));
  $("threshold").onchange = () => {
    store.set("threshold", Number($("threshold").value));
    renderCleanup();
  };
  $("report").onclick = downloadReport;
  $("trash").onclick = askTrash;
  $("cancelTrash").onclick = () => ($("confirm").hidden = true);
  $("confirmTrash").onclick = doTrash;
  $("inboxPills").checked = await store.get("inboxPills", true);
  $("inboxPills").onchange = () => store.set("inboxPills", $("inboxPills").checked);
  document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => setView(b.dataset.view)));

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "emailChanged") load();
  });
  chrome.tabs.onActivated.addListener(load);
  chrome.tabs.onUpdated.addListener((_id, info) => info.status === "complete" && load());
  updateRoastButton();
  load();
  pingServer();
}

async function pingServer() {
  const status = $("serverStatus");
  status.textContent = "Checking...";
  try {
    const res = await fetch(`${await serverUrl()}/api/personas`);
    const data = await res.json();
    const ready = (data.providers || []).filter((p) => p.available).map((p) => p.label);
    status.textContent = ready.length ? `✅ Connected. AI ready: ${ready.join(", ")}.` : "⚠️ Connected, but no AI key is set on the server (rules-only).";
    await renderProviders(data.providers || [], data.defaultProvider);
  } catch {
    status.textContent = "❌ Can't reach it. Run `npm start` in the project folder.";
  }
}

// Same list as the web app: configured providers, the ones without keys disabled, plus "rules only".
async function renderProviders(list, fallback) {
  const sel = $("provider");
  sel.innerHTML = "";
  for (const p of list) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.available ? `${p.label} · ${p.model}` : `${p.label} (no key on server)`;
    o.disabled = !p.available;
    sel.appendChild(o);
  }
  const none = document.createElement("option");
  none.value = "none";
  none.textContent = "Rules only (no AI)";
  sel.appendChild(none);
  const want = await store.get("provider", "");
  sel.value = list.some((p) => p.id === want && p.available) || want === "none" ? want : fallback || "none";
  sel.onchange = () => store.set("provider", sel.value);
}

// Before the settings have been opened, send whatever was last chosen; the server falls back sensibly.
const chosenProvider = async () => $("provider").value || (await store.get("provider", ""));

const serverUrl = () => store.get("server", DEFAULT_SERVER);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function askTab(tab) {
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: "getState" });
  } catch {
    // Gmail was open before the extension was installed: inject the reader now.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    return chrome.tabs.sendMessage(tab.id, { type: "getState" });
  }
}

async function load() {
  const tab = await activeTab();
  if (!tab?.url?.startsWith("https://mail.google.com/")) return showEmpty("Open Gmail and I'll scan your inbox, or click an email for the full roast.");
  let res;
  try {
    res = await askTab(tab);
  } catch {
    return showEmpty("Couldn't read this Gmail tab. Try reloading it.");
  }

  // The list is hidden while an email is open, so keep the last scan around for the Inbox tab.
  if (res?.inbox?.length) {
    if (res.folder && res.folder !== folder) unticked.clear();
    folder = res.folder || "inbox";
    inbox = res.inbox.map((it) => {
      const r = analyze(it.text);
      return { ...it, score: r.score, verdict: verdictFor(r.score), flags: r.flags };
    });
  }
  renderInbox();

  if (!res?.email) {
    email = null;
    if (inbox.length) return setView("inbox");
    return showEmpty("Open your Gmail inbox for a scan, or click an email for the full roast.");
  }
  const key = `${res.email.fromEmail}|${res.email.subject}|${res.email.body.length}`;
  if (email && key === `${email.fromEmail}|${email.subject}|${email.body.length}`) return;
  email = res.email;
  rules = analyze(email.text, { anchors: email.links });
  renderInstant();
  setView("email");
}

function setView(v) {
  view = v === "inbox" && inbox.length ? "inbox" : email ? "email" : "inbox";
  $("empty").hidden = true;
  $("main").hidden = view !== "email";
  $("inboxView").hidden = view !== "inbox";
  $("tabs").hidden = !(email && inbox.length);
  document.querySelectorAll("#tabs button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === view)));
}

function showEmpty(text) {
  email = null;
  $("main").hidden = true;
  $("inboxView").hidden = true;
  $("tabs").hidden = true;
  $("empty").hidden = false;
  $("emptyText").textContent = text;
  $("error").hidden = true;
}

function renderInstant() {
  $("error").hidden = true;
  $("roastCard").hidden = true;
  $("todoCard").hidden = true;
  $("subject").textContent = email.subject || "(no subject)";
  $("from").textContent = email.fromEmail ? `${email.fromName} <${email.fromEmail}>` : email.fromName;
  setScore(rules.score, verdictFor(rules.score), "Instant check · rules engine · nothing sent");
  renderFlags(rules.flags, []);
  renderLinks();
  updateRoastButton();
}

// ---- Inbox scan ----

const RANK = { scam: 2, suspicious: 1, probably_legit: 0 };

// The AI triage verdict wins when present; otherwise the rules verdict from subject + preview.
function effectiveVerdict(it) {
  const ai = triage.get(it.key)?.verdict;
  if (!ai) return it.verdict;
  return RANK[ai] >= RANK[it.verdict] ? ai : it.score >= 70 ? it.verdict : ai;
}

function renderInbox() {
  const items = inbox.map((it) => ({ ...it, v: effectiveVerdict(it) }));
  const scam = items.filter((i) => i.v === "scam").length;
  const sus = items.filter((i) => i.v === "suspicious").length;
  $("statTotal").textContent = items.length;
  $("statScam").textContent = scam;
  $("statSus").textContent = sus;
  $("inboxCount").textContent = scam + sus || "";
  $("inboxTabLabel").textContent = folder === "inbox" ? "Inbox scan" : `${folder[0].toUpperCase()}${folder.slice(1)} scan`;
  const p = PERSONAS[$("persona").value] || PERSONAS.granny;
  $("triage").textContent = `Ask ${p.name.split(" ")[0]} to triage ${p.emoji}`;

  renderCleanup();

  const showAll = $("showAll").checked;
  $("listTitle").textContent = showAll ? "All scanned emails" : "Needs a closer look";
  const list = items
    .filter((i) => showAll || i.v !== "probably_legit")
    .sort((a, b) => RANK[b.v] - RANK[a.v] || b.score - a.score);
  const ul = $("inboxList");
  ul.innerHTML = "";
  if (!list.length) {
    ul.innerHTML = `<li class="none">Nothing suspicious in view. 🎉</li>`;
    return;
  }
  for (const it of list) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = "Open in Gmail";
    const pill = document.createElement("span");
    pill.className = `pill ${it.v}`;
    pill.textContent = it.v === "probably_legit" ? "OK" : it.score;
    const meta = document.createElement("div");
    meta.className = "meta";
    const sender = document.createElement("div");
    sender.className = "sender";
    sender.textContent = it.fromEmail ? `${it.fromName} · ${it.fromEmail}` : it.fromName;
    const subj = document.createElement("div");
    subj.className = "subj";
    subj.textContent = it.subject || "(no subject)";
    meta.append(sender, subj);
    if (it.flags.length) {
      const reason = document.createElement("div");
      reason.className = "reason";
      reason.textContent = it.flags.slice(0, 3).map((f) => f.label).join(" · ");
      meta.appendChild(reason);
    }
    const t = triage.get(it.key);
    if (t?.quip) {
      const q = document.createElement("div");
      q.className = "quip";
      q.textContent = `${p.emoji} ${t.quip}`;
      meta.appendChild(q);
    }
    btn.append(pill, meta);
    btn.onclick = () => openInGmail(it.key);
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

// ---- Clean up: report the high-risk emails on this page, then trash the ticked ones ----

function cleanupCandidates() {
  const min = Number($("threshold").value);
  return inbox
    .filter((it) => it.score >= min || triage.get(it.key)?.verdict === "scam")
    .sort((a, b) => b.score - a.score);
}

const ticked = () => cleanupCandidates().filter((it) => !unticked.has(it.key));

function renderCleanup() {
  const list = cleanupCandidates();
  const min = $("threshold").value;
  $("lowWarning").hidden = Number(min) >= 35;
  $("cleanupIntro").textContent = list.length
    ? `${list.length} email${list.length > 1 ? "s" : ""} on this page scored ${min}+ (or were called a scam by the AI triage). Untick any you want to keep.`
    : `Nothing on this page scores ${min}+. Nice and tidy.`;
  const ul = $("cleanupList");
  ul.innerHTML = "";
  for (const it of list) {
    const li = document.createElement("li");
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !unticked.has(it.key);
    cb.onchange = () => {
      cb.checked ? unticked.delete(it.key) : unticked.add(it.key);
      updateTrashButton();
    };
    const score = document.createElement("span");
    score.className = "score";
    score.textContent = it.score;
    const meta = document.createElement("div");
    meta.className = "meta";
    const subj = document.createElement("div");
    subj.className = "subj";
    subj.textContent = it.subject || "(no subject)";
    const sender = document.createElement("div");
    sender.className = "sender";
    sender.textContent = it.fromEmail ? `${it.fromName} · ${it.fromEmail}` : it.fromName;
    const reason = document.createElement("div");
    reason.className = "reason";
    reason.textContent = reasonsFor(it);
    meta.append(subj, sender, reason);
    label.append(cb, score, meta);
    li.appendChild(label);
    ul.appendChild(li);
  }
  $("cleanupList").hidden = !list.length;
  $("cleanupActions").hidden = !list.length;
  const reportOnly = REPORT_ONLY.has(folder);
  $("trash").hidden = reportOnly;
  $("reportOnlyNote").hidden = !reportOnly || !list.length;
  $("reportOnlyNote").textContent = folder === "spam"
    ? "📁 You're in Spam. Gmail already deletes these by itself after 30 days, and deleting from Spam is permanent, so this is report-only. Download the report, or let Gmail clear them."
    : "📁 You're in Trash. Deleting here is permanent, so this is report-only.";
  $("cleanupTitle").textContent = folder === "spam" ? "🧹 Spam folder report" : folder === "trash" ? "🧹 Trash report" : "🧹 Clean up this page";
  if (!list.length) $("confirm").hidden = true;
  updateTrashButton();
}

function reasonsFor(it) {
  const parts = it.flags.slice(0, 3).map((f) => f.label);
  if (triage.get(it.key)?.verdict === "scam") parts.push("AI triage: scam");
  return parts.join(" · ");
}

function updateTrashButton() {
  const n = ticked().length;
  $("trash").textContent = `🗑 Move ${n} to Trash`;
  $("trash").disabled = n === 0;
}

function askTrash() {
  const n = ticked().length;
  if (!n || REPORT_ONLY.has(folder)) return;
  $("confirmText").textContent = `Move ${n} email${n > 1 ? "s" : ""} to Gmail's Trash? Gmail will show an Undo button, and Trash keeps them for 30 days.`;
  $("confirm").hidden = false;
  $("cleanupResult").hidden = true;
}

async function doTrash() {
  const items = ticked();
  $("confirm").hidden = true;
  $("trash").disabled = true;
  const out = $("cleanupResult");
  let res;
  try {
    const tab = await activeTab();
    res = await chrome.tabs.sendMessage(tab.id, { type: "trashRows", keys: items.map((it) => it.key) });
  } catch (err) {
    res = { ok: false, error: "Couldn't reach the Gmail tab. Reload it and try again." };
  }
  out.hidden = false;
  out.classList.toggle("is-error", !res?.ok);
  if (res?.ok) {
    const at = new Date().toLocaleString();
    for (const it of items) trashedLog.push({ ...it, at });
    out.textContent = `✅ Moved ${res.trashed} to Trash. Changed your mind? Click Undo in Gmail, or open Trash to restore.`;
    setTimeout(load, 1500);
  } else {
    const msg = res?.error || "Something went wrong.";
    out.textContent = `⚠️ ${msg}${/nothing was deleted/i.test(msg) ? "" : " Nothing was deleted."}`;
    updateTrashButton();
  }
}

function downloadReport() {
  const gone = new Set(trashedLog.map((it) => it.key));
  const list = cleanupCandidates().filter((it) => !gone.has(it.key));
  const min = $("threshold").value;
  const now = new Date();
  const line = (it, mark) =>
    `| ${mark} | ${it.score} | ${esc(it.fromName)} <${esc(it.fromEmail)}> | ${esc(it.subject)} | ${esc(reasonsFor(it))} |`;
  const md = [
    `# Suspicious email report`,
    ``,
    `Generated ${now.toLocaleString()} by Scam Message Roaster from the current page of the Gmail "${folder}" folder.`,
    `Threshold: risk score ${min}+ (rules engine on sender, subject and preview), or flagged as a scam by AI triage.`,
    ``,
    `## Flagged on this page (${list.length})`,
    ``,
    `| Selected | Risk | From | Subject | Why |`,
    `|---|---|---|---|---|`,
    ...list.map((it) => line(it, unticked.has(it.key) ? "keep" : "trash")),
    ...(trashedLog.length
      ? [``, `## Moved to Trash this session (${trashedLog.length})`, ``, `| When | Risk | From | Subject | Why |`, `|---|---|---|---|---|`,
         ...trashedLog.map((it) => line(it, it.at))]
      : []),
    ``,
    `Emails moved to Trash stay recoverable in Gmail for 30 days.`,
    ``,
  ].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
  a.download = `suspicious-email-report-${now.toISOString().slice(0, 10)}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const esc = (s) => String(s || "").replace(/\|/g, "\\|").replace(/\s+/g, " ");

async function openInGmail(key) {
  const tab = await activeTab();
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "openRow", key });
  } catch {}
}

async function runTriage() {
  if (!inbox.length) return;
  const personaId = $("persona").value;
  const btn = $("triage");
  btn.disabled = true;
  $("error").hidden = true;
  $("loadingText").textContent = (LOADING[personaId] || LOADING.granny)[0];
  $("loading").hidden = false;
  try {
    const res = await fetch(`${await serverUrl()}/api/triage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        persona: personaId,
        provider: await chosenProvider(),
        items: inbox.slice(0, 50).map((it) => ({ from: it.fromEmail ? `${it.fromName} <${it.fromEmail}>` : it.fromName, subject: it.subject, snippet: it.snippet })),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Server error");
    for (const r of data.items) {
      const it = inbox[r.id];
      if (it) triage.set(it.key, { verdict: r.verdict, quip: r.quip });
    }
    $("triageSummary").textContent = `${PERSONAS[personaId].emoji} ${data.summary}`;
    $("triageSummary").classList.remove("is-error");
    $("triageSummary").hidden = false;
    renderInbox();
  } catch (err) {
    const el = $("triageSummary");
    el.textContent = /fetch|network/i.test(err.message) ? "⚠️ Roast server isn't running. Start it with `npm start`." : `⚠️ ${err.message}`;
    el.classList.add("is-error");
    el.hidden = false;
  } finally {
    $("loading").hidden = true;
    btn.disabled = false;
  }
}

function setScore(score, verdict, note) {
  const [label, color] = {
    scam: ["🚨 Scam", "var(--hot)"],
    suspicious: ["⚠️ Suspicious", "var(--warm)"],
    probably_legit: ["✅ Probably legit", "var(--cool)"],
  }[verdict];
  $("score").textContent = score;
  $("ring").style.setProperty("--pct", score);
  $("ring").style.setProperty("--c", color);
  $("verdict").textContent = label;
  $("verdict").style.color = color;
  $("scoreNote").textContent = note;
}

// Show each flag with a short excerpt of the email around where it fired.
function renderFlags(ruleFlags, aiFlags) {
  const ul = $("flags");
  ul.innerHTML = "";
  if (!ruleFlags.length && !aiFlags.length) {
    ul.innerHTML = `<li class="none">No red flags found.</li>`;
    return;
  }
  for (const f of ruleFlags) {
    const span = f.spans[0];
    addFlag(ul, "Rule", f.label, f.why, span ? excerpt(email.text, span.start, span.end) : null);
  }
  for (const f of aiFlags) {
    addFlag(ul, "AI", f.quote ? `“${clip(f.quote, 70)}”` : "Roaster's note", f.why, null);
  }
}

function addFlag(ul, src, label, why, snippet) {
  const li = document.createElement("li");
  const tag = document.createElement("span");
  tag.className = `src ${src === "AI" ? "ai" : ""}`;
  tag.textContent = src;
  const body = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = label;
  const p = document.createElement("span");
  p.className = "why";
  p.textContent = why;
  body.append(strong, p);
  if (snippet) body.appendChild(snippet);
  li.append(tag, body);
  ul.appendChild(li);
}

function excerpt(text, start, end) {
  const pad = 40;
  const a = Math.max(0, start - pad);
  const b = Math.min(text.length, end + pad);
  const q = document.createElement("q");
  q.className = "snippet";
  q.append((a > 0 ? "…" : "") + text.slice(a, start).replace(/\s+/g, " "));
  const m = document.createElement("mark");
  m.textContent = clip(text.slice(start, end).replace(/\s+/g, " "), 80);
  q.append(m, text.slice(end, b).replace(/\s+/g, " ") + (b < text.length ? "…" : ""));
  return q;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function hostOf(href) {
  try {
    return new URL(href).hostname;
  } catch {
    return href;
  }
}

// Only list links whose visible text differs from their real host, or that tripped a rule.
function renderLinks() {
  const flaggedHosts = new Set(rules.flags.map((f) => f.detail).filter(Boolean));
  const rows = email.links.filter((l) => {
    const host = hostOf(l.href);
    return flaggedHosts.has(host) || (l.text && !l.text.toLowerCase().includes(host.replace(/^www\./, "")));
  });
  const ul = $("links");
  ul.innerHTML = "";
  for (const l of rows.slice(0, 12)) {
    const host = hostOf(l.href);
    const li = document.createElement("li");
    if (flaggedHosts.has(host)) li.className = "bad";
    const shows = document.createElement("div");
    shows.className = "shows";
    shows.textContent = `Says: ${clip(l.text || "(image or button)", 60)}`;
    const goes = document.createElement("div");
    goes.className = "goes";
    goes.textContent = `Goes to: ${host}`;
    goes.title = l.href;
    li.append(shows, goes);
    ul.appendChild(li);
  }
  $("linksCard").hidden = !rows.length;
}

function updateRoastButton() {
  const p = PERSONAS[$("persona").value] || PERSONAS.granny;
  $("roast").textContent = `Roast it with ${p.name.split(" ")[0]} ${p.emoji}`;
}

async function roast() {
  if (!email) return;
  const personaId = $("persona").value;
  const persona = PERSONAS[personaId];
  const btn = $("roast");
  btn.disabled = true;
  $("error").hidden = true;
  const lines = LOADING[personaId] || LOADING.granny;
  let i = 0;
  $("loadingText").textContent = lines[0];
  $("loading").hidden = false;
  const ticker = setInterval(() => ($("loadingText").textContent = lines[++i % lines.length]), 1400);

  let data;
  let offline = "";
  try {
    const res = await fetch(`${await serverUrl()}/api/roast`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: email.text, links: email.links, persona: personaId, provider: await chosenProvider() }),
    });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || "Server error");
    if (data.mode !== "ai") {
      offline = data.ai_error
        ? `${data.ai_error}. Showing the rules-engine roast.`
        : "No AI model is selected or set up on the server, so this roast came from the rules engine.";
    }
  } catch (err) {
    data = { ...fallbackRoast(rules, persona), risk_score: rules.score, verdict: verdictFor(rules.score), rules, mode: "offline" };
    offline = /fetch|network/i.test(err.message)
      ? "Roast server isn't running, so this is the offline roast. Run `npm start` for AI roasts."
      : `Server said: ${err.message}. Showing the offline roast.`;
  } finally {
    clearInterval(ticker);
    $("loading").hidden = true;
    btn.disabled = false;
  }
  renderRoast(data, persona, offline);
}

function renderRoast(data, persona, offline) {
  const note = data.mode === "ai" ? `Rules ${data.rules.score} · ${data.provider} ${Math.round(data.ai_score)} · blended` : "Rules engine";
  setScore(data.risk_score, data.verdict, note);
  $("pEmoji").textContent = persona.emoji;
  $("pName").textContent = persona.name;
  $("headline").textContent = data.headline;
  const box = $("roastText");
  box.innerHTML = "";
  for (const para of data.roast.split(/\n\s*\n/)) {
    const p = document.createElement("p");
    p.textContent = para.trim();
    box.appendChild(p);
  }
  $("scamType").textContent = data.scam_type && !/^none/i.test(data.scam_type) ? `Case file: ${data.scam_type}` : "";
  $("offlineNote").hidden = !offline;
  $("offlineNote").textContent = offline;
  $("roastCard").hidden = false;

  renderFlags(rules.flags, data.red_flags || []);
  const todo = $("todo");
  todo.innerHTML = "";
  for (const s of data.what_to_do || []) {
    const li = document.createElement("li");
    li.textContent = s;
    todo.appendChild(li);
  }
  $("todoCard").hidden = !(data.what_to_do || []).length;
  $("roastCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

init();
