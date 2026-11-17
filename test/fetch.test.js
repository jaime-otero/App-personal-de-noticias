import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchText } from '../scripts/ingest/fetch.js';
import { readFeed } from '../scripts/ingest/parse.js';

const src = { id: 'test', name: 'Test', lang: 'en', sections: [] };
const fake = (status, body = '', headers = {}) => async () => new Response(status === 204 ? null : body, { status, headers });

test('fetchText returns the body only on a plain 200', async () => {
  assert.equal(await fetchText('https://ex.com/rss', fake(200, '<rss/>')), '<rss/>');
});

test('fetchText rejects the empty 202 of an anti-bot challenge and other non-200 answers', async () => {
  await assert.rejects(fetchText('https://ex.com/rss', fake(202, '', { 'x-amzn-waf-action': 'challenge' })), /HTTP 202 \(WAF: challenge\)/);
  await assert.rejects(fetchText('https://ex.com/rss', fake(204)), /HTTP 204/);
  await assert.rejects(fetchText('https://ex.com/rss', fake(403, 'Forbidden')), /HTTP 403/);
});

test('readFeed: an empty or non-XML body is an error, a real empty feed is not', () => {
  assert.throws(() => readFeed('', src), /vacía/);
  assert.throws(() => readFeed('  \n', src), /vacía/);
  assert.throws(() => readFeed('<!doctype html><html><body>Hola</body></html>', src), /no es un feed/);
  assert.throws(() => readFeed('{"articles": []}', src), /no es un feed/);
  assert.deepEqual(readFeed('<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>', src), []);
  assert.deepEqual(readFeed('<feed xmlns="http://www.w3.org/2005/Atom"><title>x</title></feed>', src), []);
  const xml = '﻿<?xml version="1.0"?>\n<!-- c --><rss><channel><item><title>T</title><link>https://ex.com/a</link></item></channel></rss>';
  assert.equal(readFeed(xml, src).length, 1);
});
