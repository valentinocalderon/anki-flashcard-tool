import { eq } from 'drizzle-orm';
import OpenAI from 'openai';
import { env } from '@/env';
import type { WordInfo, WordResult } from '@/lib/types';
import type { Db } from '@/server/db';
import { cards, words } from '@/server/db/schema';
import { askForJson } from './aiLookup';
import type { BrainscapeItem } from './brainscapeSides';
import { conjugationCards, generateCards } from './cardGenerator';
import { cardedPatternKeys, storeCards } from './cardStore';
import { cachedLookup, normalizeQuery } from './lookupCache';
import type { AskForJson } from './wordListExtractor';
import { resolveWordList } from './wordListParser';

export function dedupeItems(items: readonly BrainscapeItem[]): BrainscapeItem[] {
  const seen = new Set<string>();
  const result: BrainscapeItem[] = [];

  for (const item of items) {
    const forms = item.forms.filter((form) => {
      const query = normalizeQuery(form.query);
      if (seen.has(query)) return false;
      seen.add(query);
      return true;
    });
    if (forms.length > 0) result.push({ forms });
  }

  return result;
}

export async function generateForWords(
  db: Db,
  text: string,
  lookup: (word: string) => Promise<WordInfo>,
): Promise<WordResult[]> {
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const ask: AskForJson = (prompt, schema) => askForJson(prompt, schema, client);
  const results: WordResult[] = [];
  const items = dedupeItems((await resolveWordList(text, ask)).map((spanish) => ({
    forms: [{ spanish, query: normalizeQuery(spanish) }],
  })));

  for (const { spanish: word, query } of items.flatMap((item) => item.forms)) {
    try {
      const storedWords = await db.select({ query: words.query }).from(words)
        .innerJoin(cards, eq(cards.wordId, words.id));
      if (storedWords.some((row) => normalizeQuery(row.query) === query)) {
        results.push({ word, status: 'skipped', vocabCards: 0, conjugationCards: 0 });
        continue;
      }

      const info = await cachedLookup(db, word, lookup);
      if (info.error !== undefined) {
        results.push({
          word, status: 'error', vocabCards: 0, conjugationCards: 0, message: info.error,
        });
        continue;
      }

      const row = await db.select({ id: words.id }).from(words)
        .where(eq(words.query, query)).get();
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
