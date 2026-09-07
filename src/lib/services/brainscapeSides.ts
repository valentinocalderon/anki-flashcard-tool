import { normalizeQuery } from './lookupCache';

export type BrainscapeItem = {
  forms: { spanish: string; query: string }[];
};

export function spanishSideItems(side: string): BrainscapeItem[] {
  const text = side.replace(/(?<!\S)(?:Man|Woman|Hombre|Mujer):\s*/gi, '');
  const forms = text.split('/').map((form, index) => {
    const spanish = form.trim();
    if (!spanish) {
      throw new Error(`Spanish side "${side}" has an empty form at position ${index + 1}; check the Brainscape text.`);
    }
    return { spanish, query: normalizeQuery(spanish) };
  });

  return [{ forms }];
}
