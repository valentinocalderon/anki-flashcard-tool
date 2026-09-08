import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '@/server/db';
import { cards as storedCards, conjugationPatterns } from '@/server/db/schema';
import type { GeneratedCard } from './cardGenerator';
import { normalizeQuery } from './lookupCache';

type PatternClaim = Pick<typeof conjugationPatterns.$inferInsert, 'ending' | 'pattern' | 'tense'>;
type CardToStore = GeneratedCard & Pick<typeof storedCards.$inferInsert, 'audioFile' | 'audioMp3'>;

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
  db: Pick<Db, 'insert' | 'select' | 'update'>,
  wordId: number,
  { forms, ...card }: CardToStore,
  foldedCardId: number | undefined,
): Promise<{ inserted: { id: number }[]; updatedCards: number }> {
  if (foldedCardId !== undefined && card.kind === 'basic' && forms && forms.length > 1) {
    const stored = await db.select({ back: storedCards.back, forms: storedCards.forms }).from(storedCards)
      .where(eq(storedCards.id, foldedCardId)).get();
    if (!stored) {
      throw new Error(`Card ${foldedCardId} read returned 0 rows; reload the list and retry.`);
    }
    const allForms = [...forms];
    for (const form of stored.forms ?? []) {
      if (!allForms.some((current) => normalizeQuery(current.query) === normalizeQuery(form.query))) {
        allForms.push(form);
      }
    }
    const back = allForms.map((form) => form.spanish).join(' / ');
    const unchanged = stored.back === back && JSON.stringify(stored.forms) === JSON.stringify(allForms);
    if (unchanged && card.audioMp3 == null) {
      return { inserted: [], updatedCards: 0 };
    }
    const audio = card.audioMp3 != null
      ? { audioFile: card.audioFile, audioMp3: card.audioMp3, audioSentAt: null }
      : stored.back !== back ? { audioFile: null, audioMp3: null, audioSentAt: null } : {};
    const updated = await db.update(storedCards).set({
      ...(unchanged ? {} : { back, forms: allForms }), ...audio,
    })
      .where(eq(storedCards.id, foldedCardId)).returning({ id: storedCards.id });
    if (updated.length === 0) {
      throw new Error(`Card ${foldedCardId} update returned ${updated.length} rows; reload the list and retry.`);
    }
    return { inserted: [], updatedCards: unchanged ? 0 : updated.length };
  }

  const values = { ...card, forms, wordId, tags: JSON.stringify(card.tags), createdAt: Date.now() };
  const target = [storedCards.deck, storedCards.front];
  const inserted = await db.insert(storedCards).values(values)
    .onConflictDoNothing({ target }).returning({ id: storedCards.id });
  if (inserted.length === 0 && card.audioMp3 != null) {
    const stored = await db.select({ id: storedCards.id }).from(storedCards).where(and(
      eq(storedCards.deck, card.deck), eq(storedCards.front, card.front), isNull(storedCards.audioMp3),
    )).get();
    if (stored) {
      const updated = await db.update(storedCards).set({
        audioFile: card.audioFile, audioMp3: card.audioMp3, audioSentAt: null,
      })
        .where(eq(storedCards.id, stored.id)).returning({ id: storedCards.id });
      if (updated.length === 0) {
        throw new Error(`Card ${stored.id} update returned ${updated.length} rows; reload the list and retry.`);
      }
    }
  }
  return { inserted, updatedCards: 0 };
}

export async function storeCards(
  db: Db,
  wordId: number,
  cards: readonly CardToStore[],
  claims: readonly { front: string; key: string }[],
  foldedCardId?: number,
): Promise<{ vocabCards: number; conjugationCards: number; updatedCards: number }> {
  const patternsByFront = new Map(claims.map(({ front, key }) => [front, parsePatternKey(key)]));

  return db.transaction(async (tx) => {
    const counts = { vocabCards: 0, conjugationCards: 0, updatedCards: 0 };

    for (const card of cards) {
      const { inserted, updatedCards } = await storeCard(tx, wordId, card, foldedCardId);
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
