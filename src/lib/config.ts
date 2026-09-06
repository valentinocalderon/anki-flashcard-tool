import { z } from 'zod';

const cardTypesSchema = z.object({
  basic: z.boolean(),
  example: z.boolean(),
  conjugation: z.boolean()
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
  anki: z.object({
    url: z.string(),
    noteTypes: z.object({
      reversed: z.string(),
      basic: z.string()
    })
  }),
  cardTypes: cardTypesSchema,
  tenses: z.array(z.enum(['present', 'preterite'])),
  decks: z.object({
    vocab: z.string(),
    conjugation: z.string()
  }),
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
  anki: {
    url: 'http://127.0.0.1:8765',
    noteTypes: {
      reversed: 'Basic (and reversed card)',
      basic: 'Basic'
    }
  },
  cardTypes: {
    basic: true,
    example: true,
    conjugation: true
  },
  tenses: ['present', 'preterite'],
  decks: {
    vocab: 'Spanish::Vocab',
    conjugation: 'Spanish::Conjugation'
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
