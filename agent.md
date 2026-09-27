# AI Proxy on Cloudflare Workers

This repository contains a lightweight proxy that sits between clients (e.g., **Hermes Agent**) and several AI providers such as Cerebras, Groq, OpenRouter, and NVIDIA‑NIM. The proxy implements key features that simplify using and monitoring external APIs while keeping control over costs and rate limits.

## Feature Summary
| Feature | What it is | Why it matters |
|---------|------------|----------------|
| **Core architecture** | Cloudflare Workers + Durable Object | Workers deliver low‑latency, globally distributed execution; the Durable Object holds state (quotas, cooldowns) without race conditions. |
| **Automatic fallback** | Priority list (`AUTO_TARGETS`) in `src/config.ts` | Each request is tried sequentially. If a provider returns `429` or a server error, the request automatically falls back to the next provider+model pair. |
| **Quota tracking** | Stored in a SQLite‑backed Durable Object | Counts requests per minute, requests per day, and tokens per day per provider—so you can see real‑time usage and avoid exceeding your plan limits. |
| **Cooldown handling** | On a 429 response the provider is “paused” for the period specified by the `Retry‑After` header | Prevents repeatedly hammering a rate‑limited provider. |
| **Context filtering** | Each target has a `contextWindow`; oversized requests are automatically skipped | Avoids sending batches that are too large to be accepted by a provider. |
| **Streaming** | Responses are forwarded to clients token‑by‑token, with optional usage counting (`METER_STREAM_USAGE`) | Clients receive results quickly; when `METER_STREAM_USAGE` is enabled the proxy tallies the actual usage from the provider’s `usage` field. |
| **Configuration** | `src/config.ts` contains:  <br>• `PROVIDERS` – ID, base URL, secret name, limits, optional headers, and `streamUsage` flag. <br>• `AUTO_TARGETS` – Prioritized list of provider+model pairs (model names are provider‑specific). <br>• `METER_STREAM_USAGE` – Adjusts the CPU impact of usage counting. | You control all logic (available providers, limits, ordering) by editing this file. |
| **Endpoints** | <br>• `POST /v1/chat/completions` – Proxy the request to the chosen provider. <br>• `GET /v1/models` – Returns a single entry: `auto` (the proxy ignores the client‑supplied model). <br>• `GET /status` – Current quota usage per provider. <br>• `GET /health` – Performs a small health check against every target. <br>• `POST /admin/reset` – Reset counters for a provider or all providers. | Quick integration and real‑time monitoring. |
| **Deploy** | Uses `wrangler` (Cloudflare CLI). <br>Configure secrets (`PROXY_API_KEY`, provider API keys) with `wrangler secret put`. <br>Deploy with `pnpm run deploy`. | Seamless move from local development to global production. |
| **Usage** | Integrate with Hermes via a custom provider pointing to the proxy URL. <br>Clients send `Authorization: Bearer <key>` (same key used in the `PROXY_API_KEY` secret). <br>The client’s `model` field is ignored; the proxy follows the `AUTO_TARGETS` order. | Simplifies client configuration and centralizes rate‑limit & cost control. |
| **Important notes** | • No model choice from the client. <br>• Quota counts are internal, separated from the provider’s real usage. <br>• Token estimation is rough (1 token ≈ 4 characters) until the final usage is known. <br>• Daily reset at 00:00 UTC (may differ from providers). <br>• Fallback occurs only before streaming starts. <br>• 400/422 errors are not retried. <br>• Free‑plan CPU limits: disable stream usage counting if needed (`METER_STREAM_USAGE = false`). | Provides full visibility into how the proxy works and what edge cases to watch for. |

## Getting Started
1. **Install**
   ```bash
   pnpm install
   pnpm dlx wrangler login
   ```
2. **Edit `src/config.ts`** – configure providers, limits, and reorder `AUTO_TARGETS` as needed.
3. **Add secrets** (provider API keys and `PROXY_API_KEY`) via:
   ```bash
   pnpm dlx wrangler secret put <SECRET_NAME>
   ```
4. **Deploy**
   ```bash
   pnpm run deploy
   ```
5. **Connect the client** (e.g., Hermes) by pointing it to the proxy base URL and supplying the proxy API key.

The proxy acts as a safety net, automatically balancing traffic across providers, enforcing you‑defined limits, and offering a real‑time usage view. It’s ideal when you have multiple paid or free tiers and want to use the best capacity available at any moment.