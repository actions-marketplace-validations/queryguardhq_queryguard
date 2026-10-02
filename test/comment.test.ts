import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOT_MARKER, LEGACY_BOT_MARKER, findReportComment, withMarker } from '../src/comment';

type C = { id: number; body?: string | null };
const comments: C[] = [
  { id: 1, body: 'LGTM' },
  { id: 2, body: null },
  { id: 3, body: `${LEGACY_BOT_MARKER}\n## old report` },
];

test('a comment written by 1.2.x (legacy marker) is found, so it is updated in place', () => {
  assert.equal(findReportComment<C>(comments)?.id, 3);
});

test('a comment with the current marker is found', () => {
  assert.equal(findReportComment<C>([...comments, { id: 4, body: withMarker('x') }])?.id, 3);
  assert.equal(findReportComment<C>([{ id: 4, body: withMarker('x') }])?.id, 4);
});

test('unrelated comments and non-array responses are ignored', () => {
  assert.equal(findReportComment([{ id: 1, body: 'hello' }]), undefined);
  assert.equal(findReportComment({ message: 'Bad credentials' }), undefined);
});

test('new comments carry the new marker only, and the markers differ', () => {
  assert.ok(withMarker('r').startsWith(BOT_MARKER));
  assert.ok(!withMarker('r').includes(LEGACY_BOT_MARKER));
  assert.notEqual(BOT_MARKER, LEGACY_BOT_MARKER);
});
