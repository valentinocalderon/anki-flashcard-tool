import { env } from '@/env';
import { loadConfig } from '@/lib/config';
import type { WordInfo } from '@/lib/types';
import { WordInfoSchema } from '@/lib/types';
import OpenAI from 'openai';
import { ZodError, type z } from 'zod';

export async function askForJson<T>(prompt: string, schema: z.ZodType<T>, client: OpenAI): Promise<T> {
  const config = loadConfig();

  if (!config.aiOptions?.enabled) {
    throw new Error('❌ AI is disabled in config. Enable it to use OpenAI.');
  }

  if (!config.aiOptions) {
    throw new Error('❌ AI options not found in config.');
  }

  const response = await client.chat.completions.create({
    model: config.aiOptions.model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: prompt }],
  });
  const raw = response.choices[0]?.message.content;
  if (raw === null || raw === undefined) throw new Error('AI response was not valid JSON');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error('❌ Failed to parse AI response:', error, raw);
    throw new Error('AI response was not valid JSON', { cause: error });
  }

  try {
    return schema.parse(parsed);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    console.error('❌ AI response did not match the expected shape:', error.issues, raw);
    throw new Error(`AI response did not match the expected shape: ${JSON.stringify(error.issues)}`, {
      cause: error,
    });
  }
}

export async function openaiLookup(word: string): Promise<WordInfo> {
  const client = new OpenAI({
    apiKey: env.OPENAI_API_KEY
  });
  const prompt = `
You are a bilingual linguist AI specialized in Spanish and English. Given the word "${word}", return a valid JSON object with the following fields:
- english: the english version of the input word
- spanish: the spanish version of the input word
- gender: "masculine", "feminine", or null (null for non-nouns) for the spanish word
- article: the article (e.g., "el", "la", "los", "las") for the spanish word
- type: the part of speech (e.g., "noun", "verb", "adjective") for the spanish word
- example: one commonly used sentence using the spanish version of the word correctly, then have the english translation of the sentence right after it in parentheses.
- exampleWord: the exact form of the word as it appears in the Spanish example sentence, for example Tengo when the word is tener; null when there is no example.
- conjugations: if it's a verb, include an object with only present and preterite. Each tense must contain all six pronoun forms: "yo", "tú", "él/ella", "nosotros", "vosotros", "ellos". For non-verbs, return null.
- conjugationClass: if it's a verb, include an object with ending (one of "ar", "er", "ir"), present, and preterite. Classify each tense independently as one of "regular", "e-ie", "o-ue", "e-i", "u-ue", "irregular". Use "regular" for standard conjugation, a stem-change pattern for that stem change, and "irregular" for other irregularities. For non-verbs, return null.
- error: if the word is not supported (not in English or Spanish), return the error message. If not, don't include this field.

Return ONLY a JSON object with no preamble or explanation.
`;

  return askForJson(prompt, WordInfoSchema, client);
}
