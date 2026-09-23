import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The server and the crawler each carry a copy of shared/. See its README.
const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, '../src/shared');
const crawler = path.resolve(here, '../../crawler/src/shared');

test('the server and the crawler share byte-identical copies of shared/', () => {
  const serverFiles = fs.readdirSync(server).sort();
  const crawlerFiles = fs.readdirSync(crawler).sort();
  assert.deepEqual(crawlerFiles, serverFiles, 'the same files in both');
  for (const name of serverFiles) {
    const sBuf = fs.readFileSync(path.join(server, name));
    const cBuf = fs.readFileSync(path.join(crawler, name));
    assert.ok(sBuf.equals(cBuf), `${name} differs byte-for-byte`);
  }
});
