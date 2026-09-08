import { env } from '@/env';
import type { AppConfig } from '@/lib/config';

export function createSpanishVoice(
  { capCharacters }: AppConfig['audio'],
  fetchImpl: typeof fetch,
) {
  let dispatchedCharacters = 0;
  let capReached = false;

  return {
    get dispatchedCharacters(): number {
      return dispatchedCharacters;
    },
    get capReached(): boolean {
      return capReached;
    },
    async synthesize(text: string): Promise<Uint8Array | undefined> {
      if (capReached) return undefined;

      const nextCharacters = dispatchedCharacters + text.length;
      if (nextCharacters > capCharacters) {
        capReached = true;
        return undefined;
      }

      // Count before awaiting: pending and failed requests have still been dispatched.
      dispatchedCharacters = nextCharacters;
      const response = await fetchImpl(
        `https://api.elevenlabs.io/v1/text-to-speech/${env.ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
        },
      );
      if (!response.ok) {
        let body: string;
        try {
          body = await response.text();
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          throw new Error(`ElevenLabs request returned HTTP ${response.status}; reading its body failed: ${message}; inspect the response before retrying.`, { cause });
        }
        throw new Error(`ElevenLabs request returned HTTP ${response.status}: ${body}; check the response before retrying.`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
