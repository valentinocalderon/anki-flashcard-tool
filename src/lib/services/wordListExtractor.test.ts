import { expect, test, vi } from 'vitest';
import { extractItems, type AskForJson } from './wordListExtractor';

test('requests vocabulary as JSON with the items schema and cleans the returned items', async () => {
  const text = 'I want to study casa, por favor and árbol.';
  const request = vi.fn<(prompt: string) => void>();
  const ask: AskForJson = async (prompt, schema) => {
    request(prompt);
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('{ items: string[] }');
    expect(prompt).toContain('vocabulary items');
    expect(prompt).toContain('one entry per word or phrase');
    expect(prompt).toContain('no translations');
    expect(prompt).toContain('no explanations');
    expect(prompt).toContain(text);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ items: 'casa' }).success).toBe(false);
    expect(schema.safeParse({ items: [42] }).success).toBe(false);
    return schema.parse({
      items: [' Casa ', '', ' \t\n ', 'CASA', ' por favor ', 'Por Favor', ' Árbol\n', 'árbol', 'sí, claro'],
    });
  };

  await expect(extractItems(text, ask)).resolves.toEqual(['Casa', 'por favor', 'Árbol', 'sí, claro']);
  expect(request).toHaveBeenCalledOnce();
});

test.each([{ items: [] }, { items: ['', ' \n\t '] }])('returns an empty list when extraction yields no nonblank items: $items', async ({ items }) => {
  const request = vi.fn<(prompt: string) => void>();
  const ask: AskForJson = async (prompt, schema) => {
    request(prompt);
    return schema.parse({ items });
  };

  await expect(extractItems('Nothing to study here.', ask)).resolves.toEqual([]);
  expect(request).toHaveBeenCalledOnce();
});

test('propagates request failures', async () => {
  const error = new Error('Extraction unavailable; retry later.');
  const request = vi.fn<(prompt: string) => void>();
  const ask: AskForJson = async (prompt) => {
    request(prompt);
    throw error;
  };

  await expect(extractItems('casa hablar', ask)).rejects.toBe(error);
  expect(request).toHaveBeenCalledOnce();
});
