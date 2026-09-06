import type { Card, WordInfo } from '@/lib/types';
import { loadConfig } from '@/lib/config';

export function generateCards(wordInfo: WordInfo): Card[] {
  const config = loadConfig();
  const tags = config.addTags;

  const cards: Card[] = [];
  const spanishWord = wordInfo.article ? `${wordInfo.article} ${wordInfo.spanish}` : wordInfo.spanish;

  if (config.cardTypes.basic) {
    cards.push({
      front: wordInfo.english,
      back: spanishWord,
      tags,
    });
  }

  if (config.cardTypes.reverse) {
    cards.push({
      front: spanishWord,
      back: wordInfo.english,
      tags,
    });
  }

  if (config.cardTypes.gender && wordInfo.article) {
    cards.push({
      front: `What is the article of "${wordInfo.spanish}"?`,
      back: wordInfo.article,
      tags,
    });
  }

  if (config.cardTypes.conjugation && wordInfo.conjugations) {
    for (const [tense, forms] of Object.entries(wordInfo.conjugations)) {
      const lines = Object.entries(forms)
        .map(([pronoun, verb]) => `${pronoun}: ${verb}`)
        .join('<br>');

      cards.push({
        front: `Conjugate "${wordInfo.spanish}" in ${tense}`,
        back: lines,
        tags,
      });
    }
  }

  if (config.cardTypes.cloze && wordInfo.example) {
    // Match the Spanish part of the example (before the first parenthesis)
    const match = new RegExp(`\\b${wordInfo.spanish}\\b`, 'i').exec(wordInfo.example);
    if (match) {
      const splitIndex = wordInfo.example.indexOf('(');
      const spanishPart = splitIndex !== -1 ? wordInfo.example.slice(0, splitIndex).trim() : wordInfo.example;
      const englishPart = splitIndex !== -1 ? wordInfo.example.slice(splitIndex).trim() : '';
  
      const blanked = spanishPart.replace(
        new RegExp(`\\b${wordInfo.spanish}\\b`, 'i'),
        '____'
      );
  
      cards.push({
        front: blanked,
        back: `${wordInfo.spanish} (${wordInfo.english}) ${englishPart}`,
        tags,
      });
  
      // TODO: split `example` field into `spanishExample` and `englishExample` in WordInfo type
    }
  }

  return cards;
}
