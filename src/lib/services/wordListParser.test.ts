import { expect, test, vi } from 'vitest';
import type { AskForJson } from './wordListExtractor';
import { resolveWordList, splitByDelimiters } from './wordListParser';

test.each([
  { name: 'lines', text: ' casa\r\nhablar\rárbol\npor favor ', expected: ['casa', 'hablar', 'árbol', 'por favor'] },
  { name: 'commas', text: 'casa, hablar,árbol', expected: ['casa', 'hablar', 'árbol'] },
  { name: 'semicolons', text: 'casa; hablar;árbol', expected: ['casa', 'hablar', 'árbol'] },
  { name: 'bullets', text: ' - casa\n*hablar\n• árbol', expected: ['casa', 'hablar', 'árbol'] },
  { name: 'numbering', text: '1. casa\n2)hablar\n23. árbol', expected: ['casa', 'hablar', 'árbol'] },
  { name: 'mixed separators', text: '- casa, 2) hablar; • árbol\n* por favor', expected: ['casa', 'hablar', 'árbol', 'por favor'] },
  { name: 'blank pieces', text: ' \r\n\t, ; - ; * ; • ; 1. ; 2) ', expected: [] },
  { name: 'dedupe keeping first spelling', text: ' Casa, CASA; casa\nÁrbol; árbol, Por Favor; por favor', expected: ['Casa', 'Árbol', 'Por Favor'] },
  { name: 'phrases in a comma list', text: 'por favor, buenos días, hasta luego', expected: ['por favor', 'buenos días', 'hasta luego'] },
  { name: 'internal punctuation', text: 'well-being, a * b, siglo 2)', expected: ['well-being', 'a * b', 'siglo 2)'] },
])('splits $name', ({ text, expected }) => {
  expect(splitByDelimiters(text)).toEqual(expected);
});

test.each([
  'casa hablar árbol',
  'I want to study casa and por favor.',
  'casa\thablar',
  '  - por favor  ',
  'por favor, POR FAVOR',
])('extracts exactly once when the split leaves one item containing whitespace: %s', async (text) => {
  const request = vi.fn<(prompt: string) => void>();
  const ask: AskForJson = async (prompt, schema) => {
    request(prompt);
    expect(prompt).toContain(text);
    return schema.parse({ items: [' casa ', 'por favor'] });
  };

  await expect(resolveWordList(text, ask)).resolves.toEqual(['casa', 'por favor']);
  expect(request).toHaveBeenCalledOnce();
});

test.each([
  { text: '', expected: [] },
  { text: ' \n,;\t ', expected: [] },
  { text: ' casa ', expected: ['casa'] },
  { text: 'casa, CASA', expected: ['casa'] },
  { text: 'casa\nhablar', expected: ['casa', 'hablar'] },
  { text: 'por favor, buenos días', expected: ['por favor', 'buenos días'] },
  { text: 'por favor; buenos días', expected: ['por favor', 'buenos días'] },
  { text: 'por favor\nbuenos días', expected: ['por favor', 'buenos días'] },
])('uses the split without extraction for $text', async ({ text, expected }) => {
  const request = vi.fn<(prompt: string) => void>();
  const ask: AskForJson = async (prompt) => {
    request(prompt);
    throw new Error('Unexpected extraction request');
  };

  await expect(resolveWordList(text, ask)).resolves.toEqual(expected);
  expect(request).not.toHaveBeenCalled();
});

test('propagates an extraction failure without returning the unsplit text', async () => {
  const error = new Error('Extraction failed; retry the request.');
  const request = vi.fn<(prompt: string) => void>();
  const ask: AskForJson = async (prompt) => {
    request(prompt);
    throw error;
  };

  await expect(resolveWordList('casa hablar', ask)).rejects.toBe(error);
  expect(request).toHaveBeenCalledOnce();
});
