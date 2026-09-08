import { and, eq } from 'drizzle-orm';
import OpenAI from 'openai';
import { env } from '@/env';
import { loadConfig } from '@/lib/config';
import type { WordInfo, WordResult } from '@/lib/types';
import type { Db } from '@/server/db';
import { cards, words } from '@/server/db/schema';
import { askForJson } from './aiLookup';
import { fetchPack, isPackUrl } from './brainscapePack';
import { spanishSideItems, type BrainscapeItem } from './brainscapeSides';
import { cardAudio } from './cardAudio';
import { conjugationCards, generateCards, type GeneratedCard, type LookedUpItem } from './cardGenerator';
import { cardedPatternKeys, storeCards } from './cardStore';
import { cachedLookup, normalizeQuery } from './lookupCache';
import { createSpanishVoice } from './spanishVoice';
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

function errorResult(word: string, error: unknown): WordResult {
  return {
    word, status: 'error', vocabCards: 0, conjugationCards: 0,
    message: error instanceof Error ? error.message : String(error),
  };
}

async function inputItems(
  text: string,
  ask: AskForJson,
  fetchImpl: typeof fetch,
  results: WordResult[],
): Promise<readonly BrainscapeItem[]> {
  if (!isPackUrl(text)) {
    return (await resolveWordList(text, ask)).map((spanish) => ({
      forms: [{ spanish, query: normalizeQuery(spanish) }],
    }));
  }

  const items: BrainscapeItem[] = [];
  for (const side of await fetchPack(text.trim(), fetchImpl)) {
    try {
      items.push(...spanishSideItems(side));
    } catch (error) {
      results.push(errorResult(side, error));
    }
  }
  return items;
}

async function voiceCard(
  db: Db,
  card: GeneratedCard,
  voice: ReturnType<typeof createSpanishVoice>,
  foldedCardId: number | undefined,
): Promise<Parameters<typeof storeCards>[2][number]> {
  const folding = foldedCardId !== undefined && card.kind === 'basic' && card.forms && card.forms.length > 1;
  const stored = await db.select().from(cards).where(folding
    ? eq(cards.id, foldedCardId)
    : and(eq(cards.deck, card.deck), eq(cards.front, card.front))).get();
  let spokenCard = stored ?? card;
  if (folding && stored && card.forms) {
    const forms = [...card.forms];
    for (const form of stored.forms ?? []) {
      if (!forms.some((current) => normalizeQuery(current.query) === normalizeQuery(form.query))) {
        forms.push(form);
      }
    }
    spokenCard = { ...stored, back: forms.map((form) => form.spanish).join(' / ') };
  }
  if (stored?.audioMp3 != null && stored.back === spokenCard.back) return card;

  let audio: ReturnType<typeof cardAudio>;
  try {
    audio = cardAudio(spokenCard);
  } catch (error) {
    if (error instanceof Error && error.name === 'CardAudioError') return card;
    throw error;
  }
  const bytes = await voice.synthesize(audio.text);
  return bytes === undefined ? card : { ...card, audioFile: audio.audioFile, audioMp3: Buffer.from(bytes) };
}

async function generateItem(
  db: Db,
  item: BrainscapeItem,
  lookup: (word: string) => Promise<WordInfo>,
  voice: ReturnType<typeof createSpanishVoice>,
): Promise<WordResult> {
  const word = item.forms.map((form) => form.spanish).join(' / ');
  const storedWords = await db.select({
    query: words.query, cardId: cards.id, kind: cards.kind, forms: cards.forms,
  }).from(words).innerJoin(cards, eq(cards.wordId, words.id)).orderBy(cards.id);
  const cardsByForm = item.forms.map((form) => storedWords.filter((row) =>
    normalizeQuery(row.query) === form.query ||
    row.forms?.some((storedForm) => normalizeQuery(storedForm.query) === form.query),
  ));
  if (cardsByForm.every((rows) => rows.length > 0)) {
    return { word, status: 'skipped', vocabCards: 0, conjugationCards: 0 };
  }
  const foldedCardIds = [...new Set(cardsByForm.flat()
    .filter((row) => row.kind === 'basic').map((row) => row.cardId))];
  if (foldedCardIds.length > 1) {
    return errorResult(word,
      `Cannot fold "${word}": its forms are already owned by ${foldedCardIds.length} different basic cards; card the forms one at a time.`,
    );
  }
  const foldedCardId = foldedCardIds[0];

  const lookedUp: LookedUpItem = { forms: [] };
  for (const form of item.forms) {
    lookedUp.forms.push({ ...form, info: await cachedLookup(db, form.spanish, lookup) });
  }
  const failed = lookedUp.forms.find((form) => form.info.error !== undefined);
  if (failed) return errorResult(word, failed.info.error);

  const itemWordIds: number[] = [];
  for (const form of lookedUp.forms) {
    const row = await db.select({ id: words.id }).from(words).where(eq(words.query, form.query)).get();
    if (!row) {
      return errorResult(word, `Cached word "${form.spanish}" is missing; check lookup cache persistence and retry.`);
    }
    itemWordIds.push(row.id);
  }
  const first = lookedUp.forms[0];
  const wordId = itemWordIds[0];
  if (!first || wordId === undefined) {
    throw new Error(`Cannot generate an item with ${lookedUp.forms.length} forms; supply a Spanish form.`);
  }

  const conjugations = conjugationCards(first.info, await cardedPatternKeys(db));
  const voicedCards: Parameters<typeof storeCards>[2][number][] = [];
  for (const card of [...generateCards(lookedUp.forms.length === 1 ? first.info : lookedUp), ...conjugations.cards]) {
    voicedCards.push(await voiceCard(db, card, voice, foldedCardId));
  }
  const { vocabCards, conjugationCards: insertedConjugations, updatedCards } = await storeCards(
    db, wordId, voicedCards, conjugations.claims, foldedCardId,
  );
  const counts = { vocabCards, conjugationCards: insertedConjugations };
  if (updatedCards > 0) return { word, status: 'updated', ...counts };
  if (vocabCards + insertedConjugations > 0) return { word, status: 'added', ...counts };
  return { word, status: 'exists', ...counts };
}

export async function generateForWords(
  db: Db,
  text: string,
  lookup: (word: string) => Promise<WordInfo>,
  fetchImpl: typeof fetch,
): Promise<{ results: WordResult[]; capReached: boolean }> {
  const voice = createSpanishVoice(loadConfig().audio, fetchImpl);
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const ask: AskForJson = (prompt, schema) => askForJson(prompt, schema, client);
  const results: WordResult[] = [];
  const items: readonly BrainscapeItem[] = dedupeItems(await inputItems(text, ask, fetchImpl, results));

  for (const item of items) {
    try {
      results.push(await generateItem(db, item, lookup, voice));
    } catch (error) {
      results.push(errorResult(item.forms.map((form) => form.spanish).join(' / '), error));
    }
  }

  return { results, capReached: voice.capReached };
}
