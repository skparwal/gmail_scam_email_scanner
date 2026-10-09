// Deterministic red-flag detector. Runs in both the browser (instant highlights)
// and the server (a score the LLM can't be talked out of by the message itself).

const SHORTENERS = new Set([
  "bit.ly", "tinyurl.com", "t.co", "goo.gl", "is.gd", "cutt.ly", "rb.gy", "ow.ly",
  "buff.ly", "shorturl.at", "tiny.cc", "rebrand.ly", "t.ly", "s.id", "v.gd",
]);

const SKETCHY_TLDS = new Set([
  "xyz", "top", "click", "icu", "zip", "mov", "live", "rest", "cam", "support",
  "buzz", "monster", "cfd", "sbs", "quest", "gq", "tk", "ml", "cf", "ga", "work", "info",
]);

// Brand -> domains it actually sends from. A brand mention plus a link elsewhere is a classic tell.
const BRANDS = {
  paypal: ["paypal.com"],
  amazon: ["amazon.com", "amazon.ca", "amazon.co.uk", "amzn.to"],
  apple: ["apple.com", "icloud.com"],
  netflix: ["netflix.com"],
  usps: ["usps.com"],
  fedex: ["fedex.com"],
  dhl: ["dhl.com"],
  ups: ["ups.com"],
  irs: ["irs.gov"],
  cra: ["canada.ca", "cra-arc.gc.ca"],
  "canada post": ["canadapost.ca", "canadapost-postescanada.ca"],
  interac: ["interac.ca"],
  microsoft: ["microsoft.com", "live.com", "office.com", "outlook.com"],
  chase: ["chase.com"],
  "wells fargo": ["wellsfargo.com"],
  "bank of america": ["bankofamerica.com"],
  coinbase: ["coinbase.com"],
  google: ["google.com"],
  facebook: ["facebook.com", "meta.com"],
  instagram: ["instagram.com"],
};

const FREE_MAIL = ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com", "proton.me", "protonmail.com", "icloud.com"];

// Each pattern rule: weight is roughly "probability this alone means scam".
const PATTERN_RULES = [
  {
    id: "urgency", label: "Manufactured urgency", weight: 0.22,
    re: /\b(urgent(ly)?|immediately|act now|right away|asap|final (notice|warning|reminder)|last chance|expires? (today|soon|in \d+)|within (24|48|12|2) ?(hours|hrs|h)\b|before it'?s too late|time[- ]sensitive)\b/gi,
    why: "Scammers rush you so you don't stop to think. Real companies rarely give you a 24-hour ultimatum by text.",
  },
  {
    id: "threat", label: "Threats & consequences", weight: 0.28,
    re: /\b(account (has been |will be |is )?(suspended|locked|closed|disabled|terminated|restricted|on hold)|legal action|arrest(ed)?|warrant|lawsuit|police|penalt(y|ies)|unusual (sign-?in|activity|login)|security alert|compromised)\b/gi,
    why: "Fear is the oldest lever there is. A threat plus a link is phishing's signature move.",
  },
  {
    id: "credentials", label: "Asks for secrets", weight: 0.4,
    re: /\b(verify your (account|identity|details|information)|confirm your (password|account|details|identity|card)|update your (payment|billing|account) (info(rmation)?|details|method)|(enter|provide|send|share)( us)? your (password|pin|ssn|sin|social security|card (number|details)|cvv|login)|one[- ]time (code|password|passcode)|\botp\b|verification code|security code)\b/gi,
    why: "No legitimate company asks for your password, PIN, or one-time code over SMS or email. Ever.",
  },
  {
    id: "weird_payment", label: "Untraceable payment method", weight: 0.42,
    re: /\b(gift ?cards?|itunes card|google play card|steam card|bitcoin|btc|crypto(currency)?|usdt|wire transfer|western union|moneygram|zelle|cash ?app|venmo)\b/gi,
    why: "Gift cards, crypto, and wires are irreversible. That's exactly why scammers love them.",
  },
  {
    id: "prize", label: "Too good to be true", weight: 0.3,
    re: /\b(you('ve| have)? (won|been selected)|congratulations|claim your (prize|reward|gift|refund)|lottery|jackpot|free (gift|iphone|vacation|money)|winner|cash prize|\$\d[\d,]* (reward|prize))\b/gi,
    why: "You didn't enter a contest. You didn't win one either.",
  },
  {
    id: "delivery", label: "Fake delivery problem", weight: 0.22,
    re: /\b(package|parcel|shipment|delivery)( \w+){0,3} (failed|on hold|held|pending|undeliverable|could not be delivered|unsuccessful)|(redelivery|customs|shipping) fee|incomplete (address|shipping)\b/gi,
    why: "The 'your package is stuck, pay $1.99' text is one of the most common smishing campaigns going.",
  },
  {
    id: "refund", label: "Surprise refund / tax bait", weight: 0.25,
    re: /\b(tax refund|eligible for (a )?refund|overpaid|refund (is )?(pending|waiting|available)|stimulus|rebate)\b/gi,
    why: "Tax agencies don't text you about refunds with a link to click.",
  },
  {
    id: "generic_greeting", label: "Generic greeting", weight: 0.12,
    re: /\b(dear (customer|user|client|member|account holder|sir\/madam|sir or madam|valued \w+)|hello (customer|user)|valued (customer|member))\b/gi,
    why: "Your bank knows your name. 'Dear Customer' means they don't.",
  },
  {
    id: "family_new_number", label: "\"New number\" family scam", weight: 0.35,
    re: /\b(hi (mum|mom|dad)|this is my new number|lost my phone|new phone|broke my phone|can'?t (talk|call) right now)\b/gi,
    why: "The 'Hi Mum, new number' scam ends with an urgent request for money. Call the old number.",
  },
  {
    id: "job", label: "Easy-money job offer", weight: 0.3,
    re: /\b(work from home|earn \$?\d[\d,]* ?(\/|per|a) ?(day|hour|week)|part[- ]time (job|position)|no experience (needed|required)|recruit(er|ing) .{0,20}whatsapp|task-based)\b/gi,
    why: "Jobs that find you by text and pay $500/day for liking videos are the 'task scam'. It ends with you paying them.",
  },
  {
    id: "off_channel", label: "Move to another app", weight: 0.2,
    re: /\b(whatsapp|telegram|signal|text me at|contact (us|me) on)\b/gi,
    why: "Pushing you onto WhatsApp or Telegram moves you away from the platform's scam filters.",
  },
  {
    id: "callback", label: "Call this number now", weight: 0.18,
    re: /\b(call (us |this number |now |immediately )?(at|on)?:? ?\+?\(?\d[\d\s().-]{7,}\d)/gi,
    why: "Callback numbers in scam messages go straight to the scammer's 'support team'. Use the number on the back of your card.",
  },
  {
    id: "risky_attachment", label: "Risky attachment", weight: 0.3,
    re: /\b[\w-]+\.(zip|exe|scr|iso|img|html?|js|vbs|bat|cmd|msi|docm|xlsm)\b/gi,
    why: "Attachments like .zip, .html and .exe are how malware gets in. Invoices don't arrive as .html files.",
  },
  {
    id: "shouting", label: "SHOUTING & !!!", weight: 0.08,
    re: /(\b[A-Z]{4,}(?:\s+[A-Z]{3,}){2,}\b|!{2,})/g,
    why: "Professional companies don't write like a hostage note.",
  },
];

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"']+|(?:[a-z0-9-]+\.)+(?:com|net|org|co|io|info|xyz|top|click|icu|zip|mov|live|rest|cam|support|buzz|ly|me|ca|uk|us|gov|biz|online|site|shop|app|link)(?:\/[^\s<>"']*)?)/gi;

function hostOf(raw) {
  let s = raw.replace(/[),.;!?]+$/, "");
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  try {
    const u = new URL(s);
    return { host: u.hostname.toLowerCase(), url: u, cleaned: s, hasAt: /^https?:\/\/[^/]*@/i.test(s) };
  } catch {
    return null;
  }
}

function registrable(host) {
  const parts = host.split(".");
  // Good enough for co.uk-style suffixes we care about.
  if (parts.length >= 3 && /^(co|com|org|gov|net)$/.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

function domainMatches(host, domains) {
  return domains.some((d) => host === d || host.endsWith("." + d));
}

// Swap common lookalike characters so "paypa1" and "amaz0n" read as the brand they pretend to be.
function deLeet(s) {
  return s.replace(/0/g, "o").replace(/1/g, "l").replace(/3/g, "e").replace(/5/g, "s").replace(/rn/g, "m").replace(/vv/g, "w");
}

function analyzeLink(raw, index, brandsMentioned) {
  const parsed = hostOf(raw);
  if (!parsed) return [];
  const { host, url, hasAt } = parsed;
  const span = { start: index, end: index + raw.replace(/[),.;!?]+$/, "").length };
  const out = [];
  const add = (id, label, weight, why) => out.push({ id, label, weight, why, spans: [span], detail: host });

  const tld = host.split(".").pop();
  const reg = registrable(host);

  if (SHORTENERS.has(host)) add("shortener", "Link shortener hides destination", 0.25, `${host} hides where the link really goes. Legit alerts link to the company's own domain.`);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) add("ip_link", "Link to a raw IP address", 0.4, "Real companies use domain names, not bare IP addresses.");
  if (host.includes("xn--")) add("punycode", "Punycode lookalike domain", 0.4, "This domain uses encoded characters that can impersonate a real brand letter-for-letter.");
  if (SKETCHY_TLDS.has(tld)) add("sketchy_tld", `Cheap throwaway domain (.${tld})`, 0.25, `.${tld} domains cost pennies and are heavily used for phishing campaigns.`);
  if (hasAt) add("at_in_url", "Deceptive @ in URL", 0.35, "Everything before the @ in a URL is ignored. It's there to fool you.");
  if (/^http:\/\//i.test(raw)) add("no_https", "Unencrypted http:// link", 0.08, "No HTTPS. Not proof of a scam, but no bank sends you there.");
  if ((reg.split(".")[0].match(/-/g) || []).length >= 2 || host.split(".").length >= 5) {
    add("messy_domain", "Hyphen soup / deep subdomains", 0.2, `"${host}" is built to look official at a glance. Read it right-to-left: the real owner is ${reg}.`);
  }

  // Brand impersonation: brand name lives in the host but the registrable domain isn't theirs.
  const normalized = deLeet(host.replace(/[-.]/g, ""));
  for (const [brand, domains] of Object.entries(BRANDS)) {
    const key = brand.replace(/\s/g, "");
    if (key.length < 3) continue;
    if (domainMatches(host, domains)) continue;
    if (normalized.includes(key)) {
      add("lookalike", `Fake ${titleCase(brand)} domain`, 0.45, `"${host}" uses the ${titleCase(brand)} name but is owned by ${reg}, not ${domains[0]}.`);
      break;
    }
  }
  // Message talks about a brand but links somewhere unrelated.
  if (!out.some((f) => f.id === "lookalike")) {
    for (const brand of brandsMentioned) {
      if (!domainMatches(host, BRANDS[brand]) && !SHORTENERS.has(host)) {
        add("brand_mismatch", `Says ${titleCase(brand)}, links elsewhere`, 0.35, `The message claims to be ${titleCase(brand)} but the link goes to ${reg}.`);
        break;
      }
    }
  }
  const official = Object.values(BRANDS).some((d) => domainMatches(host, d));
  if (!official && !out.length && url.pathname.length > 1 && /(login|signin|verify|secure|account|update|confirm|unlock|wallet)/i.test(url.pathname + url.search)) {
    add("login_path", "Link straight to a 'login' page", 0.12, "Links that drop you on a login or verify page are how credentials get harvested.");
  }
  return out;
}

const DISPLAY = { paypal: "PayPal", fedex: "FedEx", coinbase: "Coinbase" };

function looksLikeBrand(host) {
  const n = deLeet(host.toLowerCase().replace(/[-.]/g, ""));
  return Object.keys(BRANDS).some((b) => b.length >= 3 && n.includes(b.replace(/\s/g, "")));
}

function titleCase(s) {
  if (DISPLAY[s]) return DISPLAY[s];
  return s.length <= 4 ? s.toUpperCase() : s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function analyze(text, opts = {}) {
  const findings = [];
  const lower = text.toLowerCase();

  for (const rule of PATTERN_RULES) {
    const spans = [];
    for (const m of text.matchAll(rule.re)) {
      if (m[0].trim()) spans.push({ start: m.index, end: m.index + m[0].length });
    }
    if (spans.length) findings.push({ id: rule.id, label: rule.label, weight: rule.weight, why: rule.why, spans });
  }

  const brandsMentioned = Object.keys(BRANDS).filter((b) => new RegExp(`\\b${b}\\b`, "i").test(lower));

  // Sender spoofing: "From: PayPal <service@paypa1-help.com>" or a brand writing from Gmail.
  // A sender on the brand's real domain also tells us its tracking/CDN links are expected.
  let senderOfficial = false;
  const fromLine = text.match(/^\s*from:\s*(.+)$/im);
  if (fromLine) {
    const em = fromLine[1].match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
    if (em) {
      const host = em[1].toLowerCase();
      senderOfficial = Object.values(BRANDS).some((d) => domainMatches(host, d));
      const fromIdx = text.indexOf(fromLine[0]);
      const span = { start: fromIdx, end: fromIdx + fromLine[0].length };
      const claimed = Object.keys(BRANDS).find((b) => new RegExp(`\\b${b}\\b`, "i").test(fromLine[1].replace(em[0], "")) || new RegExp(`\\b${b}\\b`, "i").test(lower));
      if (claimed && !domainMatches(host, BRANDS[claimed])) {
        const free = FREE_MAIL.includes(host);
        findings.push({
          id: "sender_spoof", label: free ? `${titleCase(claimed)} emailing from ${host}?` : "Sender domain doesn't match brand",
          weight: free ? 0.45 : 0.38, spans: [span], detail: host,
          why: free
            ? `Big companies don't send official mail from free ${host} accounts.`
            : `The sender's domain is ${host}, not ${BRANDS[claimed][0]}. Display names are free to fake.`,
        });
      }
    }
  }
  const linkBrands = senderOfficial ? [] : brandsMentioned;

  const links = [];
  for (const m of text.matchAll(URL_RE)) {
    // Skip the domain half of an email address.
    if (text[m.index - 1] === "@") continue;
    links.push(m[0]);
    findings.push(...analyzeLink(m[0], m.index, linkBrands));
  }

  // Email anchors: the visible text and the real href can disagree, which plain text never shows.
  for (const a of (opts.anchors || []).slice(0, 40)) {
    const href = String(a.href || "");
    if (!/^https?:\/\//i.test(href)) continue;
    const label = String(a.text || "").trim();
    const at = label ? text.indexOf(label) : -1;
    const where = at >= 0 ? at : 0;
    const target = hostOf(href);
    if (!target) continue;
    links.push(href);
    for (const f of analyzeLink(href, where, linkBrands)) {
      if (at < 0) f.spans = [];
      else f.spans = [{ start: at, end: at + label.length }];
      f.why += ` (Link: "${label.slice(0, 40) || "button"}")`;
      findings.push(f);
    }
    const shown = label.match(/^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[\/?#]\S*)?$/i);
    if (shown && registrable(shown[1].toLowerCase()) !== registrable(target.host) && !(senderOfficial && !looksLikeBrand(shown[1]))) {
      findings.push({
        id: "link_text_lies", label: "Link text lies about its destination", weight: 0.45,
        spans: at >= 0 ? [{ start: at, end: at + label.length }] : [], detail: target.host,
        why: `The link says "${shown[1]}" but actually goes to ${target.host}. Hover before you click: the status bar shows the truth.`,
      });
    }
  }

  // Merge duplicate ids (e.g. several sketchy links) into one finding with multiple spans.
  const merged = new Map();
  for (const f of findings) {
    const prev = merged.get(f.id);
    if (prev) {
      prev.spans.push(...f.spans);
      prev.weight = Math.max(prev.weight, f.weight);
    } else merged.set(f.id, { ...f, spans: [...f.spans] });
  }
  const flags = [...merged.values()].sort((a, b) => b.weight - a.weight);

  // Noisy-OR: independent signals compound, but the score saturates instead of overflowing.
  let clean = 1;
  for (const f of flags) clean *= 1 - f.weight;
  // Pressure + a way to act on it (link/payment/credentials) is the core scam shape.
  const pressure = flags.some((f) => ["urgency", "threat", "prize", "refund", "delivery"].includes(f.id));
  const action = links.length > 0 || flags.some((f) => ["credentials", "weird_payment", "callback", "off_channel"].includes(f.id));
  if (pressure && action) clean *= 0.75;
  const score = Math.round((1 - clean) * 100);

  return { score, flags, links, brandsMentioned };
}

export function verdictFor(score) {
  if (score >= 70) return "scam";
  if (score >= 35) return "suspicious";
  return "probably_legit";
}
