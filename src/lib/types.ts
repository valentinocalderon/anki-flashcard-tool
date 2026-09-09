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

export type WordResult = {
  word: string;
  source?: string;
  vocabCards: number;
  conjugationCards: number;
} & (
  | { status: 'added' | 'updated' | 'exists' | 'skipped' | 'duplicate'; message?: string }
  | { status: 'error'; message: string }
);

const supportedWordInfoSchema = z.object({
  english: z.string(),
  spanish: z.string(),
  gender: z.string().nullable(),
  article: z.string().nullable(),
  type: z.string().nullable(),
  example: z.string().nullable(),
  exampleWord: z.string().nullable().optional(),
  conjugations: z
    .object({
      present: z.record(z.string()).optional(),
      preterite: z.record(z.string()).optional(),
    })
    .nullable(),
  conjugationClass: conjugationClassSchema.nullable().optional(),
  // Older cached successes omitted error; new lookups explicitly return null.
  error: z.null().optional(),
});

export const WordInfoSchema = z.union([
  supportedWordInfoSchema,
  supportedWordInfoSchema.extend({
    english: z.string().nullable().optional(),
    spanish: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
    error: z.string(),
  }).partial({ gender: true, article: true, example: true, conjugations: true }),
]);

export function wordInfoIssues(error: z.ZodError): z.ZodIssue[] {
  const [issue] = error.issues;
  if (error.issues.length !== 1 || issue?.code !== 'invalid_union' || issue.path.length !== 0) {
    return error.issues;
  }

  const branches = issue.unionErrors.filter((branch) => !branch.issues.some(
    (branchIssue) => branchIssue.path.length === 1 && branchIssue.path[0] === 'error',
  ));
  const [branch] = branches;
  return branches.length === 1 && branch ? branch.issues : error.issues;
}

export type WordInfo = z.infer<typeof WordInfoSchema>;

export const CardSchema = z.object({
  deck: z.string(),
  kind: z.enum(['basic', 'example', 'conjugation']),
  front: z.string(),
  back: z.string(),
  tags: z.array(z.string()),
});
