import { extractItems, type AskForJson } from './wordListExtractor';

export function splitByDelimiters(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const piece of text.split(/[\r\n,;]/)) {
    const word = piece.trim().replace(/^(?:[-*•]|\d+[.)])\s*/, '').trim();
    const key = word.toLowerCase();
    if (!word || seen.has(key)) continue;
    seen.add(key);
    result.push(word);
  }

  return result;
}

export async function resolveWordList(text: string, ask: AskForJson): Promise<string[]> {
  const items = splitByDelimiters(text);
  if (items.length === 1 && items[0] !== undefined && /\s/.test(items[0])) {
    return extractItems(text, ask);
  }

  return items;
}
