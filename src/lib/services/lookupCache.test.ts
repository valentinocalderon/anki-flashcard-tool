import { createClient } from '@libsql/client';
import { expect, test } from 'vitest';
import type { WordInfo } from '@/lib/types';
import { applyMigrations, createDb } from '@/server/db';
import { words } from '@/server/db/schema';
import { cachedLookup } from './lookupCache';

test('caches repeated lookups by the trimmed, lowercase query', async () => {
  const client = createClient({ url: ':memory:' });
  const db = createDb(client);
  const info: WordInfo = {
    english: 'house',
    spanish: 'casa',
    gender: 'feminine',
    article: 'la',
    type: 'noun',
    example: 'La casa es grande. (The house is big.)',
    conjugations: null,
  };

  try {
    await applyMigrations(db);
    let lookupCalls = 0;
    const lookup = (word: string): Promise<WordInfo> => {
      lookupCalls += 1;
      expect(word).toBe('Casa ');
      return Promise.resolve(info);
    };
    const startedAt = Date.now();

    const first = await cachedLookup(db, 'Casa ', lookup);
    const second = await cachedLookup(db, 'casa', lookup);

    expect(lookupCalls).toBe(1);
    expect(first).toEqual(info);
    expect(second).toEqual(info);
    const rows = await db.select().from(words);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      query: 'casa',
      info: JSON.stringify(info),
    });
    expect(rows[0]?.lookedUpAt).toBeGreaterThanOrEqual(startedAt);
    expect(rows[0]?.lookedUpAt).toBeLessThanOrEqual(Date.now());
  } finally {
    client.close();
  }
});

test('does not cache lookup errors', async () => {
  const client = createClient({ url: ':memory:' });
  const db = createDb(client);
  const info: WordInfo = {
    english: '',
    spanish: 'unsupported',
    gender: null,
    article: null,
    type: '',
    example: null,
    conjugations: null,
    error: 'not supported',
  };

  try {
    await applyMigrations(db);
    let lookupCalls = 0;
    const lookup = (word: string): Promise<WordInfo> => {
      lookupCalls += 1;
      expect(word).toBe('unsupported');
      return Promise.resolve(info);
    };

    const first = await cachedLookup(db, 'unsupported', lookup);
    const second = await cachedLookup(db, 'unsupported', lookup);

    expect(first).toEqual(info);
    expect(second).toEqual(info);
    expect(lookupCalls).toBe(2);
    const rows = await db.select().from(words);
    expect(rows).toHaveLength(0);
  } finally {
    client.close();
  }
});
