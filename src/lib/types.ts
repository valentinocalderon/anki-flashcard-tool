import { z } from 'zod';

const conjugationPatternSchema = z.enum(['regular', 'e-ie', 'o-ue', 'e-i', 'u-ue', 'irregular']);

const conjugationClassSchema = z.object({
  ending: z.enum(['ar', 'er', 'ir']),
  present: conjugationPatternSchema,
  preterite: conjugationPatternSchema,
});

export type Card = {
  deck: string;
  kind: 'basic' | 'example' | 'conjugation';
  front: string;
  back: string;
  tags: string[];
};

export type WordInfo = {
  english: string;
  spanish: string;
  gender: string | null;
  article: string | null;
  type: string;
  example: string | null;
  exampleWord?: string | null;
  conjugations: {
    present?: Record<string, string>;
    preterite?: Record<string, string>;
  } | null;
  conjugationClass?: z.infer<typeof conjugationClassSchema> | null;
  error?: string;
};

export type WordResult = {
  word: string;
  vocabCards: number;
  conjugationCards: number;
} & (
  | { status: 'added' | 'exists' | 'skipped'; message?: string }
  | { status: 'error'; message: string }
);

export const WordInfoSchema = z.object({
  english: z.string(),
  spanish: z.string(),
  gender: z.string().nullable(),
  article: z.string().nullable(),
  type: z.string(),
  example: z.string().nullable(),
  exampleWord: z.string().nullable().optional(),
  conjugations: z
    .object({
      present: z.record(z.string()).optional(),
      preterite: z.record(z.string()).optional(),
    })
    .nullable(),
  conjugationClass: conjugationClassSchema.nullable().optional(),
  error: z.string().optional()
});

export const CardSchema = z.object({
  deck: z.string(),
  kind: z.enum(['basic', 'example', 'conjugation']),
  front: z.string(),
  back: z.string(),
  tags: z.array(z.string()),
});
