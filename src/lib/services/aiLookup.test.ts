import OpenAI from 'openai';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '@/lib/config';
import { wordInfoIssues, type WordInfoSchema } from '@/lib/types';
import { askForJson, openaiLookup } from './aiLookup';

const { createCompletion } = vi.hoisted(() => ({
  createCompletion: vi.fn<OpenAI['chat']['completions']['create']>(),
}));

vi.mock('@/env', () => ({ env: { OPENAI_API_KEY: 'test-key' } }));
vi.mock('openai', () => ({
  default: vi.fn(class {
    chat = {
      completions: {
        create: createCompletion,
      },
    };
  }),
}));

const schema = z.object({ items: z.array(z.string()) });
const prompt = 'Return the words in a single JSON object.';

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeClient(content: string | null | undefined) {
  const client = new OpenAI({ apiKey: 'test-key' });
  const create = createCompletion.mockReset();
  create.mockResolvedValue({
    id: 'test-completion',
    object: 'chat.completion',
    created: 0,
    model: 'test-model',
    choices: content === undefined ? [] : [{
      index: 0,
      finish_reason: 'stop',
      logprobs: null,
      message: { role: 'assistant', content, refusal: null },
    }],
  });
  return { client, create };
}

test('returns the parsed and schema-validated answer', async () => {
  const { client } = fakeClient('{"items":["casa","hablar"],"extra":true}');

  const answer: z.infer<typeof schema> = await askForJson(prompt, schema, client);

  expect(answer).toEqual({ items: ['casa', 'hablar'] });
});

test('reports a schema mismatch with the shape message and zod issues', async () => {
  const raw = '{"items":42}';
  const { client } = fakeClient(raw);
  const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  const answer = askForJson(prompt, schema, client);

  await expect(answer).rejects.toHaveProperty('message',
    'AI response did not match the expected shape: [{"code":"invalid_type","expected":"array","received":"number","path":["items"],"message":"Expected array, received number"}]',
  );
  await expect(answer).rejects.toHaveProperty('cause', expect.any(z.ZodError));
  expect(logError).toHaveBeenCalledExactlyOnceWith(
    '❌ AI response did not match the expected shape:', expect.any(Array), raw,
  );
});

test('askForJson preserves all union issues for other schemas', async () => {
  const { client } = fakeClient('{"error":null}');
  const unionSchema = z.union([
    z.object({ items: z.array(z.string()), error: z.null() }),
    z.object({ error: z.string() }),
  ]);
  const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  await expect(askForJson(prompt, unionSchema, client)).rejects.toHaveProperty('message',
    'AI response did not match the expected shape: [{"code":"invalid_union","unionErrors":[{"issues":[{"code":"invalid_type","expected":"array","received":"undefined","path":["items"],"message":"Required"}],"name":"ZodError"},{"issues":[{"code":"invalid_type","expected":"string","received":"null","path":["error"],"message":"Expected string, received null"}],"name":"ZodError"}],"path":[],"message":"Invalid input"}]',
  );
  expect(logError).toHaveBeenCalledOnce();
});

const fieldIssue: z.ZodIssue = {
  code: 'invalid_type', expected: 'string', received: 'number',
  path: ['english'], message: 'Expected string, received number',
};
const unionIssue: z.ZodIssue = {
  code: 'invalid_union', path: [], message: 'Invalid input',
  unionErrors: [
    new z.ZodError([fieldIssue]),
    new z.ZodError([{
      code: 'invalid_type', expected: 'string', received: 'null',
      path: ['error'], message: 'Expected string, received null',
    }]),
  ],
};

test.each([
  { description: 'no issues', issues: [] },
  { description: 'a non-union issue', issues: [fieldIssue] },
  { description: 'a union below the root', issues: [{ ...unionIssue, path: ['word'] }] },
  { description: 'a union alongside another issue', issues: [unionIssue, fieldIssue] },
])('WordInfo issues preserve the original array for $description', ({ issues }) => {
  const error = new z.ZodError(issues);

  expect(wordInfoIssues(error)).toBe(error.issues);
});

test('WordInfo branch selection only treats the exact error field path as a failure', () => {
  const error = new z.ZodError([{
    ...unionIssue,
    unionErrors: [
      new z.ZodError([{ code: 'custom', path: ['error', 'nested'], message: 'Nested failure' }]),
      new z.ZodError([{ code: 'custom', path: ['error'], message: 'Wrong branch' }]),
    ],
  }]);

  expect(wordInfoIssues(error)).toEqual([
    { code: 'custom', path: ['error', 'nested'], message: 'Nested failure' },
  ]);
});

test('requests JSON mode with the configured model, temperature, and prompt', async () => {
  const { client, create } = fakeClient('{"items":[]}');

  await askForJson(prompt, schema, client);

  expect(create).toHaveBeenCalledExactlyOnceWith({
    model: loadConfig().aiOptions?.model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: prompt }],
  });
});

test.each([
  { description: 'missing response content', content: null },
  { description: 'missing choice', content: undefined },
])('reports $description', async ({ content }) => {
  const { client } = fakeClient(content);

  await expect(askForJson(prompt, schema, client)).rejects.toThrow(
    'AI response was not valid JSON',
  );
});

test('reports invalid JSON and preserves the parse failure as its cause', async () => {
  const raw = '{';
  const { client } = fakeClient(raw);
  const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const answer = askForJson(prompt, schema, client);

  await expect(answer).rejects.toHaveProperty('message', 'AI response was not valid JSON');
  await expect(answer).rejects.toHaveProperty('cause', expect.any(SyntaxError));
  expect(logError).toHaveBeenCalledExactlyOnceWith(
    '❌ Failed to parse AI response:', expect.any(SyntaxError), raw,
  );
});

test.each([
  { description: 'missing response content', content: null },
  { description: 'missing choice', content: undefined },
])('openaiLookup preserves $description failures', async ({ content }) => {
  fakeClient(content);
  const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  await expect(openaiLookup('casa')).rejects.toHaveProperty('message', 'AI response was not valid JSON');
  expect(logError).not.toHaveBeenCalled();
});

test('openaiLookup preserves invalid JSON failures without logging twice', async () => {
  fakeClient('{');
  const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const answer = openaiLookup('casa');

  await expect(answer).rejects.toHaveProperty('message', 'AI response was not valid JSON');
  await expect(answer).rejects.toHaveProperty('cause', expect.any(SyntaxError));
  expect(logError).toHaveBeenCalledExactlyOnceWith(
    '❌ Failed to parse AI response:', expect.any(SyntaxError), '{',
  );
});

test.each([
  new Error('OpenAI returned HTTP 503: Service Unavailable'),
  'OpenAI request timed out',
])('openaiLookup rethrows the observed service failure unchanged: %s', async (failure) => {
  const { create } = fakeClient(null);
  create.mockRejectedValueOnce(failure);
  const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  await expect(openaiLookup('casa')).rejects.toBe(failure);
  expect(logError).not.toHaveBeenCalled();
});

test('askForJson rethrows non-Zod schema failures unchanged', async () => {
  const { client } = fakeClient('{"items":[]}');
  const failure = new Error('Schema transform failed');
  const failingSchema = schema.transform(() => { throw failure; });
  const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  await expect(askForJson(prompt, failingSchema, client)).rejects.toBe(failure);
  expect(logError).not.toHaveBeenCalled();
});

test('looks up a word through JSON mode using the environment key and word schema', async () => {
  const wordInfo = {
    english: 'house', spanish: 'casa', gender: 'feminine', article: 'la', type: 'noun',
    example: null, conjugations: null,
  } satisfies z.infer<typeof WordInfoSchema>;
  const { create } = fakeClient(JSON.stringify(wordInfo));
  vi.mocked(OpenAI).mockClear();

  await expect(openaiLookup('casa')).resolves.toEqual(wordInfo);

  expect(OpenAI).toHaveBeenLastCalledWith({ apiKey: 'test-key' });
  expect(create).toHaveBeenCalledOnce();
  const request = create.mock.calls[0]?.[0];
  expect(request).toMatchObject({
    model: loadConfig().aiOptions?.model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
  });
  expect(request?.messages).toHaveLength(1);
  expect(request?.messages[0]?.role).toBe('user');
  expect(request?.messages[0]?.content).toContain('Return ONLY a JSON object');
  expect(request?.messages[0]?.content).not.toContain('Respond with a single JSON object.');
});
