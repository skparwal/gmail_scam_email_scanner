import { analyze } from "/rules.js";

const SAMPLES = {
  package: "USPS: Your package could not be delivered due to an incomplete address. To avoid return, pay the $1.99 redelivery fee within 24 hours: https://usps-redelivery-help.top/track?id=US9514",
  paypal: "From: PayPal Security <service@paypa1-secure.com>\nSubject: URGENT: Unusual sign-in activity\n\nDear Customer,\n\nWe detected unusual sign-in activity on your account. Your account will be suspended unless you verify your account immediately.\n\nConfirm your password and card details here: http://paypa1-secure.com/login\n\nFailure to do so within 24 hours will result in permanent closure.\n\nPayPal Team",
  mum: "Hi Mum, this is my new number, I dropped my old phone in the toilet 🙈 can't call right now. Can you text me on WhatsApp? I need to pay a bill urgently, I'll pay you back tomorrow x",
  prize: "CONGRATULATIONS!!! You've been selected as this week's WINNER of a $1000 Walmart gift card. Claim your prize now before it expires today: bit.ly/3xWmRz",
  legit: "Hi Sam, it's Priya from Dr. Chen's office. Just confirming your dental cleaning on Thursday at 2:30pm. Reply C to confirm or call the front desk if you need to reschedule. See you then!",
};

const LOADING = {
  granny: ["Granny is putting on her reading glasses...", "Clutching pearls...", "Muttering about 'kids these days'..."],
  detective: ["Lighting a cigarette in the rain...", "Dusting the link for prints...", "Interrogating the sender..."],
  chef: ["Tasting the phish...", "Throwing the plate at the wall...", "Checking if it's RAW..."],
};

const $ = (id) => document.getElementById(id);
const msg = $("msg");
let persona = "granny";
let personas = [];
const saved = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

async function init() {
  try {
    const res = await fetch("/api/personas");
    const data = await res.json();
    personas = data.personas;
    renderProviders(data.providers || [], data.defaultProvider);
  } catch {
    personas = [{ id: "granny", name: "Granny Gigabyte", emoji: "👵", tagline: "" }];
  }
  renderPersonas();
}

// Every configured provider, plus "rules only". Providers without a key are shown but disabled.
function renderProviders(list, fallback) {
  const sel = $("provider");
  sel.innerHTML = "";
  for (const p of list) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.available ? `${p.label} · ${p.model}` : `${p.label} (no key)`;
    o.disabled = !p.available;
    sel.appendChild(o);
  }
  const none = document.createElement("option");
  none.value = "none";
  none.textContent = "Rules only (no AI)";
  sel.appendChild(none);
  const want = saved("provider");
  sel.value = list.some((p) => p.id === want && p.available) || want === "none" ? want : fallback;
  sel.onchange = () => save("provider", sel.value);
}

function renderPersonas() {
  const wrap = $("personas");
  wrap.innerHTML = "";
  for (const p of personas) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "persona";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(p.id === persona));
    b.innerHTML = `<span class="pe"></span><span class="pn"></span><span class="pt"></span>`;
    b.querySelector(".pe").textContent = p.emoji;
    b.querySelector(".pn").textContent = p.name;
    b.querySelector(".pt").textContent = p.tagline;
    b.onclick = () => {
      persona = p.id;
      renderPersonas();
    };
    wrap.appendChild(b);
  }
}

// Live pre-check while typing: instant feedback before the roast.
function updateLive() {
  const text = msg.value;
  const live = $("live");
  if (!text.trim()) return (live.innerHTML = "");
  const r = analyze(text);
  const cls = r.score >= 70 ? "hot" : r.score >= 35 ? "warm" : "cool";
  live.className = `live ${cls}`;
  live.textContent = r.flags.length
    ? `${r.flags.length} red flag${r.flags.length > 1 ? "s" : ""} spotted: ${r.flags.slice(0, 3).map((f) => f.label).join(" · ")}${r.flags.length > 3 ? " …" : ""}`
    : "No known scam patterns yet. The roaster will take a closer look.";
}
msg.addEventListener("input", updateLive);

document.querySelectorAll("[data-sample]").forEach((b) => {
  b.onclick = () => {
    msg.value = SAMPLES[b.dataset.sample];
    updateLive();
    msg.focus();
  };
});

$("go").onclick = roast;
msg.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) roast();
});

async function roast() {
  const text = msg.value.trim();
  if (!text) {
    msg.focus();
    return showError("Paste a message first. Even scammers have to start somewhere.");
  }
  showError("");
  $("result").hidden = true;
  $("go").disabled = true;
  const loading = $("loading");
  loading.hidden = false;
  const lines = LOADING[persona] || LOADING.granny;
  let i = 0;
  $("loadingText").textContent = lines[0];
  const ticker = setInterval(() => ($("loadingText").textContent = lines[++i % lines.length]), 1400);

  try {
    const res = await fetch("/api/roast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, persona, provider: $("provider").value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    render(text, data);
  } catch (err) {
    showError(err.message || "Couldn't reach the roaster.");
  } finally {
    clearInterval(ticker);
    loading.hidden = true;
    $("go").disabled = false;
  }
}

function render(text, data) {
  const p = personas.find((x) => x.id === persona) || personas[0];
  $("result").hidden = false;

  const score = data.risk_score;
  animateNumber($("score"), score);
  const fill = $("gaugeFill");
  const len = fill.getTotalLength();
  fill.style.strokeDasharray = `${len}`;
  fill.style.strokeDashoffset = `${len}`;
  requestAnimationFrame(() => (fill.style.strokeDashoffset = `${len * (1 - score / 100)}`));
  const v = { scam: ["🚨 Scam", "hot"], suspicious: ["⚠️ Suspicious", "warm"], probably_legit: ["✅ Probably legit", "cool"] }[data.verdict];
  $("verdict").textContent = v[0];
  $("verdict").className = `verdict-tag ${v[1]}`;
  fill.dataset.level = v[1];
  $("scoreBreakdown").textContent =
    data.mode === "ai" ? `Rules ${data.rules.score} · ${data.provider} ${Math.round(data.ai_score)}` : data.ai_error ? `Rules only (${data.ai_error})` : "Rules engine only";

  $("pEmoji").textContent = p.emoji;
  $("pName").textContent = p.name;
  $("headline").textContent = data.headline;
  const roastEl = $("roast");
  roastEl.innerHTML = "";
  for (const para of data.roast.split(/\n\s*\n/)) {
    const el = document.createElement("p");
    el.textContent = para.trim();
    roastEl.appendChild(el);
  }
  $("scamType").textContent = data.scam_type && !/^none/i.test(data.scam_type) ? `Case file: ${data.scam_type}` : "";

  // Combine rule spans with the AI's quoted red flags into one annotation layer.
  const annotations = [];
  for (const f of data.rules.flags) for (const s of f.spans) annotations.push({ ...s, label: f.label, why: f.why });
  for (const f of data.red_flags || []) {
    const idx = f.quote ? text.indexOf(f.quote) : -1;
    if (idx >= 0) annotations.push({ start: idx, end: idx + f.quote.length, label: "Roaster's note", why: f.why });
  }
  renderAnnotated(text, annotations);

  const flagsEl = $("flags");
  flagsEl.innerHTML = "";
  const items = [
    ...data.rules.flags.map((f) => ({ label: f.label, why: f.why, src: "rule" })),
    ...(data.red_flags || [])
      .filter((f) => f.quote)
      .map((f) => ({ label: `“${f.quote.length > 60 ? f.quote.slice(0, 57) + "…" : f.quote}”`, why: f.why, src: "ai" })),
  ];
  if (!items.length) flagsEl.innerHTML = `<li class="none">No red flags found. Nice.</li>`;
  for (const it of items) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="src"></span><strong></strong><span class="why"></span>`;
    li.querySelector(".src").textContent = it.src === "ai" ? "AI" : "Rule";
    li.querySelector(".src").classList.add(it.src);
    li.querySelector("strong").textContent = it.label;
    li.querySelector(".why").textContent = it.why;
    flagsEl.appendChild(li);
  }

  const todo = $("todo");
  todo.innerHTML = "";
  for (const s of data.what_to_do || []) {
    const li = document.createElement("li");
    li.textContent = s;
    todo.appendChild(li);
  }

  $("result").scrollIntoView({ behavior: "smooth", block: "start" });
}

// Splits text at every annotation boundary so overlapping flags stack on the same segment.
function renderAnnotated(text, anns) {
  const pre = $("annotated");
  pre.innerHTML = "";
  $("tip").hidden = true;
  const cuts = new Set([0, text.length]);
  for (const a of anns) {
    cuts.add(a.start);
    cuts.add(a.end);
  }
  const points = [...cuts].sort((a, b) => a - b);
  for (let i = 0; i < points.length - 1; i++) {
    const [s, e] = [points[i], points[i + 1]];
    const seg = text.slice(s, e);
    const hits = anns.filter((a) => a.start <= s && a.end >= e);
    if (!hits.length) {
      pre.appendChild(document.createTextNode(seg));
      continue;
    }
    const mark = document.createElement("mark");
    mark.textContent = seg;
    mark.tabIndex = 0;
    if (hits.length > 1) mark.classList.add("multi");
    const uniq = [...new Map(hits.map((h) => [h.label + h.why, h])).values()];
    mark.title = uniq.map((h) => h.label).join(" + ");
    const show = () => showTip(mark, uniq);
    mark.onclick = show;
    mark.onkeydown = (ev) => ev.key === "Enter" && show();
    pre.appendChild(mark);
  }
}

function showTip(mark, hits) {
  const tip = $("tip");
  tip.innerHTML = "";
  for (const h of hits) {
    const d = document.createElement("div");
    d.innerHTML = "<strong></strong><span></span>";
    d.querySelector("strong").textContent = h.label;
    d.querySelector("span").textContent = h.why;
    tip.appendChild(d);
  }
  tip.hidden = false;
  document.querySelectorAll(".annotated mark.active").forEach((m) => m.classList.remove("active"));
  mark.classList.add("active");
}

function animateNumber(el, to) {
  const start = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - start) / 900);
    el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function showError(text) {
  const el = $("error");
  el.textContent = text;
  el.hidden = !text;
}

init();
