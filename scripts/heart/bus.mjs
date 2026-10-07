// Append-only event bus shared by the pipeline steps and the dashboard server.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const EVENTS = new URL('../../.tmp/heart/events.jsonl', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

export function emit(event) {
  const line = JSON.stringify({ t: Date.now(), ...event });
  mkdirSync(dirname(EVENTS), { recursive: true });
  appendFileSync(EVENTS, line + '\n');
}
