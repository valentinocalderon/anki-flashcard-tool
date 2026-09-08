import { and, inArray, ne } from 'drizzle-orm';
import type { Db } from '@/server/db';
import { cards as storedCards, conjugationPatterns } from '@/server/db/schema';
import type { GeneratedCard } from './cardGenerator';

type PatternClaim = Pick<typeof conjugationPatterns.$inferInsert, 'ending' | 'pattern' | 'tense'>;

function parsePatternKey(key: string): PatternClaim {
  const [ending, ...parts] = key.split('-');
  const tense = parts.pop();
  const pattern = parts.join('-');

  if (
    (ending !== 'ar' && ending !== 'er' && ending !== 'ir') ||
    (pattern !== 'regular' && pattern !== 'e-ie' && pattern !== 'o-ue' && pattern !== 'e-i' && pattern !== 'u-ue') ||
    (tense !== 'present' && tense !== 'preterite')
  ) {
    throw new Error(
      `Invalid conjugation pattern key "${key}"; use a supported ending, non-irregular pattern, and tense.`,
    );
  }

  return { ending, pattern, tense };
}

export async function cardedPatternKeys(db: Db): Promise<Set<string>> {
  const rows = await db.select({
    ending: conjugationPatterns.ending,
    pattern: conjugationPatterns.pattern,
    tense: conjugationPatterns.tense,
  }).from(conjugationPatterns);

  return new Set(rows.map(({ ending, pattern, tense }) => `${ending}-${pattern}-${tense}`));
}

async function storeCard(
  db: Pick<Db, 'insert'>,
  wordId: number,
  { forms, ...card }: GeneratedCard,
  partlyCarded: boolean,
  itemWordIds: readonly number[],
): Promise<{ inserted: { id: number }[]; updatedCards: number }> {
  const values = { ...card, wordId, tags: JSON.stringify(card.tags), createdAt: Date.now() };
  const target = [storedCards.deck, storedCards.front];
  const inserted = await db.insert(storedCards).values(values)
    .onConflictDoNothing({ target }).returning({ id: storedCards.id });
  if (inserted.length > 0 || !partlyCarded || !forms || forms.length <= 1) {
    return { inserted, updatedCards: 0 };
  }

  // The transaction retains the conflicting row, so these returned rows are updates only.
  const updated = await db.insert(storedCards).values(values).onConflictDoUpdate({
    target,
    set: { back: card.back },
    setWhere: and(inArray(storedCards.wordId, itemWordIds), ne(storedCards.back, card.back)),
  }).returning({ id: storedCards.id });
  return { inserted, updatedCards: updated.length };
}

export async function storeCards(
  db: Db,
  wordId: number,
  cards: readonly GeneratedCard[],
  claims: readonly { front: string; key: string }[],
  partlyCarded: boolean,
  itemWordIds: readonly number[],
): Promise<{ vocabCards: number; conjugationCards: number; updatedCards: number }> {
  const patternsByFront = new Map(claims.map(({ front, key }) => [front, parsePatternKey(key)]));

  return db.transaction(async (tx) => {
    const counts = { vocabCards: 0, conjugationCards: 0, updatedCards: 0 };

    for (const card of cards) {
      const { inserted, updatedCards } = await storeCard(tx, wordId, card, partlyCarded, itemWordIds);
      counts.updatedCards += updatedCards;
      if (inserted.length === 0) continue;
      if (card.kind !== 'conjugation') {
        counts.vocabCards += inserted.length;
        continue;
      }

      counts.conjugationCards += inserted.length;
      const claim = patternsByFront.get(card.front);
      if (!claim) continue;

      for (const { id } of inserted) {
        await tx.insert(conjugationPatterns).values({
          ...claim,
          cardId: id,
          createdAt: Date.now(),
        }).onConflictDoNothing();
      }
    }

    return counts;
  });
}
