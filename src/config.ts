// =====================================================================
// KONFIGURASI PROXY
// Edit file ini untuk menambah provider, limit, dan target model.
// =====================================================================

export interface Limits {
  /** Request per menit */
  rpm?: number;
  /** Request per hari (reset 00:00 UTC) */
  rpd?: number;
  /** Token per hari (reset 00:00 UTC) */
  tpd?: number;
}

export interface ProviderConfig {
  /** ID unik provider. Kuota dihitung per ID ini. */
  id: string;
  /** Base URL OpenAI-compatible, berhenti di /v1 (tanpa /chat/completions) */
  baseUrl: string;
  /** Nama secret di Cloudflare yang berisi API key provider */
  apiKeySecret: string;
  /** Limit akun kamu di provider ini. Kosongkan kalau tidak ada limit. */
  limits?: Limits;
  /** Header tambahan (opsional) */
  headers?: Record<string, string>;
  /**
   * Kirim stream_options.include_usage saat streaming.
   * Matikan (false) kalau provider menolak parameter ini.
   */
  streamUsage?: boolean;
}

export interface RouteTarget {
  /** ID provider dari daftar PROVIDERS */
  provider: string;
  /** Nama model sesuai format provider tersebut */
  model: string;
  /** Context window model. Request yang terlalu besar otomatis dilewati. */
  contextWindow?: number;
}

/**
 * Hitung token asli dari stream (lebih akurat, tapi memakai sedikit CPU).
 * Set false kalau Worker kena error "Exceeded CPU" di free plan.
 */
export const METER_STREAM_USAGE = true;

// ---------------------------------------------------------------------
// PROVIDER
// Angka limit di bawah hanya contoh. Ganti sesuai limit akun kamu.
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
    // Limit Groq berbeda per model. Buat entry provider terpisah
    // kalau kamu memakai beberapa model Groq dengan limit berbeda.
    limits: { rpm: 30, rpd: 1_000 },
  },
  {
    id: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeySecret: "OPENROUTER_API_KEY",
    // Limit model :free digabung untuk semua model gratis.
    limits: { rpm: 20, rpd: 1_000 },
  },
  {
    id: "nvidia-nim",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKeySecret: "NVIDIA_NIM_API_KEY",
    // Free tier NVIDIA NIM biasanya 40 rpm. Sesuaikan dengan akun kamu.
    limits: { rpm: 40 },
  },
];

// ---------------------------------------------------------------------
// AUTO TARGETS
// Satu daftar pasangan provider+model, diurutkan sebagai priority list.
// Field "model" dari client (kalau ada) diabaikan sepenuhnya — proxy
// selalu coba target ini dari atas ke bawah, lompat ke berikutnya kalau
// yang di atas gagal/kena limit/kena cooldown.
// ---------------------------------------------------------------------
export const AUTO_TARGETS: RouteTarget[] = [
  { provider: "cerebras", model: "openai/gpt-oss-120b", contextWindow: 8_192 },
  { provider: "openrouter", model: "nvidia/nemotron-3-ultra:free", contextWindow: 131_072 },
  { provider: "nvidia-nim", model: "openai/gpt-oss-20b", contextWindow: 131_072 },
];
