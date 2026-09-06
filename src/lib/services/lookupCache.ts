import { eq } from 'drizzle-orm';
import { WordInfoSchema, type WordInfo } from '@/lib/types';
import type { Db } from '@/server/db';
import { words } from '@/server/db/schema';

export function normalizeQuery(word: string): string {
  return word.trim().toLowerCase();
}

export async function cachedLookup(
  db: Db,
  word: string,
  lookup: (word: string) => Promise<WordInfo>,
): Promise<WordInfo> {
  const query = normalizeQuery(word);
  const row = await db.select().from(words).where(eq(words.query, query)).get();

  if (row) {
    return WordInfoSchema.parse(JSON.parse(row.info));
  }

  const result = await lookup(word);
  if (result.error) {
    return result;
  }

  await db.insert(words).values({
    query,
    info: JSON.stringify(result),
    lookedUpAt: Date.now(),
  }).onConflictDoNothing();
  return result;
}
