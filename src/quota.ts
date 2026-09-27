import { DurableObject } from "cloudflare:workers";
import type { Limits } from "./config";

export interface Candidate {
  /** Index target di AUTO_TARGETS */
  index: number;
  /** Kunci kuota (ID provider) */
  quotaKey: string;
  limits: Limits;
}

export interface Counter {
  day: string;
  requests: number;
  tokens: number;
  minute: number;
  minuteRequests: number;
  cooldownUntil: number;
}

/**
 * Satu instance global yang menyimpan pemakaian semua provider.
 * Durable Object memproses panggilan satu per satu,
 * jadi counter tidak bentrok walau ada request bersamaan.
 */
export class QuotaTracker extends DurableObject {
  private counters = new Map<string, Counter>();

  private async load(key: string): Promise<Counter> {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const minute = Math.floor(now / 60_000);

    let c = this.counters.get(key) ?? (await this.ctx.storage.get<Counter>(key));
    if (!c) {
      c = { day, requests: 0, tokens: 0, minute, minuteRequests: 0, cooldownUntil: 0 };
    }
    if (c.day !== day) {
      c.day = day;
      c.requests = 0;
      c.tokens = 0;
    }
    if (c.minute !== minute) {
      c.minute = minute;
      c.minuteRequests = 0;
    }
    this.counters.set(key, c);
    return c;
  }

  private async save(key: string, c: Counter): Promise<void> {
    this.counters.set(key, c);
    await this.ctx.storage.put(key, c);
  }

  /** Skor sisa kuota harian (0..1). -1 berarti tidak boleh dipakai. */
  private headroom(c: Counter, limits: Limits, est: number, now: number): number {
    if (now < c.cooldownUntil) return -1;
    if (limits.rpm && c.minuteRequests >= limits.rpm) return -1;

    const ratios: number[] = [];
    if (limits.rpd) {
      if (c.requests >= limits.rpd) return -1;
      ratios.push(1 - c.requests / limits.rpd);
    }
    if (limits.tpd) {
      if (c.tokens + est > limits.tpd) return -1;
      ratios.push(1 - (c.tokens + est) / limits.tpd);
    }
    if (ratios.length === 0) return 1;
    return Math.max(Math.min(...ratios), 0.001);
  }

  /**
   * Pilih target pertama (sesuai urutan priority list) yang masih ada sisa
   * kuota, dan langsung catat pemakaiannya (reservasi).
   * Mengembalikan index target, atau null kalau semua habis.
   */
  async acquire(candidates: Candidate[], estTokens: number): Promise<number | null> {
    const now = Date.now();

    for (const cand of candidates) {
      const counter = await this.load(cand.quotaKey);
      const score = this.headroom(counter, cand.limits, estTokens, now);
      if (score <= 0) continue;

      counter.requests += 1;
      counter.minuteRequests += 1;
      counter.tokens += estTokens;
      await this.save(cand.quotaKey, counter);
      return cand.index;
    }
    return null;
  }

  /** Ganti estimasi token dengan jumlah token asli dari response. */
  async record(key: string, actualTokens: number, estimatedTokens: number): Promise<void> {
    const c = await this.load(key);
    c.tokens = Math.max(0, c.tokens + actualTokens - estimatedTokens);
    await this.save(key, c);
  }

  /**
   * Batalkan reservasi saat request gagal.
   * countRequest=true: request tetap dihitung (misalnya kena 429).
   */
  async fail(
    key: string,
    estimatedTokens: number,
    countRequest: boolean,
    cooldownMs: number,
  ): Promise<void> {
    const c = await this.load(key);
    c.tokens = Math.max(0, c.tokens - estimatedTokens);
    if (!countRequest) {
      c.requests = Math.max(0, c.requests - 1);
      c.minuteRequests = Math.max(0, c.minuteRequests - 1);
    }
    if (cooldownMs > 0) {
      c.cooldownUntil = Math.max(c.cooldownUntil, Date.now() + cooldownMs);
    }
    await this.save(key, c);
  }

  async snapshot(keys: string[]): Promise<Record<string, Counter>> {
    const out: Record<string, Counter> = {};
    for (const key of keys) out[key] = { ...(await this.load(key)) };
    return out;
  }

  /** Reset counter satu provider, atau semua kalau key kosong. */
  async reset(key?: string): Promise<void> {
    if (key) {
      this.counters.delete(key);
      await this.ctx.storage.delete(key);
    } else {
      this.counters.clear();
      await this.ctx.storage.deleteAll();
    }
  }
}
