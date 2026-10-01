import { localDateStamp } from "./time";
import { ADJECTIVES, NOUNS } from "./words";

export const ID_PATTERN = /^\d{8}-[a-z]+-[a-z]+$/;
export const ID_WORDS_PATTERN = /^[a-z]+-[a-z]+$/;

const DATE_PREFIX_LENGTH = "YYYYMMDD-".length;

export function generateId(now: Date, random: () => number): string {
  const pick = (words: string[]) => words[Math.floor(random() * words.length)];
  return `${localDateStamp(now)}-${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}

export function idWords(id: string): string {
  return id.slice(DATE_PREFIX_LENGTH);
}
