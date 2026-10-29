// Small shared helpers: process execution without a shell, secret redaction, truncation.
import { execFile } from 'node:child_process';

/** Runs a program with an argv array (never through a shell). Resolves, never rejects. */
export function run(file, args, { timeoutMs = 20000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? '') || (error && !stdout ? String(error.message) : ''),
      });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

const REDACTIONS = [
  [/(authorization:\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]'],
  [/\bbearer\s+[A-Za-z0-9._~+\/-]{16,}/gi, 'Bearer [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED_API_KEY]'],
  [/\bdckr_pat_[A-Za-z0-9_-]{8,}/g, '[REDACTED_TOKEN]'],
  [/\b(password|passwd|secret|token|api[_-]?key|apikey)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2[REDACTED]'],
];

/** Removes credentials from text before it is shown, saved or sent to a model. */
export function redact(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

export function tail(text, lines) {
  const all = String(text ?? '').split('\n');
  return all.slice(Math.max(0, all.length - lines)).join('\n').trim();
}

export function truncate(text, max = 300) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Kubernetes object names (DNS-1123 subdomain). Used to validate anything that ends up in a command. */
export const K8S_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
