import { createHash } from 'node:crypto';
import type { Card } from '@/lib/types';

class CardAudioError extends Error {
  constructor(kind: 'entity' | 'tag', token: string) {
    super(`Unsupported card audio HTML ${kind} "${token}"; check cardGenerator output (expected plain text with <br> separators only).`);
    this.name = 'CardAudioError';
  }
}

function conjugationText(back: string): string {
  // cardGenerator emits plain text with <br> separators, without entity encoding.
  return back
    .replace(/<!--[\s\S]*?-->|<(?:"[^"]*"|'[^']*'|[^'">])*>/g, (tag) => {
      if (tag !== '<br>') throw new CardAudioError('tag', tag);
      return ' ';
    })
    .replace(/&(#(?:x[\da-f]+|\d+);?|[a-z][a-z\d]*;?)/gi, (entity) => {
      throw new CardAudioError('entity', entity);
    })
    .replace(/\s+/g, ' ').trim();
}

export function cardAudio(
  card: Pick<Card, 'deck' | 'front' | 'kind' | 'back'>,
): { text: string; audioFile: string } {
  // Match the store's unique deck/front identity, independent of enrichment or send metadata.
  const identity = createHash('sha256').update(JSON.stringify([card.deck, card.front])).digest('hex');
  const text = card.kind === 'conjugation'
    ? conjugationText(card.back)
    : card.back;

  return { text, audioFile: `card-${identity}.mp3` };
}
