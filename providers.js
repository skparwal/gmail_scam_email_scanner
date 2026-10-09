// One "give me JSON matching this schema" call, implemented per AI provider.
// Claude goes through the Anthropic SDK; OpenAI and Gemini through their REST APIs.

import Anthropic from "@anthropic-ai/sdk";

const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const GEMINI_BASE = (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");

let anthropic = null;
try {
  anthropic = new Anthropic();
} catch {
  anthropic = null;
}

export class ProviderError extends Error {
  constructor(message, { status = 0, auth = false } = {}) {
    super(message);
    this.status = status;
    this.auth = auth;
  }
}

// ---- Claude ----

async function claudeJSON({ system, user, schema, maxTokens }) {
  let response;
  try {
    response = await anthropic.beta.messages.create({
      model: PROVIDERS.claude.model,
      max_tokens: maxTokens,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema } },
      system,
      messages: [{ role: "user", content: user }],
    });
  } catch (err) {
    const auth = err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError;
    throw new ProviderError(err.message, { status: err.status || 0, auth });
  }
  if (response.stop_reason === "refusal") throw new ProviderError("Claude declined this request");
  if (response.stop_reason === "max_tokens") throw new ProviderError("Claude's answer was cut off");
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new ProviderError("Claude returned no text");
  return text;
}

async function claudeProbe() {
  if (!anthropic) throw new ProviderError("no credentials", { auth: true });
  try {
    await anthropic.models.retrieve(PROVIDERS.claude.model);
  } catch (err) {
    if (err instanceof Anthropic.APIError && !(err instanceof Anthropic.AuthenticationError) && !(err instanceof Anthropic.PermissionDeniedError)) return;
    throw new ProviderError(err.message.split(".")[0], { auth: true });
  }
}

// ---- OpenAI (Chat Completions with strict JSON schema) ----

async function openaiFetch(path, init = {}) {
  const res = await fetch(`${OPENAI_BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${OPENAI_KEY}`, "content-type": "application/json", ...init.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ProviderError(data?.error?.message || `OpenAI HTTP ${res.status}`, { status: res.status, auth: res.status === 401 || res.status === 403 });
  }
  return data;
}

async function openaiJSON({ system, user, schema, name, maxTokens }) {
  const data = await openaiFetch("/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: PROVIDERS.openai.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_schema", json_schema: { name, strict: true, schema } },
      // Reasoning models spend part of this on thinking, so leave plenty of room.
      max_completion_tokens: maxTokens * 2,
    }),
  });
  const choice = data.choices?.[0];
  if (choice?.message?.refusal) throw new ProviderError("ChatGPT declined this request");
  if (choice?.finish_reason === "length") throw new ProviderError("ChatGPT's answer was cut off");
  if (!choice?.message?.content) throw new ProviderError("ChatGPT returned no text");
  return choice.message.content;
}

async function openaiProbe() {
  if (!OPENAI_KEY) throw new ProviderError("no OPENAI_API_KEY", { auth: true });
  await openaiFetch(`/models/${encodeURIComponent(PROVIDERS.openai.model)}`);
}

// ---- Gemini (generateContent with a response schema) ----

// Gemini's responseSchema is an OpenAPI subset: uppercase types, no additionalProperties.
function toGeminiSchema(s) {
  const out = { type: s.type.toUpperCase() };
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.items) out.items = toGeminiSchema(s.items);
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    out.propertyOrdering = Object.keys(s.properties);
  }
  if (s.required) out.required = s.required;
  return out;
}

async function geminiFetch(path, init = {}) {
  const res = await fetch(`${GEMINI_BASE}${path}`, {
    ...init,
    headers: { "x-goog-api-key": GEMINI_KEY, "content-type": "application/json", ...init.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const auth = res.status === 401 || res.status === 403 || /API key/i.test(data?.error?.message || "");
    throw new ProviderError(data?.error?.message || `Gemini HTTP ${res.status}`, { status: res.status, auth });
  }
  return data;
}

async function geminiJSON({ system, user, schema, maxTokens }) {
  const data = await geminiFetch(`/models/${encodeURIComponent(PROVIDERS.gemini.model)}:generateContent`, {
    method: "POST",
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(schema),
        maxOutputTokens: maxTokens * 2,
      },
    }),
  });
  if (data.promptFeedback?.blockReason) throw new ProviderError(`Gemini blocked this request (${data.promptFeedback.blockReason})`);
  const cand = data.candidates?.[0];
  if (cand?.finishReason === "MAX_TOKENS") throw new ProviderError("Gemini's answer was cut off");
  const text = (cand?.content?.parts || []).filter((p) => !p.thought && p.text).map((p) => p.text).join("");
  if (!text) throw new ProviderError(`Gemini returned no text${cand?.finishReason ? ` (${cand.finishReason})` : ""}`);
  return text;
}

async function geminiProbe() {
  if (!GEMINI_KEY) throw new ProviderError("no GEMINI_API_KEY", { auth: true });
  await geminiFetch(`/models/${encodeURIComponent(PROVIDERS.gemini.model)}`);
}

// ---- Registry ----

export const PROVIDERS = {
  claude: { label: "Claude", model: "claude-opus-5-5", generate: claudeJSON, probe: claudeProbe, available: false },
  openai: { label: "ChatGPT", model: process.env.OPENAI_MODEL || "gpt-5-mini", generate: openaiJSON, probe: openaiProbe, available: false },
  gemini: { label: "Gemini", model: process.env.GEMINI_MODEL || "gemini-2.5-flash", generate: geminiJSON, probe: geminiProbe, available: false },
};

export async function probeAll() {
  await Promise.all(
    Object.entries(PROVIDERS).map(async ([id, p]) => {
      try {
        await p.probe();
        p.available = true;
        console.log(`✅ ${p.label} (${p.model}) ready`);
      } catch (err) {
        p.available = false;
        p.reason = err.message;
        console.log(`– ${p.label} off: ${err.message}`);
      }
    }),
  );
}

export function disable(id, reason) {
  const p = PROVIDERS[id];
  if (!p?.available) return;
  p.available = false;
  p.reason = reason;
  console.warn(`${p.label} disabled (${reason}).`);
}

// "none" means rules only. Unknown or unavailable choices fall back to the default.
export function pickProvider(requested) {
  if (requested === "none") return null;
  if (PROVIDERS[requested]?.available) return requested;
  const preferred = process.env.AI_PROVIDER;
  if (PROVIDERS[preferred]?.available) return preferred;
  return Object.keys(PROVIDERS).find((id) => PROVIDERS[id].available) || null;
}

export function providerList() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, model: p.model, available: p.available }));
}

export async function generateJSON(id, args) {
  try {
    return JSON.parse(await PROVIDERS[id].generate(args));
  } catch (err) {
    if (err instanceof ProviderError && err.auth) disable(id, "authentication failed");
    throw err;
  }
}
