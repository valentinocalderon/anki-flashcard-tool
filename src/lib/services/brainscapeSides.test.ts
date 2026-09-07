import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { spanishSides } from './brainscapePack';
import { spanishSideItems } from './brainscapeSides';

const greetings = spanishSides(readFileSync(new URL('./__fixtures__/brainscape/deck-common-greetings.html', import.meta.url), 'utf8'));
const nouns = spanishSides(readFileSync(new URL('./__fixtures__/brainscape/deck-nouns-articles.html', import.meta.url), 'utf8'));

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('Unexpected global fetch; tests must use saved fixtures.');
  }));
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

test.each([
  {
    name: 'greetings',
    sides: greetings,
    items: [
      [{ forms: [{ spanish: '¡Hola!', query: '¡hola!' }] }],
      [{ forms: [
        { spanish: '¡Adiós!', query: '¡adiós!' },
        { spanish: '¡Chao!', query: '¡chao!' },
      ] }],
      [{ forms: [{ spanish: '¡Buenos días!', query: '¡buenos días!' }] }],
      [{ forms: [{ spanish: '¡Buenas tardes!', query: '¡buenas tardes!' }] }],
      [{ forms: [{ spanish: '¡Buenas!', query: '¡buenas!' }] }],
      [{ forms: [{ spanish: '¿Hablas inglés?', query: '¿hablas inglés?' }] }],
      [{ forms: [{ spanish: 'Hablo inglés.', query: 'hablo inglés.' }] }],
      [{ forms: [{ spanish: 'No hablo español.', query: 'no hablo español.' }] }],
      [{ forms: [{ spanish: '¡Gracias! ¡De nada!', query: '¡gracias! ¡de nada!' }] }],
      [{ forms: [{ spanish: '¡Buenas noches!', query: '¡buenas noches!' }] }],
      [{ forms: [{ spanish: '¿Habla inglés? Sí.', query: '¿habla inglés? sí.' }] }],
      [{ forms: [{ spanish: 'Hola, me llamo Sam.', query: 'hola, me llamo sam.' }] }],
      [{ forms: [{ spanish: '¿Cómo te llamas?', query: '¿cómo te llamas?' }] }],
      [{ forms: [{ spanish: '¿Habla español? Un poco.', query: '¿habla español? un poco.' }] }],
      [{ forms: [{ spanish: '¡Mucho gusto!', query: '¡mucho gusto!' }] }],
      [{ forms: [
        { spanish: 'Igualmente.', query: 'igualmente.' },
        { spanish: 'Igual.', query: 'igual.' },
      ] }],
      [{ forms: [{
        spanish: '¿Cómo te llamas? Me llamo Jenny. Mucho gusto. ¡Igual!',
        query: '¿cómo te llamas? me llamo jenny. mucho gusto. ¡igual!',
      }] }],
    ],
  },
  {
    name: 'nouns and articles',
    sides: nouns,
    items: [
      [{ forms: [{ spanish: 'una mujer', query: 'una mujer' }] }],
      [{ forms: [{ spanish: 'un hombre', query: 'un hombre' }] }],
      [{ forms: [{ spanish: 'la mujer', query: 'la mujer' }] }],
      [{ forms: [{ spanish: 'el hombre', query: 'el hombre' }] }],
      [{ forms: [
        { spanish: 'un muchacho', query: 'un muchacho' },
        { spanish: 'un chico', query: 'un chico' },
      ] }],
      [{ forms: [
        { spanish: 'la muchacha', query: 'la muchacha' },
        { spanish: 'la chica', query: 'la chica' },
      ] }],
      [{ forms: [{ spanish: 'un niño', query: 'un niño' }] }],
      [{ forms: [{ spanish: 'una niña', query: 'una niña' }] }],
      [{ forms: [{ spanish: 'los niños', query: 'los niños' }] }],
      [{ forms: [{ spanish: 'las niñas', query: 'las niñas' }] }],
      [{ forms: [{ spanish: 'unos hombres', query: 'unos hombres' }] }],
      [{ forms: [{ spanish: 'unas mujeres', query: 'unas mujeres' }] }],
      [{ forms: [{ spanish: 'un chico y una chica', query: 'un chico y una chica' }] }],
      [{ forms: [{ spanish: 'los hombres y las mujeres', query: 'los hombres y las mujeres' }] }],
      [{ forms: [
        { spanish: 'una alumna', query: 'una alumna' },
        { spanish: 'una estudiante', query: 'una estudiante' },
      ] }],
      [{ forms: [
        { spanish: 'un profesor', query: 'un profesor' },
        { spanish: 'un maestro', query: 'un maestro' },
      ] }],
      [{ forms: [{ spanish: 'una profesora', query: 'una profesora' }] }],
      [{ forms: [{ spanish: 'la casa', query: 'la casa' }] }],
      [{ forms: [{ spanish: 'el dinero', query: 'el dinero' }] }],
      [{ forms: [
        { spanish: 'los carros', query: 'los carros' },
        { spanish: 'los coches', query: 'los coches' },
      ] }],
    ],
  },
])('keeps one item per $name fixture side, with ordered forms and whole dialogues', ({ sides, items }) => {
  expect(sides.map(spanishSideItems)).toEqual(items);
});

test('keeps each alternative addressable, trimming its display text and normalizing its query', () => {
  const side = greetings.find((text) => text === '¡Adiós! / ¡Chao!');
  expect(side).toBeDefined();

  expect(spanishSideItems(` \t${side?.toUpperCase().replace(' / ', '/\t')} \n`)).toEqual([{
    forms: [
      { spanish: '¡ADIÓS!', query: '¡adiós!' },
      { spanish: '¡CHAO!', query: '¡chao!' },
    ],
  }]);
});

test('strips English speaker labels regardless of case without splitting the exchange', () => {
  const side = greetings.find((text) => text === 'Man: ¡Gracias! Woman: ¡De nada!');
  expect(side).toBeDefined();

  expect(spanishSideItems(` ${side?.toLowerCase()} `)).toEqual([{
    forms: [{ spanish: '¡gracias! ¡de nada!', query: '¡gracias! ¡de nada!' }],
  }]);
});

test('preserves Spanish words and colons that are not standalone speaker labels', () => {
  expect(spanishSideItems('Una mujer dice: ¡Hola! Superwoman: ¡Buenas!')).toEqual([{
    forms: [{
      spanish: 'Una mujer dice: ¡Hola! Superwoman: ¡Buenas!',
      query: 'una mujer dice: ¡hola! superwoman: ¡buenas!',
    }],
  }]);
});

test.each([
  { side: '', position: 1 },
  { side: ' \n\t ', position: 1 },
  { side: 'Man: Woman:', position: 1 },
  { side: 'Hombre: Mujer:', position: 1 },
  { side: '/ ¡Hola!', position: 1 },
  { side: '¡Hola! /', position: 2 },
  { side: '¡Hola! / / ¡Chao!', position: 2 },
])('reports the observed empty form and side: $side', ({ side, position }) => {
  expect(() => spanishSideItems(side)).toThrow(new Error(
    `Spanish side "${side}" has an empty form at position ${position}; check the Brainscape text.`,
  ));
});
