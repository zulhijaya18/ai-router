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
  /** Diabaikan sepenuhnya oleh proxy. Target selalu ditentukan oleh AUTO_TARGETS di config.ts. */
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

// Status yang memicu pindah ke provider berikutnya.
// 400 dan 422 tidak termasuk karena biasanya kesalahan request itu sendiri.
const FALLBACK_STATUSES = new Set([401, 402, 403, 404, 408, 409, 413, 429]);

// ---------------------------------------------------------------------
// Helper
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

/** Estimasi kasar: 1 token ≈ 4 karakter. */
function estimateTokens(body: ChatBody): number {
  const promptChars = JSON.stringify([body.messages ?? [], body.tools ?? []]).length;
  const output = Number(body.max_tokens ?? body.max_completion_tokens ?? 1024);
  return Math.ceil(promptChars / 4) + output;
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
  if (res.status === 401 || res.status === 403) return 5 * 60_000; // key salah/diblokir
  if (res.status >= 500) return 30_000;
  return 0;
}

/** Baca stream SSE di background dan ambil total_tokens dari chunk terakhir. */
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
    // Stream putus (misalnya client disconnect). Pakai hasil sejauh ini.
  }
  return total;
}

// ---------------------------------------------------------------------
// Upstream
// ---------------------------------------------------------------------

async function callUpstream(
  provider: ProviderConfig,
  target: RouteTarget,
  body: ChatBody,
  env: Env,
): Promise<Response> {
  const upstreamBody: Record<string, unknown> = { ...body, model: target.model };
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
    // Response bukan JSON. Pakai estimasi.
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

/** Kirim request minimal (max_tokens: 1) ke setiap target di AUTO_TARGETS, paralel. */
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
        return { provider: target.provider, model: target.model, ok: false, error: "provider tidak terdaftar di PROVIDERS" };
      }
      if (!env[provider.apiKeySecret]) {
        return {
          provider: provider.id,
          model: target.model,
          ok: false,
          error: `secret ${provider.apiKeySecret} belum di-set`,
        };
      }

      const start = Date.now();
      try {
        const res = await callUpstream(provider, target, pingBody, env);
        const latencyMs = Date.now() - start;
        if (res.ok) {
          await res.text(); // drain body, isinya tidak dipakai
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
    return apiError("Body harus JSON yang valid.", 400, "invalid_request_error");
  }

  const est = estimateTokens(body);
  const quota = env.QUOTA.get(env.QUOTA.idFromName("global"));
  const tried = new Set<number>();
  const failures: string[] = [];
  // true kalau ada kegagalan yang bisa hilang dengan menunggu (limit, error server).
  let retryable = false;

  while (tried.size < AUTO_TARGETS.length) {
    const candidates: Candidate[] = [];

    AUTO_TARGETS.forEach((t, index) => {
      if (tried.has(index)) return;
      const provider = PROVIDER_MAP.get(t.provider);
      const label = `${t.provider}/${t.model}`;

      if (!provider) {
        tried.add(index);
        failures.push(`${label}: provider tidak terdaftar di PROVIDERS`);
      } else if (!env[provider.apiKeySecret]) {
        tried.add(index);
        failures.push(`${label}: secret ${provider.apiKeySecret} belum di-set`);
      } else if (t.contextWindow && est > t.contextWindow) {
        tried.add(index);
        failures.push(`${label}: context ${t.contextWindow} < estimasi ${est} token`);
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
      failures.push("provider tersisa sedang habis kuota atau cooldown");
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
      // 429 tetap dihitung sebagai request terpakai.
      await quota.fail(provider.id, est, res.status === 429, cooldownFor(res));
      failures.push(`${label}: HTTP ${res.status} ${text.slice(0, 200)}`);
      retryable = true;
      continue;
    }

    // 400/422: kembalikan apa adanya, jangan fallback.
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
    // Contoh: request terlalu besar untuk semua target. Menunggu tidak akan membantu.
    return apiError(`Tidak ada target yang cocok untuk request ini. Detail: ${detail}`, 400,
      "invalid_request_error");
  }
  return apiError(`Semua provider gagal atau habis kuota. Detail: ${detail}`, 429,
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
