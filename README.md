# AI Proxy di Cloudflare Workers

Proxy OpenAI-compatible untuk Hermes Agent atau aplikasi AI lain.
Alurnya: Hermes → proxy ini → provider (Cerebras, Groq, OpenRouter, dll).

## Fitur

- **Fallback otomatis (priority list).** Semua request selalu dicoba sesuai urutan `AUTO_TARGETS` di `config.ts`. Kalau satu provider membalas 429 atau error server, request pindah ke pasangan provider+model berikutnya dalam daftar itu.
- **Tracking kuota.** Proxy menghitung request per menit, request per hari, dan token per hari.
- **Cooldown.** Provider yang kena 429 diistirahatkan sesuai header `Retry-After`.
- **Filter context.** Request yang terlalu besar untuk model tertentu otomatis dilewati.
- **Streaming.** Jawaban model diteruskan langsung ke client, kata per kata.

Tracking kuota memakai **Durable Object**.
Durable Object adalah penyimpanan kecil milik Cloudflare yang memproses data satu per satu.
Jadi counter tidak bentrok walau ada banyak request bersamaan.

## Struktur file

```
src/config.ts   ← yang perlu kamu edit: provider, limit, priority list model
src/index.ts    ← logika proxy
src/quota.ts    ← penghitung kuota (Durable Object)
wrangler.jsonc  ← konfigurasi deploy
```

## 1. Install

```bash
npm install
npx wrangler login
```

## 2. Atur provider dan priority list

Buka `src/config.ts`.

Di `PROVIDERS`, isi setiap provider:
- `baseUrl` harus berhenti di `/v1`.
- `apiKeySecret` adalah nama secret yang menyimpan API key.
- `limits` diisi sesuai limit akun kamu.

Di `AUTO_TARGETS`, buat daftar pasangan provider+model, diurutkan dari yang
paling kamu prioritaskan ke yang paling belakang. Proxy selalu mencoba dari
urutan paling atas, lompat ke bawahnya kalau target di atas gagal, kena limit,
atau kena cooldown.

Cek ulang nama model di dokumentasi tiap provider. Nama model sering berubah.

**Field `model` dari client diabaikan sepenuhnya.** Client tidak memilih model
atau provider — proxy yang menentukan lewat `AUTO_TARGETS`. Tidak ada lagi
konsep beberapa route bernama atau strategi `balance`; hanya satu priority
list yang selalu dipakai.

## 3. Simpan secret

```bash
npx wrangler secret put PROXY_API_KEY
npx wrangler secret put CEREBRAS_API_KEY
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put NVIDIA_NIM_API_KEY
```

`PROXY_API_KEY` adalah kunci milik proxy kamu sendiri.
Isi dengan string acak yang panjang, misalnya hasil `openssl rand -hex 32`.
Tanpa kunci ini, semua request ditolak.

## 4. Deploy

```bash
npm run deploy
```

Wrangler akan menampilkan URL seperti `https://ai-proxy.<subdomain>.workers.dev`.

## 5. Hubungkan ke Hermes

Tambahkan di `~/.hermes/config.yaml`:

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

Nama model di baris `default` (`auto`) hanya format yang dibutuhkan Hermes —
proxy tidak membaca nilainya sama sekali. Model dan provider yang benar-benar
dipakai selalu ditentukan oleh urutan `AUTO_TARGETS` di `config.ts`.

Lalu simpan kuncinya di `~/.hermes/.env`:

```bash
echo 'MY_PROXY_KEY=isi-sama-dengan-PROXY_API_KEY' >> ~/.hermes/.env
```

## Endpoint

| Method | Path | Fungsi |
|---|---|---|
| POST | `/v1/chat/completions` | Chat, format OpenAI |
| GET | `/v1/models` | Selalu balas satu entry: `auto` |
| GET | `/status` | Pemakaian kuota hari ini per provider |
| GET | `/health` | Test koneksi nyata ke semua provider+model di `AUTO_TARGETS` |
| POST | `/admin/reset?provider=cerebras` | Reset counter satu provider (tanpa query = semua) |

Semua endpoint butuh header `Authorization: Bearer <PROXY_API_KEY>`.

Cek kuota:

```bash
curl https://ai-proxy.<subdomain>.workers.dev/status \
  -H "Authorization: Bearer $MY_PROXY_KEY"
```

Cek koneksi ke semua provider/model di `AUTO_TARGETS`
(kirim request sungguhan dengan `max_tokens: 1` ke tiap target):

```bash
curl https://ai-proxy.<subdomain>.workers.dev/health \
  -H "Authorization: Bearer $MY_PROXY_KEY"
```

Contoh hasil:

```json
{
  "ok": false,
  "checks": [
    { "provider": "cerebras", "model": "openai/gpt-oss-120b", "ok": true, "status": 200, "latencyMs": 312 },
    { "provider": "openrouter", "model": "nvidia/nemotron-3-ultra:free", "ok": true, "status": 200, "latencyMs": 900 },
    { "provider": "nvidia-nim", "model": "openai/gpt-oss-20b", "ok": false, "error": "secret NVIDIA_NIM_API_KEY belum di-set" }
  ]
}
```

Response HTTP-nya `200` kalau semua target `ok`, `503` kalau ada yang gagal.

Setiap response sukses membawa header `x-proxy-provider` dan `x-proxy-model`.
Header ini menunjukkan provider mana yang benar-benar menjawab.

## Development lokal

```bash
cp .dev.vars.example .dev.vars   # lalu isi nilainya
npm run dev
```

## Catatan penting

- **Tidak ada pilihan model dari client.** Field `model` di request selalu diabaikan. Untuk menambah/mengganti/mengurutkan ulang model yang dipakai, edit `AUTO_TARGETS` di `config.ts`.
- **Kuota adalah hitungan proxy, bukan data asli provider.** Kalau kamu memakai akun yang sama di luar proxy, hitungannya tidak sinkron. Cooldown dari 429 tetap menjadi pengaman.
- **Estimasi token itu kasar.** Proxy memakai rumus 1 token ≈ 4 karakter untuk memilih provider. Setelah response selesai, angka diganti dengan token asli dari field `usage`.
- **Reset harian mengikuti 00:00 UTC.** Itu sama dengan pukul 08:00 WITA. Beberapa provider mungkin memakai waktu reset berbeda.
- **Fallback hanya terjadi sebelum jawaban mulai dikirim.** Kalau stream sudah berjalan lalu provider putus, proxy tidak bisa pindah diam-diam.
- **Error 400 dan 422 tidak di-fallback.** Error ini biasanya kesalahan request itu sendiri, jadi provider lain juga akan menolak.
- **Context Hermes.** Hermes butuh sekitar 64K context. Target dengan context kecil (misalnya Cerebras free 8K) akan otomatis dilewati untuk request besar.
- **CPU limit free plan.** Free plan Workers punya batas CPU time kecil. Menunggu provider tidak dihitung, tapi membaca stream untuk menghitung token dihitung. Kalau muncul error "Exceeded CPU", set `METER_STREAM_USAGE = false` di `config.ts`.
- **Durable Object di free plan.** Project ini memakai Durable Object berbasis SQLite. Kalau deploy ditolak karena plan, cek pengaturan akun Cloudflare kamu.
- **Terms of service.** Menyebar request ke beberapa provider berbeda itu wajar. Membuat banyak akun di provider yang sama untuk melipatgandakan kuota gratis biasanya melanggar aturan provider.
