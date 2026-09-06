import { z } from 'zod';

export class AnkiUnreachableError extends Error {
  override name = 'AnkiUnreachableError';
}

export class AnkiConnectError extends Error {
  override name = 'AnkiConnectError';
}

export type AnkiNote = {
  deckName: string;
  modelName: string;
  fields: { Front: string; Back: string };
  tags: string[];
  options: { allowDuplicate: false; duplicateScope: 'deck' };
};

const responseSchema = z.object({
  result: z.unknown(),
  error: z.string().nullable(),
});

export function createAnkiClient(url: string, fetchImpl: typeof fetch = fetch) {
  async function invoke<T>(
    action: 'createDeck' | 'addNotes' | 'sync',
    params: Record<string, unknown>,
    resultSchema: z.ZodType<T>
  ): Promise<T> {
    let responseBody: unknown;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, version: 6, params }),
        signal: AbortSignal.timeout(15000),
      });
      responseBody = await response.json();
    } catch (cause) {
      throw new AnkiUnreachableError('Anki is not running', { cause });
    }

    const payload = responseSchema.parse(responseBody);
    if (payload.error !== null) throw new AnkiConnectError(payload.error);
    return resultSchema.parse(payload.result);
  }

  return {
    createDeck(name: string): Promise<number> {
      return invoke('createDeck', { deck: name }, z.number());
    },
    addNotes(notes: AnkiNote[]): Promise<(number | null)[]> {
      return invoke('addNotes', { notes }, z.array(z.number().nullable()));
    },
    async sync(): Promise<void> {
      await invoke('sync', {}, z.null());
    },
  };
}

export type AnkiClient = ReturnType<typeof createAnkiClient>;
