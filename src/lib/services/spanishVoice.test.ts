import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { configSchema, loadConfig } from '@/lib/config';
import { createSpanishVoice } from './spanishVoice';

vi.mock('@/env', () => ({
  env: { ELEVENLABS_API_KEY: 'test-api-key', ELEVENLABS_VOICE_ID: 'test-voice-id' },
}));

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('Unexpected global fetch; inject a test fetch.');
  }));
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('validates the configured character cap with the existing config schema', () => {
  expect(loadConfig().audio).toEqual({ capCharacters: 30000 });
  expect(configSchema.parse(loadConfig()).audio).toEqual({ capCharacters: 30000 });
  expect(configSchema.parse({
    ...loadConfig(), audio: { capCharacters: 1 },
  }).audio).toEqual({ capCharacters: 1 });
});

test.each([
  undefined,
  null,
  {},
  { capCharacters: 0 },
  { capCharacters: -1 },
  { capCharacters: 1.5 },
  { capCharacters: Infinity },
  { capCharacters: NaN },
  { capCharacters: '30000' },
])('rejects a missing or invalid audio character cap: %j', (audio) => {
  expect(configSchema.safeParse({ ...loadConfig(), audio }).success).toBe(false);
});

test('posts the locked request with env credentials and returns the response bytes', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
    new Response(new Uint8Array([73, 68, 51, 0, 255])),
  );
  const voice = createSpanishVoice({ capCharacters: 30000 }, fetchImpl);

  expect(voice.dispatchedCharacters).toBe(0);
  expect(voice.capReached).toBe(false);
  expect(await voice.synthesize('¡Sí!')).toEqual(new Uint8Array([73, 68, 51, 0, 255]));
  expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
    'https://api.elevenlabs.io/v1/text-to-speech/test-voice-id?output_format=mp3_44100_128',
    {
      method: 'POST',
      headers: { 'xi-api-key': 'test-api-key', 'Content-Type': 'application/json' },
      body: '{"text":"¡Sí!","model_id":"eleven_multilingual_v2"}',
    },
  );
  expect(voice.dispatchedCharacters).toBe(4);
  expect(voice.capReached).toBe(false);
});

test('accumulates dispatched characters across requests', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response());
  const voice = createSpanishVoice({ capCharacters: 20 }, fetchImpl);

  await voice.synthesize('hola');
  expect(voice.dispatchedCharacters).toBe(4);
  await voice.synthesize('adiós');
  expect(voice.dispatchedCharacters).toBe(9);
  expect(voice.capReached).toBe(false);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

test('never sends a crossing request and keeps the cap sticky for shorter text', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response());
  const voice = createSpanishVoice({ capCharacters: 5 }, fetchImpl);

  await voice.synthesize('hola');
  expect(await voice.synthesize('sí')).toBeUndefined();
  expect(voice.dispatchedCharacters).toBe(4);
  expect(voice.capReached).toBe(true);
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(await voice.synthesize('a')).toBeUndefined();
  expect(voice.dispatchedCharacters).toBe(4);
  expect(voice.capReached).toBe(true);
  expect(fetchImpl).toHaveBeenCalledOnce();
});

test('caps an oversized first request while a separate run starts with its own count', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response());
  const audio = { capCharacters: 5 };
  const first = createSpanishVoice(audio, fetchImpl);

  expect(await first.synthesize('buenos días')).toBeUndefined();
  expect(first.dispatchedCharacters).toBe(0);
  expect(first.capReached).toBe(true);
  expect(fetchImpl).not.toHaveBeenCalled();
  const second = createSpanishVoice(audio, fetchImpl);
  expect(second.dispatchedCharacters).toBe(0);
  expect(second.capReached).toBe(false);
  expect(await second.synthesize('a')).toEqual(new Uint8Array([]));
  expect(second.dispatchedCharacters).toBe(1);
  expect(second.capReached).toBe(false);
  expect(first.dispatchedCharacters).toBe(0);
  expect(first.capReached).toBe(true);
});

test('allows exactly the character cap, then refuses the next character', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response());
  const voice = createSpanishVoice({ capCharacters: 5 }, fetchImpl);

  expect(await voice.synthesize('sí')).toEqual(new Uint8Array([]));
  expect(await voice.synthesize('sol')).toEqual(new Uint8Array([]));
  expect(voice.dispatchedCharacters).toBe(5);
  expect(voice.capReached).toBe(false);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(await voice.synthesize('a')).toBeUndefined();
  expect(voice.dispatchedCharacters).toBe(5);
  expect(voice.capReached).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

test('counts a dispatched request before awaiting it so another request cannot cross the cap', async () => {
  let finish: (response: Response) => void = () => { throw new Error('Fetch was not called'); };
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>((resolve) => {
    finish = resolve;
  }));
  const voice = createSpanishVoice({ capCharacters: 5 }, fetchImpl);

  const pending = voice.synthesize('hola');
  expect(voice.dispatchedCharacters).toBe(4);
  expect(await voice.synthesize('sí')).toBeUndefined();
  expect(voice.capReached).toBe(true);
  expect(fetchImpl).toHaveBeenCalledOnce();
  finish(new Response(new Uint8Array([73, 68, 51])));
  expect(await pending).toEqual(new Uint8Array([73, 68, 51]));
  expect(voice.dispatchedCharacters).toBe(4);
  expect(voice.capReached).toBe(true);
});

test.each([
  { status: 401, body: '{"detail":"invalid_api_key"}', message: 'ElevenLabs request returned HTTP 401: {"detail":"invalid_api_key"}; check the response before retrying.' },
  { status: 429, body: 'Too many requests', message: 'ElevenLabs request returned HTTP 429: Too many requests; check the response before retrying.' },
  { status: 503, body: '', message: 'ElevenLabs request returned HTTP 503: ; check the response before retrying.' },
])('reports the observed HTTP $status and body without reducing the dispatched count', async ({ status, body, message }) => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(body, { status }));
  const voice = createSpanishVoice({ capCharacters: 5 }, fetchImpl);

  await expect(voice.synthesize('hola')).rejects.toThrow(message);
  expect(voice.dispatchedCharacters).toBe(4);
  expect(voice.capReached).toBe(false);
  expect(await voice.synthesize('sí')).toBeUndefined();
  expect(voice.dispatchedCharacters).toBe(4);
  expect(voice.capReached).toBe(true);
  expect(fetchImpl).toHaveBeenCalledOnce();
});

test('preserves a fetch rejection and counts the attempted request', async () => {
  const failure = new TypeError('fetch failed');
  const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(failure);
  const voice = createSpanishVoice({ capCharacters: 20 }, fetchImpl);

  await expect(voice.synthesize('hola')).rejects.toBe(failure);
  expect(voice.dispatchedCharacters).toBe(4);
  expect(voice.capReached).toBe(false);
  expect(fetchImpl).toHaveBeenCalledOnce();
});

test('preserves an mp3 body read failure and its dispatched count', async () => {
  const failure = new Error('response stream interrupted');
  const response = new Response();
  vi.spyOn(response, 'arrayBuffer').mockRejectedValueOnce(failure);
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
  const voice = createSpanishVoice({ capCharacters: 20 }, fetchImpl);

  await expect(voice.synthesize('hola')).rejects.toBe(failure);
  expect(voice.dispatchedCharacters).toBe(4);
  expect(voice.capReached).toBe(false);
  expect(fetchImpl).toHaveBeenCalledOnce();
});

test('reports the observed status and read error when an HTTP error body cannot be read', async () => {
  const failure = new Error('response stream interrupted');
  const response = new Response('', { status: 503 });
  vi.spyOn(response, 'text').mockRejectedValueOnce(failure);
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
  const voice = createSpanishVoice({ capCharacters: 20 }, fetchImpl);

  const result = voice.synthesize('hola');
  await expect(result).rejects.toThrow('ElevenLabs request returned HTTP 503; reading its body failed: response stream interrupted; inspect the response before retrying.');
  await expect(result).rejects.toHaveProperty('cause', failure);
  expect(voice.dispatchedCharacters).toBe(4);
  expect(voice.capReached).toBe(false);
  expect(fetchImpl).toHaveBeenCalledOnce();
});
