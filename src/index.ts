import { QuotaTracker, type Candidate } from "./quota";
import {
  AUTO_TARGETS,
  METER_STREAM_USAGE,
  PROVIDERS,
  type ProviderConfig,
  type RouteTarget,
} from "./config";

export { QuotaTracker };

export interface Env {
  QUOTA: DurableObjectNamespace<QuotaTracker>;
  PROXY_API_KEY: string;
  [secret: string]: unknown;
}

interface ChatBody {
  /** Completely ignored by the proxy. The target is always chosen from AUTO_TARGETS in config.ts. */
  model?: string;
  messages?: unknown[];
  tools?: unknown[];
  stream?: boolean;
  stream_options?: Record<string, unknown>;
  max_tokens?: number;
  max_completion_tokens?: number;
  [key: string]: unknown;
}

type QuotaStub = DurableObjectStub<QuotaTracker>;

const PROVIDER_MAP = new Map(PROVIDERS.map((p) => [p.id, p]));
const TOTAL_TOKENS_RE = /"total_tokens"\s*:\s*(\d+)/;

// Statuses that trigger a move to the next provider.
// 400 and 422 are excluded because they're usually the request's own fault.
const FALLBACK_STATUSES = new Set([401, 402, 403, 404, 408, 409, 413, 429]);

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function apiError(
  message: string,
  status: number,
  type = "proxy_error",
  extraHeaders: Record<string, string> = {},
): Response {
  return json({ error: { message, type } }, status, extraHeaders);
}

function isAuthorized(req: Request, env: Env): boolean {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!env.PROXY_API_KEY || !token) return false;
  const enc = new TextEncoder();
  const a = enc.encode(token);
  const b = enc.encode(env.PROXY_API_KEY);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

// Flat per-item estimate for a non-text content part (image_url, file, ...).
// A base64 data URI can be hundreds of thousands of characters long, but its
// real token cost depends on the provider's own image tiling/resolution
// rules, not on the length of that string — counting it via chars/4 would
// wildly overestimate and make every target look "too large" to use.
const MULTIMODAL_PART_TOKEN_ESTIMATE = 1_500;

/** Rough estimate: 1 token ≈ 4 characters for text, flat estimate for images/files. */
function estimateTokens(body: ChatBody): number {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let promptTokens = 0;

  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const content = (m as Record<string, unknown>).content;

    if (typeof content === "string") {
      promptTokens += Math.ceil(content.length / 4);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (p.type === "text" && typeof p.text === "string") {
          promptTokens += Math.ceil(p.text.length / 4);
        } else {
          promptTokens += MULTIMODAL_PART_TOKEN_ESTIMATE;
        }
      }
    } else if (content != null) {
      promptTokens += Math.ceil(JSON.stringify(content).length / 4);
    }
  }

  promptTokens += Math.ceil(JSON.stringify(body.tools ?? []).length / 4);
  const output = Number(body.max_tokens ?? body.max_completion_tokens ?? 1024);
  return promptTokens + output;
}

/**
 * True if any message has a non-text content part (e.g. `image_url`,
 * `input_image`, `file`) — the OpenAI-style way of attaching an image or
 * document to a chat message.
 */
function hasMultimodalContent(messages: unknown[]): boolean {
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const content = (m as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const type = (part as Record<string, unknown>).type;
      if (typeof type === "string" && type !== "text") return true;
    }
  }
  return false;
}

function retryAfterMs(res: Response, fallbackMs: number): number {
  const value = res.headers.get("retry-after");
  if (!value) return fallbackMs;
  const secs = Number(value);
  if (!Number.isNaN(secs)) return Math.max(1_000, secs * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? fallbackMs : Math.max(1_000, date - Date.now());
}

function cooldownFor(res: Response): number {
  if (res.status === 429) return retryAfterMs(res, 60_000);
  if (res.status === 401 || res.status === 403) return 5 * 60_000; // bad/blocked key
  if (res.status >= 500) return 30_000;
  return 0;
}

/** Read the SSE stream in the background and grab total_tokens from the last chunk. */
async function readTotalTokens(stream: ReadableStream<Uint8Array>): Promise<number | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let total: number | null = null;

  const scan = (line: string) => {
    if (!line.includes('"total_tokens"')) return;
    const m = TOTAL_TOKENS_RE.exec(line);
    if (m) total = Number(m[1]);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        scan(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    scan(buffer);
  } catch {
    // Stream was cut off (e.g. client disconnected). Use what we have so far.
  }
  return total;
}

// ---------------------------------------------------------------------
// Upstream
// ---------------------------------------------------------------------

// Vendor-specific fields some reasoning models (gpt-oss, Nemotron, ...) attach
// to assistant messages in their response. Clients often echo these back in
// the next request's message history. Since a fallback can land on a
// different provider with a stricter schema that rejects unknown message
// properties, strip them before forwarding so every provider always sees
// plain OpenAI-shaped messages.
const NON_STANDARD_MESSAGE_FIELDS = ["reasoning_content", "reasoning"];

function sanitizeMessages(messages: unknown[]): unknown[] {
  return messages.map((m) => {
    if (!m || typeof m !== "object") return m;
    const clean = { ...(m as Record<string, unknown>) };
    for (const field of NON_STANDARD_MESSAGE_FIELDS) delete clean[field];
    return clean;
  });
}

async function callUpstream(
  provider: ProviderConfig,
  target: RouteTarget,
  body: ChatBody,
  env: Env,
): Promise<Response> {
  const upstreamBody: Record<string, unknown> = { ...body, model: target.model };
  if (Array.isArray(body.messages)) {
    upstreamBody.messages = sanitizeMessages(body.messages);
  }
  if (body.stream && provider.streamUsage !== false) {
    upstreamBody.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
  }

  return fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${String(env[provider.apiKeySecret])}`,
      "content-type": "application/json",
      ...(provider.headers ?? {}),
    },
    body: JSON.stringify(upstreamBody),
  });
}

async function forwardSuccess(
  res: Response,
  provider: ProviderConfig,
  target: RouteTarget,
  body: ChatBody,
  est: number,
  quota: QuotaStub,
  ctx: ExecutionContext,
): Promise<Response> {
  const headers = new Headers({
    "x-proxy-provider": provider.id,
    "x-proxy-model": target.model,
  });

  if (body.stream && res.body) {
    headers.set("content-type", res.headers.get("content-type") ?? "text/event-stream");
    headers.set("cache-control", "no-cache");

    if (!METER_STREAM_USAGE) {
      return new Response(res.body, { status: res.status, headers });
    }
    const [toClient, toMeter] = res.body.tee();
    ctx.waitUntil(
      readTotalTokens(toMeter).then((t) => quota.record(provider.id, t ?? est, est)),
    );
    return new Response(toClient, { status: res.status, headers });
  }

  const text = await res.text();
  let actual = est;
  try {
    const parsed = JSON.parse(text) as { usage?: { total_tokens?: number } };
    if (typeof parsed.usage?.total_tokens === "number") actual = parsed.usage.total_tokens;
  } catch {
    // Response isn't JSON. Use the estimate.
  }
  ctx.waitUntil(quota.record(provider.id, actual, est));
  headers.set("content-type", res.headers.get("content-type") ?? "application/json");
  return new Response(text, { status: res.status, headers });
}

// ---------------------------------------------------------------------
// Healthcheck
// ---------------------------------------------------------------------

interface HealthCheckResult {
  provider: string;
  model: string;
  ok: boolean;
  status?: number;
  latencyMs?: number;
  error?: string;
}

/** Send a minimal request (max_tokens: 1) to every target in AUTO_TARGETS, in parallel. */
async function healthcheck(env: Env): Promise<HealthCheckResult[]> {
  const pingBody: ChatBody = {
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
    stream: false,
  };

  return Promise.all(
    AUTO_TARGETS.map(async (target): Promise<HealthCheckResult> => {
      const provider = PROVIDER_MAP.get(target.provider);
      if (!provider) {
        return { provider: target.provider, model: target.model, ok: false, error: "provider not registered in PROVIDERS" };
      }
      if (!env[provider.apiKeySecret]) {
        return {
          provider: provider.id,
          model: target.model,
          ok: false,
          error: `secret ${provider.apiKeySecret} is not set`,
        };
      }

      const start = Date.now();
      try {
        const res = await callUpstream(provider, target, pingBody, env);
        const latencyMs = Date.now() - start;
        if (res.ok) {
          await res.text(); // drain the body, content is unused
          return { provider: provider.id, model: target.model, ok: true, status: res.status, latencyMs };
        }
        const text = await res.text();
        return {
          provider: provider.id,
          model: target.model,
          ok: false,
          status: res.status,
          latencyMs,
          error: text.slice(0, 200),
        };
      } catch (err) {
        return {
          provider: provider.id,
          model: target.model,
          ok: false,
          latencyMs: Date.now() - start,
          error: `network error ${String(err)}`,
        };
      }
    }),
  );
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------

async function handleChat(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: ChatBody;
  try {
    body = await req.json<ChatBody>();
  } catch {
    return apiError("Body must be valid JSON.", 400, "invalid_request_error");
  }

  const est = estimateTokens(body);
  const usesTools = Array.isArray(body.tools) && body.tools.length > 0;
  const usesImages = Array.isArray(body.messages) && hasMultimodalContent(body.messages);
  const quota = env.QUOTA.get(env.QUOTA.idFromName("global"));
  const tried = new Set<number>();
  const failures: string[] = [];
  // true if the failure could go away by waiting (rate limit, server error).
  let retryable = false;

  while (tried.size < AUTO_TARGETS.length) {
    const candidates: Candidate[] = [];

    AUTO_TARGETS.forEach((t, index) => {
      if (tried.has(index)) return;
      const provider = PROVIDER_MAP.get(t.provider);
      const label = `${t.provider}/${t.model}`;

      if (!provider) {
        tried.add(index);
        failures.push(`${label}: provider not registered in PROVIDERS`);
      } else if (!env[provider.apiKeySecret]) {
        tried.add(index);
        failures.push(`${label}: secret ${provider.apiKeySecret} is not set`);
      } else if (t.contextWindow && est > t.contextWindow) {
        tried.add(index);
        failures.push(`${label}: context ${t.contextWindow} < estimated ${est} tokens`);
      } else if (usesTools && t.supportsTools === false) {
        tried.add(index);
        failures.push(`${label}: does not reliably support tool calling`);
      } else if (usesImages && t.supportsImages === false) {
        tried.add(index);
        failures.push(`${label}: does not support image/document content`);
      } else {
        candidates.push({
          index,
          quotaKey: provider.id,
          limits: provider.limits ?? {},
        });
      }
    });

    if (candidates.length === 0) break;

    const picked = await quota.acquire(candidates, est);
    if (picked === null) {
      failures.push("remaining providers are out of quota or in cooldown");
      retryable = true;
      break;
    }
    tried.add(picked);

    const target = AUTO_TARGETS[picked];
    const provider = PROVIDER_MAP.get(target.provider)!;
    const label = `${provider.id}/${target.model}`;

    let res: Response;
    try {
      res = await callUpstream(provider, target, body, env);
    } catch (err) {
      await quota.fail(provider.id, est, false, 30_000);
      failures.push(`${label}: network error ${String(err)}`);
      retryable = true;
      continue;
    }

    if (res.ok) {
      return forwardSuccess(res, provider, target, body, est, quota, ctx);
    }

    const text = await res.text();

    if (res.status >= 500 || FALLBACK_STATUSES.has(res.status)) {
      // 429 still counts as a used request.
      await quota.fail(provider.id, est, res.status === 429, cooldownFor(res));
      failures.push(`${label}: HTTP ${res.status} ${text.slice(0, 200)}`);
      retryable = true;
      continue;
    }

    // 400/422: return as-is, don't fall back.
    await quota.fail(provider.id, est, false, 0);
    return new Response(text, {
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/json",
        "x-proxy-provider": provider.id,
      },
    });
  }

  const detail = failures.join(" | ");
  if (!retryable) {
    // Example: the request is too large for every target. Waiting won't help.
    return apiError(`No matching target for this request. Details: ${detail}`, 400,
      "invalid_request_error");
  }
  return apiError(`All providers failed or are out of quota. Details: ${detail}`, 429,
    "rate_limit_error", { "retry-after": "60" });
}

function listModels(): Response {
  return json({
    object: "list",
    data: [{ id: "auto", object: "model", owned_by: "ai-proxy" }],
  });
}

async function status(env: Env): Promise<Response> {
  const quota = env.QUOTA.get(env.QUOTA.idFromName("global"));
  const snap = await quota.snapshot(PROVIDERS.map((p) => p.id));
  const now = Date.now();
  return json(
    PROVIDERS.map((p) => {
      const c = snap[p.id];
      return {
        provider: p.id,
        limits: p.limits ?? {},
        today: { date: c.day, requests: c.requests, tokens: c.tokens },
        thisMinute: c.minuteRequests,
        cooldownSeconds: Math.max(0, Math.ceil((c.cooldownUntil - now) / 1000)),
      };
    }),
  );
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (!isAuthorized(req, env)) {
      return apiError("Unauthorized", 401, "authentication_error");
    }

    if (req.method === "POST" && pathname === "/v1/chat/completions") {
      return handleChat(req, env, ctx);
    }
    if (req.method === "GET" && pathname === "/v1/models") {
      return listModels();
    }
    if (req.method === "GET" && pathname === "/status") {
      return status(env);
    }
    if (req.method === "GET" && pathname === "/health") {
      const checks = await healthcheck(env);
      const ok = checks.every((c) => c.ok);
      return json({ ok, checks }, ok ? 200 : 503);
    }
    if (req.method === "POST" && pathname === "/admin/reset") {
      const key = new URL(req.url).searchParams.get("provider") ?? undefined;
      await env.QUOTA.get(env.QUOTA.idFromName("global")).reset(key);
      return json({ ok: true, reset: key ?? "all" });
    }

    return apiError("Not found", 404, "invalid_request_error");
  },
} satisfies ExportedHandler<Env>;
