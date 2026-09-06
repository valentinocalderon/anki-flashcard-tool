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
  preferredSource: z.enum(['google']),
  attachToField: z.string(),
  cacheAudio: z.boolean()
});

const aiOptionsSchema = z.object({
  enabled: z.boolean(),
  provider: z.string(),
  model: z.string(),
  generateExamples: z.boolean(),
  rewriteDefinitions: z.boolean()
});

export const configSchema = z.object({
  database: z.object({
    url: z.string()
  }),
  deckName: z.string(),
  modelName: z.string(),
  cardTypes: cardTypesSchema,
  addTags: z.array(z.string()),
  autoAddEnabled: z.boolean(),
  audioOptions: audioOptionsSchema,
  aiOptions: aiOptionsSchema.optional(),
});

export type AppConfig = z.infer<typeof configSchema>;

const config: AppConfig = {
  database: {
    url: 'file:db.sqlite'
  },
  deckName: 'Spanish Vocab',
  modelName: 'Basic',
  cardTypes: {
    basic: true,
    reverse: true,
    gender: true,
    cloze: true,
    conjugation: true,
    audio: true
  },
  addTags: ['auto-generated'],
  autoAddEnabled: false,
  audioOptions: {
    preferredSource: 'google',
    attachToField: 'Front',
    cacheAudio: true
  },
  aiOptions: {
    enabled: true,
    provider: 'openai',
    model: 'gpt-3.5-turbo',
    generateExamples: true,
    rewriteDefinitions: false
  }
};

export function loadConfig(): AppConfig {
  return config;
}
