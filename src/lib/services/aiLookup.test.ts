import OpenAI from 'openai';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '@/lib/config';
import type { WordInfoSchema } from '@/lib/types';
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

  await expect(askForJson(prompt, schema, client)).rejects.toThrow(
    /AI response did not match the expected shape:.*"path":\["items"\]/,
  );
  expect(logError).toHaveBeenCalledExactlyOnceWith(
    '❌ AI response did not match the expected shape:', expect.any(Array), raw,
  );
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
