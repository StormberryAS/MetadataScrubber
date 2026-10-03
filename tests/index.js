// Lets "node --test tests/" run every *.test.mjs file in this folder. Node 24 treats a
// directory argument as a module path, so it loads this file, which loads the tests.
import { readdirSync } from 'node:fs';

const here = new URL('./', import.meta.url);
for (const name of readdirSync(here).filter((n) => n.endsWith('.test.mjs')).sort()) {
  await import(new URL(name, here));
}
