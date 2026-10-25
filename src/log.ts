import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let stream: fs.WriteStream | null = null;
if (config.logDir) {
  fs.mkdirSync(config.logDir, { recursive: true });
  stream = fs.createWriteStream(path.join(config.logDir, 'server.log'), { flags: 'a' });
}

// Callers pass only non-sensitive text; never tokens, passwords or request bodies.
export function log(level: 'info' | 'warn' | 'error', msg: string) {
  const line = `${new Date().toISOString()} ${level} ${msg}`;
  (level === 'error' ? console.error : console.log)(line);
  stream?.write(line + '\n');
}
