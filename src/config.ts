// =====================================================================
// PROXY CONFIGURATION
// Edit this file to add providers, limits, and model targets.
// =====================================================================

export interface Limits {
  /** Requests per minute */
  rpm?: number;
  /** Requests per day (resets at 00:00 UTC) */
  rpd?: number;
  /** Tokens per day (resets at 00:00 UTC) */
  tpd?: number;
}

export interface ProviderConfig {
  /** Unique provider ID. Quota is tracked per this ID. */
  id: string;
  /** OpenAI-compatible base URL, stops at /v1 (without /chat/completions) */
  baseUrl: string;
  /** Name of the Cloudflare secret holding this provider's API key */
  apiKeySecret: string;
  /** Your account's limits for this provider. Leave empty if unlimited. */
  limits?: Limits;
  /** Extra headers (optional) */
  headers?: Record<string, string>;
  /**
   * Send stream_options.include_usage while streaming.
   * Turn off (false) if the provider rejects this parameter.
   */
  streamUsage?: boolean;
}

export interface RouteTarget {
  /** Provider ID from the PROVIDERS list */
  provider: string;
  /** Model name in that provider's own format */
  model: string;
  /** Model's context window. Oversized requests are automatically skipped. */
  contextWindow?: number;
  /**
   * Set to false if this model/provider is known to be unreliable for
   * tool/function calling (e.g. gpt-oss's Harmony format leaking or
   * crashing the backend's tool-call parser). Requests that include a
   * non-empty "tools" array skip this target entirely. Defaults to true.
   */
  supportsTools?: boolean;
}

/**
 * Count actual tokens from the stream (more accurate, costs a bit of CPU).
 * Set to false if the Worker hits an "Exceeded CPU" error on the free plan.
 */
export const METER_STREAM_USAGE = true;

// ---------------------------------------------------------------------
// PROVIDERS
// The limit numbers below are just examples. Replace them with your
// own account's limits.
// ---------------------------------------------------------------------
export const PROVIDERS: ProviderConfig[] = [
  {
    id: "cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    apiKeySecret: "CEREBRAS_API_KEY",
    limits: { rpm: 30, tpd: 1_000_000 },
  },
  {
    id: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeySecret: "GROQ_API_KEY",
    limits: { rpm: 30, rpd: 1_000 },
  },
  {
    id: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeySecret: "OPENROUTER_API_KEY",
    limits: { rpm: 20, rpd: 1_000 },
  },
  {
    id: "nvidia-nim",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKeySecret: "NVIDIA_NIM_API_KEY",
    limits: { rpm: 40 },
  },
];

// ---------------------------------------------------------------------
// AUTO TARGETS
// A single list of provider+model pairs, ordered as a priority list.
// The client's "model" field (if any) is completely ignored — the proxy
// always tries these targets top to bottom, moving to the next one
// whenever the one above fails, hits a limit, or is in cooldown.
// ---------------------------------------------------------------------
export const AUTO_TARGETS: RouteTarget[] = [
  // gpt-oss's Harmony-format tool calls are known to leak/crash on Cerebras
  // and NVIDIA NIM's current backends (raw tokens like "<|channel|>" ending
  // up in tool names, or the header parser panicking outright). Until that's
  // fixed upstream, keep these unavailable for requests with `tools`.
  { provider: "cerebras", model: "gpt-oss-120b", contextWindow: 131_072, supportsTools: false },
  {
    provider: "nvidia-nim",
    model: "openai/gpt-oss-20b",
    contextWindow: 131_072,
    supportsTools: false,
  },
  {
    provider: "openrouter",
    model: "nvidia/nemotron-3-ultra-550b-a55b:free",
    contextWindow: 1_000_000,
  },
];
