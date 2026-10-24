import { Role } from 'ultravox-client';

export interface TranscriptEntry {
  ordinal: number;
  speaker: Role;
  text: string;
  isFinal: boolean;
}
