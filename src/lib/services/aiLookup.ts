import { env } from '@/env';
import { loadConfig } from '@/lib/config';
import type { WordInfo } from '@/lib/types';
import { WordInfoSchema } from '@/lib/types';
import OpenAI from 'openai';

const config = loadConfig();

if (!config.aiOptions?.enabled) {
  throw new Error('❌ AI is disabled in config. Enable it to use OpenAI.');
}

if (!config.aiOptions) {
  throw new Error('❌ AI options not found in config.');
}

const aiOptions = config.aiOptions;

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY
});

export async function openaiLookup(word: string): Promise<WordInfo> {
  const prompt = `
You are a bilingual linguist AI specialized in Spanish and English. Given the word "${word}", return a valid JSON object with the following fields:
- english: the english version of the input word
- spanish: the spanish version of the input word
- gender: "masculine", "feminine", or null (null for non-nouns) for the spanish word
- article: the article (e.g., "el", "la", "los", "las") for the spanish word
- type: the part of speech (e.g., "noun", "verb", "adjective") for the spanish word
- example: one commonly used sentence using the spanish version of the word correctly, then have the english translation of the sentence right after it in parentheses.
- conjugations: if it's a verb, include an object with present/preterite/imperfect/future forms for "yo", "tú", "él/ella", "nosotros", "ellos". Otherwise, use null.
- error: if the word is not supported (not in English or Spanish), return the error message. If not, don't include this field.

Return ONLY a JSON object with no preamble or explanation.
`;

  const response = await openai.chat.completions.create({
    model: aiOptions.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2
  });

  try {
    const raw = response.choices[0]?.message?.content ?? '{}';
    console.log('🤖 ChatGPT raw response:', raw);
    const parsed = WordInfoSchema.parse(JSON.parse(raw));
    console.log('🤖 ChatGPT parsed response:', parsed);
    return parsed;
  } catch (e) {
    console.error('❌ Failed to parse AI response:', e);
    const errorMessage = e instanceof Error ? e.message : String(e);
    throw new Error(`AI response was not valid JSON: ${errorMessage}`);
  }
  
} 
