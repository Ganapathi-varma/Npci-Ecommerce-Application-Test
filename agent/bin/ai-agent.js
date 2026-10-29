#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => { console.error(`ai-agent: ${err.message}`); process.exitCode = 3; },
);
