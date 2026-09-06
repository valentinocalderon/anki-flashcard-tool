import type { Card, WordInfo } from '@/lib/types';
import { openaiLookup } from './aiLookup';
import { generateCards } from './cardGenerator';


export class FlashcardGenerationService {
  /**
   * Main interface for flashcard generation - this is what the router calls
   */
  static async generateFlashcard(word: string): Promise<[WordInfo, Card[]]> {
    // Get the raw data from the AI
    const rawData: WordInfo = await openaiLookup(word);

    // Generate the flashcards
    const flashcards: Card[] = generateCards(rawData);
    
    return [rawData, flashcards];
  }

  
} 