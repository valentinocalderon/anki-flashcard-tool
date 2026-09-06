import type { Card, WordInfo } from '@/lib/types';
import { loadConfig } from '@/lib/config';

export function generateCards(wordInfo: WordInfo): Card[] {
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
    const escapedWord = wordInfo.spanish.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordPattern = new RegExp(`(?<!\\p{L})${escapedWord}(?!\\p{L})`, 'iu');
    const match = wordPattern.exec(wordInfo.example);
    if (match) {
      const splitIndex = wordInfo.example.indexOf('(');
      const spanishPart = splitIndex !== -1 ? wordInfo.example.slice(0, splitIndex).trim() : wordInfo.example;
      const englishPart = splitIndex !== -1 ? wordInfo.example.slice(splitIndex).trim() : '';
  
      const blanked = spanishPart.replace(wordPattern, '____');
  
      cards.push({
        deck: config.decks.vocab,
        kind: 'example',
        front: blanked,
        back: `${wordInfo.spanish} (${wordInfo.english})${englishPart ? ` ${englishPart}` : ''}`,
        tags,
      });
    }
  }

  return cards;
}

export function conjugationCards(
  wordInfo: WordInfo,
  cardedKeys: ReadonlySet<string>
): { cards: Card[]; claimedKeys: string[]; claims: { front: string; key: string }[] } {
  const config = loadConfig();
  const cards: Card[] = [];
  const claimedKeys = new Set<string>();
  const claims: { front: string; key: string }[] = [];
  const classification = wordInfo.conjugationClass;

  if (!config.cardTypes.conjugation || !classification || !wordInfo.conjugations) {
    return { cards, claimedKeys: [], claims };
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

  return { cards, claimedKeys: [...claimedKeys], claims };
}
