# AI Proxy on Cloudflare Workers

An OpenAI-compatible proxy for Hermes Agent or other AI applications.
Flow: Hermes → this proxy → provider (Cerebras, Groq, OpenRouter, etc).

## Features

- **Automatic fallback (priority list).** Every request is always tried in the order of `AUTO_TARGETS` in `config.ts`. If a provider replies with 429 or a server error, the request moves to the next provider+model pair in the list.
- **Quota tracking.** The proxy counts requests per minute, requests per day, and tokens per day.
- **Cooldown.** A provider that hits 429 is rested according to the `Retry-After` header.
- **Context filtering.** Requests too large for a given model are automatically skipped.
- **Streaming.** The model's answer is forwarded straight to the client, token by token.

Quota tracking uses a **Durable Object**.
A Durable Object is Cloudflare's small storage primitive that processes data one call at a time.
So counters never race even under many concurrent requests.

## File structure

```
src/config.ts   ← what you need to edit: providers, limits, model priority list
src/index.ts    ← proxy logic
src/quota.ts    ← quota counter (Durable Object)
wrangler.jsonc  ← deploy configuration
```

## 1. Install

```bash
pnpm install
pnpm dlx wrangler login
```

## 2. Configure providers and the priority list

Open `src/config.ts`.

In `PROVIDERS`, fill in each provider:
- `baseUrl` must stop at `/v1`.
- `apiKeySecret` is the name of the secret holding the API key.
- `limits` should match your account's own limits.

In `AUTO_TARGETS`, build a list of provider+model pairs, ordered from most
to least preferred. The proxy always tries them from the top, moving down
whenever a target above fails, hits a limit, or is in cooldown.

Double-check model names in each provider's docs. Model names change often.

**The client's `model` field is completely ignored.** The client doesn't
choose the model or provider — the proxy decides via `AUTO_TARGETS`. There's
no more concept of multiple named routes or a `balance` strategy; just one
priority list that's always used.

## 3. Store secrets

```bash
pnpm dlx wrangler secret put PROXY_API_KEY
pnpm dlx wrangler secret put CEREBRAS_API_KEY
pnpm dlx wrangler secret put GROQ_API_KEY
pnpm dlx wrangler secret put OPENROUTER_API_KEY
pnpm dlx wrangler secret put NVIDIA_NIM_API_KEY
```

`PROXY_API_KEY` is your own proxy's key.
Fill it with a long random string, e.g. the output of `openssl rand -hex 32`.
Without this key, every request is rejected.

## 4. Deploy

```bash
pnpm run deploy
```

Wrangler will print a URL like `https://ai-proxy.<subdomain>.workers.dev`.

## 5. Connect to Hermes

Add to `~/.hermes/config.yaml`:

```yaml
custom_providers:
  - name: my-proxy
    base_url: https://ai-proxy.<subdomain>.workers.dev/v1
    key_env: MY_PROXY_KEY
    api_mode: chat_completions

model:
  provider: custom
  default: custom:my-proxy:auto
```

The model name on the `default` line (`auto`) is just the format Hermes
requires — the proxy doesn't read its value at all. The model and provider
actually used are always determined by the order of `AUTO_TARGETS` in
`config.ts`.

Then store the key in `~/.hermes/.env`:

```bash
echo 'MY_PROXY_KEY=same-value-as-PROXY_API_KEY' >> ~/.hermes/.env
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/chat/completions` | Chat, OpenAI format |
| GET | `/v1/models` | Always replies with a single entry: `auto` |
| GET | `/status` | Today's quota usage per provider |
| GET | `/health` | Real connectivity test against every provider+model in `AUTO_TARGETS` |
| POST | `/admin/reset?provider=cerebras` | Reset one provider's counter (no query = all) |

Every endpoint requires the `Authorization: Bearer <PROXY_API_KEY>` header.

Check quota:

```bash
curl https://ai-proxy.<subdomain>.workers.dev/status \
  -H "Authorization: Bearer $MY_PROXY_KEY"
```

Check connectivity to every provider/model in `AUTO_TARGETS`
(sends a real request with `max_tokens: 1` to each target):

```bash
curl https://ai-proxy.<subdomain>.workers.dev/health \
  -H "Authorization: Bearer $MY_PROXY_KEY"
```

Example result:

```json
{
  "ok": false,
  "checks": [
    { "provider": "cerebras", "model": "gpt-oss-120b", "ok": true, "status": 200, "latencyMs": 312 },
    { "provider": "openrouter", "model": "nvidia/nemotron-3-ultra-550b-a55b:free", "ok": true, "status": 200, "latencyMs": 900 },
    { "provider": "nvidia-nim", "model": "openai/gpt-oss-20b", "ok": false, "error": "secret NVIDIA_NIM_API_KEY is not set" }
  ]
}
```

The HTTP response is `200` when every target is `ok`, `503` if any of them fail.

Every successful response carries `x-proxy-provider` and `x-proxy-model` headers.
These headers show which provider actually answered.

## Local development

```bash
cp .dev.vars.example .dev.vars   # then fill in the values
pnpm run dev
```

## Important notes

- **No model choice from the client.** The `model` field in the request is always ignored. To add/change/reorder the models used, edit `AUTO_TARGETS` in `config.ts`.
- **Quota is the proxy's own count, not the provider's real data.** If you use the same account outside this proxy, the counts won't be in sync. Cooldown from 429s still acts as a safety net.
- **Token estimation is rough.** The proxy uses the rule of thumb 1 token ≈ 4 characters to pick a provider. Once the response finishes, the number is replaced with the real token count from the `usage` field.
- **Daily reset follows 00:00 UTC.** Some providers may use a different reset time.
- **Fallback only happens before the answer starts streaming.** If the stream has already started and the provider drops, the proxy can't silently switch.
- **400 and 422 errors are not retried.** These are usually the request's own fault, so other providers would reject it too.
- **Context window per target.** Each target in `AUTO_TARGETS` has its own `contextWindow`; requests too large for a given target are automatically skipped in favor of the next one.
- **Tool calling per target.** A target can be marked `supportsTools: false` in `AUTO_TARGETS` for models known to be unreliable with function/tool calling (e.g. gpt-oss's Harmony-format tool calls currently leaking or crashing on some backends). Any request with a non-empty `tools` array skips those targets entirely and only considers the ones that support it.
- **Assistant message sanitization.** Vendor-specific fields some reasoning models attach to assistant messages (`reasoning_content`, `reasoning`) are stripped from the conversation history before forwarding, since a fallback can land on a different provider whose stricter schema rejects unknown message properties.
- **Free-plan CPU limit.** The Workers free plan has a small CPU time budget. Waiting on a provider doesn't count against it, but reading the stream to count tokens does. If you hit an "Exceeded CPU" error, set `METER_STREAM_USAGE = false` in `config.ts`.
- **Durable Object on the free plan.** This project uses a SQLite-backed Durable Object. If deployment is rejected because of your plan, check your Cloudflare account settings.
- **Terms of service.** Spreading requests across different providers is fine. Creating multiple accounts on the same provider to multiply free quotas usually violates that provider's terms.
