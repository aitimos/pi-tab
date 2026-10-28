import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';

test('IDs work with only the crypto API exposed on insecure HTTP pages', async () => {
  const source=await readFile(new URL('../src/id.js',import.meta.url),'utf8');
  const crypto={getRandomValues:webcrypto.getRandomValues.bind(webcrypto)};
  const createId=runInNewContext(source.replace('export ','')+';createId',{crypto});
  const ids=Array.from({length:1000},()=>createId());
  assert.equal(new Set(ids).size,1000);
  for(const id of ids)assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(Object.keys(crypto),['getRandomValues']);
});
