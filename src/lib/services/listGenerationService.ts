import { eq } from 'drizzle-orm';
import type { WordInfo } from '@/lib/types';
import type { Db } from '@/server/db';
import { words } from '@/server/db/schema';
import { conjugationCards, generateCards } from './cardGenerator';
import { cardedPatternKeys, storeCards } from './cardStore';
import { cachedLookup, normalizeQuery } from './lookupCache';

export type WordResult = {
  word: string;
  status: 'added' | 'exists' | 'error';
  vocabCards: number;
  conjugationCards: number;
  message?: string;
};

export function parseWordList(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of text.split(/\r\n|\n|\r/)) {
    const word = line.trim();
    const query = normalizeQuery(word);
    if (!word || seen.has(query)) continue;
    seen.add(query);
    result.push(word);
  }

  return result;
}

export async function generateForWords(
  db: Db,
  text: string,
  lookup: (word: string) => Promise<WordInfo>,
): Promise<WordResult[]> {
  const results: WordResult[] = [];

  for (const word of parseWordList(text)) {
    try {
      const info = await cachedLookup(db, word, lookup);
      if (info.error !== undefined) {
        results.push({
          word, status: 'error', vocabCards: 0, conjugationCards: 0, message: info.error,
        });
        continue;
      }

      const row = await db.select({ id: words.id }).from(words)
        .where(eq(words.query, normalizeQuery(word))).get();
      if (!row) {
        results.push({
          word, status: 'error', vocabCards: 0, conjugationCards: 0,
          message: `Cached word "${word}" is missing; check lookup cache persistence and retry.`,
        });
        continue;
      }

      const conjugations = conjugationCards(info, await cardedPatternKeys(db));
      const counts = await storeCards(
        db, row.id, [...generateCards(info), ...conjugations.cards], conjugations.claims,
      );
      results.push({
        word,
        status: counts.vocabCards + counts.conjugationCards > 0 ? 'added' : 'exists',
        ...counts,
      });
    } catch (error) {
      results.push({
        word, status: 'error', vocabCards: 0, conjugationCards: 0,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}
