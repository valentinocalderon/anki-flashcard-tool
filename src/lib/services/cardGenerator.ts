import type { Card, WordInfo } from '@/lib/types';
import { loadConfig } from '@/lib/config';
import type { BrainscapeItem } from './brainscapeSides';

export type LookedUpItem = {
  forms: (BrainscapeItem['forms'][number] & { info: WordInfo })[];
};

export type GeneratedCard = Card & {
  forms?: BrainscapeItem['forms'];
};

export function generateCards(wordInfo: WordInfo | LookedUpItem): GeneratedCard[] {
  if ('forms' in wordInfo) return generateItemCards(wordInfo);

  const config = loadConfig();
  const tags = config.addTags;

  const cards: Card[] = [];
  const spanishWord = wordInfo.article ? `${wordInfo.article} ${wordInfo.spanish}` : wordInfo.spanish;

  if (config.cardTypes.basic) {
    cards.push({
      deck: config.decks.vocab,
      kind: 'basic',
      front: wordInfo.english,
      back: spanishWord,
      tags,
    });
  }

  if (config.cardTypes.example && wordInfo.example) {
    const splitIndex = wordInfo.example.indexOf('(');
    const spanishPart = splitIndex !== -1 ? wordInfo.example.slice(0, splitIndex).trim() : wordInfo.example;
    const englishPart = splitIndex !== -1 ? wordInfo.example.slice(splitIndex).trim() : '';
    const exampleTarget = wordInfo.exampleWord?.trim() ? wordInfo.exampleWord.trim() : wordInfo.spanish;
    const escapedWord = exampleTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordPattern = new RegExp(`(?<!\\p{L})${escapedWord}(?!\\p{L})`, 'giu');
    if (wordPattern.test(spanishPart)) {
      const blanked = spanishPart.replace(wordPattern, '____');
      const answer = exampleTarget.toLowerCase() === wordInfo.spanish.toLowerCase()
        ? `${wordInfo.spanish} (${wordInfo.english})`
        : `${exampleTarget} (${wordInfo.spanish}, ${wordInfo.english})`;

      cards.push({
        deck: config.decks.vocab,
        kind: 'example',
        front: blanked,
        back: `${answer}${englishPart ? `<br>${englishPart}` : ''}`,
        tags,
      });
    }
  }

  return cards;
}

function generateItemCards(item: LookedUpItem): GeneratedCard[] {
  const first = item.forms[0];
  if (!first) {
    throw new Error('Cannot generate cards for an item with 0 forms; supply at least one looked-up form.');
  }
  for (const form of item.forms) {
    if (form.info.error !== undefined) {
      throw new Error(`Cannot generate cards for "${form.spanish}": lookup returned error "${form.info.error}".`);
    }
  }
  if (item.forms.length === 1) return generateCards(first.info);

  const config = loadConfig();
  if (!config.cardTypes.basic) return [];

  // Preserve every Spanish form and its order so each can receive its own Back audio clip.
  const forms = item.forms.map(({ spanish, query }) => ({ spanish, query }));
  return [{
    deck: config.decks.vocab,
    kind: 'basic',
    front: [...new Set(item.forms.map(({ info }) => info.english))].join(' / '),
    back: forms.map((form) => form.spanish).join(' / '),
    tags: config.addTags,
    forms,
  }];
}

export function conjugationCards(
  wordInfo: WordInfo,
  cardedKeys: ReadonlySet<string>
): { cards: Card[]; claims: { front: string; key: string }[] } {
  const config = loadConfig();
  const cards: Card[] = [];
  const claimedKeys = new Set<string>();
  const claims: { front: string; key: string }[] = [];
  const classification = wordInfo.conjugationClass;

  if (!config.cardTypes.conjugation || !classification || !wordInfo.conjugations) {
    return { cards, claims };
  }

  for (const tense of config.tenses) {
    const forms = wordInfo.conjugations[tense];
    if (!forms) continue;

    const pattern = classification[tense];
    const key = `${classification.ending}-${pattern}-${tense}`;
    if (pattern !== 'irregular' && (cardedKeys.has(key) || claimedKeys.has(key))) continue;

    const label = pattern === 'irregular' ? 'irregular' : `${pattern} -${classification.ending}`;
    const front = `Conjugate ${wordInfo.spanish} in ${tense} (${label})`;
    cards.push({
      deck: config.decks.conjugation,
      kind: 'conjugation',
      front,
      back: Object.entries(forms)
        .map(([pronoun, form]) => `${pronoun}: ${form}`)
        .join('<br>'),
      tags: config.addTags,
    });

    if (pattern !== 'irregular') {
      claimedKeys.add(key);
      claims.push({ front, key });
    }
  }

  return { cards, claims };
}
