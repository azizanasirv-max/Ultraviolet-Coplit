import { Role } from './lib/aiSession';

export interface TranscriptEntry {
  ordinal: number;
  speaker: Role;
  text: string;
  isFinal: boolean;
}
