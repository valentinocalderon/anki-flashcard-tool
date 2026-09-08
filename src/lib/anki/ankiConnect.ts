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
    action: 'createDeck' | 'storeMediaFile' | 'addNotes' | 'updateNoteFields' | 'sync',
    params: Record<string, unknown>,
    resultSchema: z.ZodType<T>
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, version: 6, params }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (typeof cause === 'object' && cause !== null && 'name' in cause && cause.name === 'TimeoutError') {
        throw new AnkiUnreachableError(`AnkiConnect request timed out: ${message}`, { cause });
      }
      throw new AnkiUnreachableError(
        `Anki is not running or cannot be reached. Open Anki and try again. AnkiConnect request failed: ${message}`,
        { cause },
      );
    }
    if (!response.ok) {
      throw new AnkiConnectError(`AnkiConnect returned HTTP ${response.status} ${response.statusText}`);
    }

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new AnkiUnreachableError(`AnkiConnect response (HTTP ${response.status}) could not be read: ${message}`, { cause });
    }

    const payload = responseSchema.parse(responseBody);
    if (payload.error !== null) throw new AnkiConnectError(payload.error);
    return resultSchema.parse(payload.result);
  }

  return {
    createDeck(name: string): Promise<number> {
      return invoke('createDeck', { deck: name }, z.number());
    },
    storeMediaFile(filename: string, audioMp3: Uint8Array): Promise<string> {
      return invoke('storeMediaFile', { filename, data: Buffer.from(audioMp3).toString('base64') }, z.string().min(1));
    },
    addNotes(notes: AnkiNote[]): Promise<(number | null)[]> {
      return invoke('addNotes', { notes }, z.array(z.number().nullable()));
    },
    async updateNoteFields(id: number, fields: Record<string, string>): Promise<void> {
      await invoke('updateNoteFields', { note: { id, fields } }, z.null());
    },
    async sync(): Promise<void> {
      await invoke('sync', {}, z.null());
    },
  };
}

export type AnkiClient = ReturnType<typeof createAnkiClient>;
