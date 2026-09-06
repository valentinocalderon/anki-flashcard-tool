import type { Card, WordInfo } from '@/lib/types';
import { getDb } from '@/server/db';
import { openaiLookup } from './aiLookup';
import { generateCards } from './cardGenerator';
import { cachedLookup } from './lookupCache';


export class FlashcardGenerationService {
  /**
   * Main interface for flashcard generation - this is what the router calls
   */
  static async generateFlashcard(word: string): Promise<[WordInfo, Card[]]> {
    // Get the raw data from the AI
    const rawData: WordInfo = await cachedLookup(await getDb(), word, openaiLookup);

    // Generate the flashcards
    const flashcards: Card[] = generateCards(rawData);
    
    return [rawData, flashcards];
  }

  
} 
