import type { RedisLike } from '../redis-like';

/** In-memory fake of the ioredis surface the stores use, with a controllable clock for PX expiry. */
export class FakeRedis implements RedisLike {
  readonly data = new Map<string, { value: string; expiresAtMs: number | null }>();
  readonly setCalls: Array<{ key: string; value: string; mode: string; ttlMs: number }> = [];
  failWith: Error | null = null;
  quitCalls = 0;

  constructor(private readonly clock: { now: number }) {}

  private live(key: string) {
    const e = this.data.get(key);
    if (!e) return undefined;
    if (e.expiresAtMs !== null && e.expiresAtMs <= this.clock.now) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }

  async set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<'OK'> {
    if (this.failWith) throw this.failWith;
    this.setCalls.push({ key, value, mode, ttlMs });
    this.data.set(key, { value, expiresAtMs: this.clock.now + ttlMs });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    if (this.failWith) throw this.failWith;
    return this.live(key)?.value ?? null;
  }

  async del(key: string): Promise<number> {
    if (this.failWith) throw this.failWith;
    return this.data.delete(key) ? 1 : 0;
  }

  async pexpire(key: string, ms: number): Promise<number> {
    const e = this.live(key);
    if (!e) return 0;
    e.expiresAtMs = this.clock.now + ms;
    return 1;
  }

  async quit(): Promise<'OK'> {
    this.quitCalls++;
    return 'OK';
  }
}
