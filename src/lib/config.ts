import fs from 'fs';
import path from 'path';
import { z } from 'zod';

const cardTypesSchema = z.object({
  basic: z.boolean(),
  reverse: z.boolean(),
  gender: z.boolean(),
  cloze: z.boolean(),
  conjugation: z.boolean(),
  audio: z.boolean()
});

const audioOptionsSchema = z.object({
  preferredSource: z.enum(['linguarobot', 'google']),
  attachToField: z.string(),
  cacheAudio: z.boolean()
});

const configSchema = z.object({
  deckName: z.string(),
  modelName: z.string(),
  cardTypes: cardTypesSchema,
  addTags: z.array(z.string()),
  autoAddEnabled: z.boolean(),
  audioOptions: audioOptionsSchema
  // _aiOptions is deliberately excluded from the schema for now
});

export type AppConfig = z.infer<typeof configSchema>;

const configPath = path.resolve(process.cwd(), 'config.json');

export function loadConfig(): AppConfig {
  const file = fs.readFileSync(configPath, 'utf-8');
  const json = JSON.parse(file);

  // Strip out any unknown or future-facing keys (like _aiOptions)
  const { _aiOptions, ...safeJson } = json;

  const result = configSchema.safeParse(safeJson);

  if (!result.success) {
    console.error('❌ Invalid config:', result.error.format());
    throw new Error('Invalid config.json');
  }

  return result.data;
}
