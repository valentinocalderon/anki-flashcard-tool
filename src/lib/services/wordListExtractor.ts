import { z } from 'zod';

export type AskForJson = <T>(prompt: string, schema: z.ZodType<T>) => Promise<T>;

export async function extractItems(text: string, ask: AskForJson): Promise<string[]> {
  const prompt = `From the following block, list the vocabulary items the user wants to study, one entry per word or phrase, no translations, no explanations, as a JSON object { items: string[] }.

${text}`;
  const { items } = await ask(prompt, z.object({ items: z.array(z.string()) }));
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of items) {
    const word = item.trim();
    const key = word.toLowerCase();
    if (!word || seen.has(key)) continue;
    seen.add(key);
    result.push(word);
  }

  return result;
}
