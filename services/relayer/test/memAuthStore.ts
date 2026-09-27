// services/relayer/test/memAuthStore.ts
//
// In-memory `AuthStore` shared by auth/sponsor/nonce tests. JS's
// single-threaded event loop makes the synchronous check-and-set in
// `consumeChallenge` as atomic as pgAuthStore's `UPDATE … RETURNING`.
import { hashToken, type AuthStore } from "../src/auth.js";

export interface MemAuthStore extends AuthStore {
  challenges: Map<string, { expiresAt: number; used: boolean }>;
  sessions: Map<string, { owner: string; expiresAt: number }>;
  /** Test shortcut: mint a live session for `owner` without the SIWS round-trip. */
  sessionFor(owner: string, ttlMs?: number): string;
}

export function memAuthStore(): MemAuthStore {
  const challenges = new Map<string, { expiresAt: number; used: boolean }>();
  const sessions = new Map<string, { owner: string; expiresAt: number }>();
  const tokens = new Map<string, string>();
  return {
    challenges,
    sessions,
    async createChallenge(nonce, expiresAt) {
      challenges.set(nonce, { expiresAt, used: false });
    },
    async countOpenChallenges(now) {
      let n = 0;
      for (const c of challenges.values()) if (!c.used && c.expiresAt > now) n++;
      return n;
    },
    async consumeChallenge(nonce, now) {
      const c = challenges.get(nonce);
      if (!c || c.used || c.expiresAt <= now) return false;
      c.used = true;
      return true;
    },
    async createSession(tokenHash, owner, expiresAt) {
      sessions.set(tokenHash, { owner, expiresAt });
    },
    async getSession(tokenHash, now) {
      const s = sessions.get(tokenHash);
      return s && s.expiresAt > now ? s : null;
    },
    sessionFor(owner, ttlMs = 60 * 60 * 1000) {
      const existing = tokens.get(owner);
      if (existing) return existing;
      const token = `test-${owner}`;
      sessions.set(hashToken(token), { owner, expiresAt: Date.now() + ttlMs });
      tokens.set(owner, token);
      return token;
    },
  };
}
