import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demoReplyText, firstPostText, maxWeightedLength, measureText } from '../src/textRules.js';

test('the prefilled first post and demo reply fit within X’s weighted limit', () => {
  const post = measureText(firstPostText);
  assert.equal(post.valid, true);
  assert.equal(post.weightedLength, 185);

  const reply = measureText(demoReplyText);
  assert.equal(reply.valid, true);
  assert.ok(reply.weightedLength < maxWeightedLength);
});

test('URLs weigh 23 regardless of their real length', () => {
  const short = measureText('See https://x.com/a');
  const long = measureText('See https://junie.jetbrains.com/blog/demo-agent/with/a/very/long/path?and=query#fragment');
  assert.equal(short.weightedLength, long.weightedLength);
  assert.equal(long.weightedLength, 'See '.length + 23);
});

test('emoji and wide characters weigh two, basic Latin weighs one', () => {
  assert.equal(measureText('a').weightedLength, 1);
  assert.equal(measureText('🚀').weightedLength, 2);
  assert.equal(measureText('日本').weightedLength, 4);
  assert.equal(measureText('a'.repeat(280)).valid, true);
  assert.equal(measureText('a'.repeat(281)).valid, false);
  assert.equal(measureText('🚀'.repeat(140)).valid, true);
  assert.equal(measureText('🚀'.repeat(141)).valid, false);
});

test('empty, whitespace-only and non-string input are invalid', () => {
  const blank = measureText('   ');
  assert.equal(blank.valid, false);
  assert.equal(blank.empty, true);
  assert.equal(measureText(undefined).valid, false);
  assert.equal(measureText(42).valid, false);
});
