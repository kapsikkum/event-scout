import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The server and the crawler each carry a copy of shared/. See its README.
const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, '../src/shared');
const crawler = path.resolve(here, '../../crawler/src/shared');
const read = (dir: string, name: string): string => fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n');

test('the server and the crawler share identical copies of shared/', () => {
  const names = fs.readdirSync(server).sort();
  assert.deepEqual(fs.readdirSync(crawler).sort(), names, 'the same files in both');
  for (const name of names) {
    assert.equal(read(crawler, name), read(server, name), `${name} differs: cp server/src/shared/* crawler/src/shared/`);
  }
});
