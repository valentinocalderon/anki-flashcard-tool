import type { Card } from '@/lib/types';
import type { Db } from '@/server/db';
import { cards as storedCards, conjugationPatterns } from '@/server/db/schema';

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

export async function storeCards(
  db: Db,
  wordId: number,
  cards: readonly Card[],
  claims: readonly { front: string; key: string }[],
): Promise<{ vocabCards: number; conjugationCards: number }> {
  const patternsByFront = new Map(claims.map(({ front, key }) => [front, parsePatternKey(key)]));

  return db.transaction(async (tx) => {
    const counts = { vocabCards: 0, conjugationCards: 0 };

    for (const card of cards) {
      const inserted = await tx.insert(storedCards).values({
        ...card,
        wordId,
        tags: JSON.stringify(card.tags),
        createdAt: Date.now(),
      }).onConflictDoNothing({ target: [storedCards.deck, storedCards.front] })
        .returning({ id: storedCards.id });

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
