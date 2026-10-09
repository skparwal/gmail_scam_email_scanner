// Reads the email currently open in Gmail and shows a risk badge next to its subject.
// Gmail's class names are obfuscated but have been stable for years: h2.hP (subject),
// .gD (sender, with email/name attributes), .a3s (message body).

(() => {
  if (window.__scamRoasterLoaded) return;
  window.__scamRoasterLoaded = true;

  const MAX_BODY = 5500;
  let rulesPromise = null;
  let lastKey = "";

  const visible = (el) => el && el.offsetParent !== null;

  function unwrapHref(href) {
    try {
      const u = new URL(href);
      if (/(^|\.)google\.com$/.test(u.hostname) && u.pathname === "/url") return u.searchParams.get("q") || u.searchParams.get("url") || href;
    } catch {}
    return href;
  }

  function extractEmail() {
    const bodies = [...document.querySelectorAll(".a3s")].filter(visible);
    if (!bodies.length) return null;
    // In a thread, the last expanded message is the one being read.
    const bodyEl = bodies[bodies.length - 1];
    const msgEl = bodyEl.closest(".adn") || document;
    const senderEl = msgEl.querySelector(".gD[email]") || document.querySelector(".gD[email]");
    const subject = (document.querySelector("h2.hP")?.innerText || "").trim();
    const fromName = senderEl?.getAttribute("name") || senderEl?.innerText || "";
    const fromEmail = senderEl?.getAttribute("email") || "";

    let body = bodyEl.innerText.replace(/\n{3,}/g, "\n\n").trim();
    const truncated = body.length > MAX_BODY;
    if (truncated) body = body.slice(0, MAX_BODY) + "\n[…truncated]";

    const seen = new Set();
    const links = [];
    for (const a of bodyEl.querySelectorAll("a[href]")) {
      const href = unwrapHref(a.href);
      if (!/^https?:/i.test(href)) continue;
      const text = (a.innerText || a.getAttribute("aria-label") || a.querySelector("img")?.alt || "").trim().slice(0, 120);
      const key = text + "|" + href;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ text, href });
      if (links.length >= 40) break;
    }

    const header = [`From: ${fromName}${fromEmail ? ` <${fromEmail}>` : ""}`, subject && `Subject: ${subject}`].filter(Boolean).join("\n");
    return { subject, fromName, fromEmail, body, links, truncated, text: `${header}\n\n${body}` };
  }

  async function updateBadge(email) {
    const subjectEl = document.querySelector("h2.hP");
    let badge = document.getElementById("smr-badge");
    if (!email || !subjectEl) return badge?.remove();

    rulesPromise ||= import(chrome.runtime.getURL("lib/rules.js"));
    const { analyze, verdictFor } = await rulesPromise;
    const r = analyze(email.text, { anchors: email.links });
    const verdict = verdictFor(r.score);
    const style = {
      scam: ["#e5383b", "🚨 Scam risk"],
      suspicious: ["#d97706", "⚠️ Suspicious"],
      probably_legit: ["#16a34a", "✅ Looks OK"],
    }[verdict];

    if (!badge || badge.parentElement !== subjectEl.parentElement) {
      badge?.remove();
      badge = document.createElement("button");
      badge.id = "smr-badge";
      badge.type = "button";
      badge.title = "Open Scam Message Roaster";
      badge.addEventListener("click", () => chrome.runtime.sendMessage({ type: "openPanel" }).catch(() => {}));
      subjectEl.insertAdjacentElement("afterend", badge);
    }
    Object.assign(badge.style, {
      marginLeft: "10px", padding: "3px 10px", borderRadius: "999px", border: `1px solid ${style[0]}`,
      background: `${style[0]}14`, color: style[0], font: "600 12px/1.6 system-ui, sans-serif",
      cursor: "pointer", verticalAlign: "middle", whiteSpace: "nowrap",
    });
    badge.textContent = `🔥 ${style[1]} · ${r.score}`;
  }

  // ---- Inbox list: tr.zA rows with sender (span[email]), subject (.bog) and preview (.y2). ----

  function extractInbox(includeHidden = false) {
    const rows = [...document.querySelectorAll("tr.zA")].filter((r) => includeHidden || visible(r));
    return rows.slice(0, 100).map((row) => {
      const senderEl = row.querySelector(".yW span[email], span[email]");
      const fromName = senderEl?.getAttribute("name") || senderEl?.innerText || "";
      const fromEmail = senderEl?.getAttribute("email") || "";
      const subject = (row.querySelector(".bog")?.innerText || "").trim();
      const snippet = (row.querySelector(".y2")?.innerText || "").replace(/^\s*[-–]\s*/, "").trim();
      const key = `${fromEmail}|${subject}|${snippet.slice(0, 40)}`;
      return {
        key, fromName, fromEmail, subject, snippet, unread: row.classList.contains("zE"),
        text: `From: ${fromName}${fromEmail ? ` <${fromEmail}>` : ""}\nSubject: ${subject}\n\n${snippet}`,
        row,
      };
    });
  }

  let showInboxPills = true;
  chrome.storage?.sync.get("inboxPills").then((v) => {
    showInboxPills = v.inboxPills ?? true;
    check();
  }).catch(() => {});
  chrome.storage?.onChanged?.addListener((changes) => {
    if ("inboxPills" in changes) {
      showInboxPills = changes.inboxPills.newValue ?? true;
      document.querySelectorAll(".smr-row").forEach((el) => el.remove());
      check();
    }
  });

  // Only risky rows get a pill, so a clean inbox stays clean.
  async function markInbox(items) {
    if (!showInboxPills || !items.length) return;
    rulesPromise ||= import(chrome.runtime.getURL("lib/rules.js"));
    const { analyze, verdictFor } = await rulesPromise;
    for (const it of items) {
      const r = analyze(it.text);
      const verdict = verdictFor(r.score);
      const subjectEl = it.row.querySelector(".bog");
      let pill = it.row.querySelector(".smr-row");
      if (verdict === "probably_legit" || !subjectEl) {
        pill?.remove();
        continue;
      }
      const label = `${verdict === "scam" ? "🚨" : "⚠️"} ${r.score}`;
      if (pill && pill.textContent === label) continue;
      pill ||= document.createElement("span");
      pill.className = "smr-row";
      pill.textContent = label;
      pill.title = `Scam Roaster: ${r.flags.slice(0, 3).map((f) => f.label).join(" · ")}`;
      const c = verdict === "scam" ? "#e5383b" : "#d97706";
      Object.assign(pill.style, {
        display: "inline-block", marginRight: "6px", padding: "0 6px", borderRadius: "999px",
        border: `1px solid ${c}`, color: c, background: `${c}14`, font: "600 11px/16px system-ui, sans-serif",
        verticalAlign: "1px",
      });
      if (!pill.isConnected) subjectEl.insertAdjacentElement("beforebegin", pill);
    }
  }

  function openRow(key) {
    const it = extractInbox(true).find((x) => x.key === key);
    if (!it) return false;
    (it.row.querySelector(".bog") || it.row).click();
    return true;
  }

  // ---- Bulk trash: tick the rows' own checkboxes, then press Gmail's Delete button. ----
  // Using Gmail's UI (not an API) means it's an ordinary delete: Undo toast, 30 days in Trash.

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function press(el) {
    for (const type of ["mousedown", "mouseup", "click"]) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  }

  const rowCheckbox = (row) => row.querySelector('[role="checkbox"]');
  const isChecked = (cb) => cb?.getAttribute("aria-checked") === "true";

  // Gmail folder from the URL: #inbox, #spam, #trash, #label/Work, #search/…
  function currentFolder() {
    return decodeURIComponent((location.hash.replace(/^#/, "").split("/")[0] || "inbox").split("?")[0]).toLowerCase();
  }
  // In Spam and Trash, Gmail's only delete is "Delete forever": no Undo, no 30-day Trash.
  const PERMANENT_DELETE_FOLDERS = new Set(["spam", "trash"]);

  function findDeleteButton() {
    const candidates = [
      ...document.querySelectorAll('[role="button"][act="10"]'),
      ...document.querySelectorAll('[role="button"][data-tooltip="Delete"], [role="button"][aria-label="Delete"]'),
    ];
    // Never press a permanent delete, whatever the folder detection says.
    const permanent = (el) => /forever/i.test(`${el.getAttribute("data-tooltip") || ""} ${el.getAttribute("aria-label") || ""} ${el.innerText || ""}`);
    return candidates.find((el) => visible(el) && !permanent(el)) || null;
  }

  async function trashRows(keys) {
    if (PERMANENT_DELETE_FOLDERS.has(currentFolder())) {
      return { ok: false, error: "Deleting from Spam or Trash is permanent in Gmail, so the roaster won't do it here." };
    }
    const want = new Set(keys);
    const rows = extractInbox();
    const targets = rows.filter((it) => want.has(it.key));
    if (targets.length !== want.size) return { ok: false, error: "Some emails are no longer on this page. Rescan and try again." };

    // Start from a clean selection so nothing the user had ticked gets trashed by accident.
    for (const it of rows) {
      const cb = rowCheckbox(it.row);
      if (isChecked(cb) && !want.has(it.key)) press(cb);
    }
    for (const it of targets) {
      const cb = rowCheckbox(it.row);
      if (!cb) return { ok: false, error: "Couldn't find Gmail's row checkboxes." };
      if (!isChecked(cb)) press(cb);
    }
    await wait(350);

    const checked = rows.filter((it) => isChecked(rowCheckbox(it.row)));
    const exact = checked.length === targets.length && checked.every((it) => want.has(it.key));
    const del = findDeleteButton();
    if (!exact || !del) {
      for (const it of checked) press(rowCheckbox(it.row));
      return { ok: false, error: !exact ? "Selection didn't match, so nothing was deleted." : "Couldn't find Gmail's Delete button, so nothing was deleted." };
    }
    press(del);
    return { ok: true, trashed: targets.length };
  }

  let lastInboxKey = "";

  function check() {
    let email = null;
    let inbox = [];
    try {
      email = extractEmail();
    } catch {}
    try {
      inbox = extractInbox();
    } catch {}
    const key = email ? `${email.fromEmail}|${email.subject}|${email.body.length}` : "";
    updateBadge(email).catch(() => {});
    markInbox(inbox).catch(() => {});
    const inboxKey = inbox.map((x) => x.key).join("\n");
    if (key !== lastKey || inboxKey !== lastInboxKey) {
      lastKey = key;
      lastInboxKey = inboxKey;
      chrome.runtime.sendMessage({ type: "emailChanged" }).catch(() => {});
    }
  }

  let timer = 0;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(check, 500);
  }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("hashchange", () => setTimeout(check, 300));
  check();

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === "getState") {
      const inbox = extractInbox().map(({ row, ...rest }) => rest);
      reply({ email: extractEmail(), inbox, folder: currentFolder() });
    } else if (msg?.type === "openRow") reply({ ok: openRow(msg.key) });
    else if (msg?.type === "trashRows") {
      trashRows(msg.keys || []).then(reply, (err) => reply({ ok: false, error: err.message }));
      return true; // async reply
    }
  });
})();
