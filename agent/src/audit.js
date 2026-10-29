// Append-only JSONL audit trail of everything the agent proposed, was approved to do, and did.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeAudit(file) {
  const target = file ?? path.join(os.homedir(), '.ai-agent', 'audit.log');
  return {
    file: target,
    record(event, data = {}) {
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        const line = JSON.stringify({ time: new Date().toISOString(), user: os.userInfo().username, event, ...data });
        fs.appendFileSync(target, line + '\n', { mode: 0o600 });
      } catch { /* auditing must never break a diagnosis */ }
    },
  };
}
