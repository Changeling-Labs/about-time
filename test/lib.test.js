import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BATTERY_STEPS,
  batteryLabel,
  batterySegments,
  cleanName,
  codeFromSearch,
  formatCode,
  isValidCode,
  isValidName,
  joinUrl,
  nearestBattery,
  normalizeCode,
  readyNotification,
  readySummary,
  relativeTime,
  sortMembers,
  summaryText,
  truncate,
} from '../js/lib.js';

test('room codes are normalized, formatted and validated', () => {
  assert.equal(normalizeCode(' abc-234 '), 'ABC234');
  assert.equal(normalizeCode('abcdefgh'), 'ABCDEF');
  assert.equal(formatCode('abc234'), 'ABC 234');
  assert.equal(formatCode('AB'), 'AB');
  assert.equal(isValidCode('ABC 234'), true);
  assert.equal(isValidCode('ABC23'), false);
  // I, O, 0 and 1 are deliberately absent from the alphabet.
  assert.equal(isValidCode('ABCI23'), false);
  assert.equal(isValidCode('ABC023'), false);
  assert.equal(isValidCode('ABC123'), false);
});

test('room codes survive being pasted out of a URL', () => {
  assert.equal(codeFromSearch('?code=abc234'), 'ABC234');
  assert.equal(codeFromSearch('?code=ABC%20234'), 'ABC234');
  assert.equal(codeFromSearch('?code=nope'), '');
  assert.equal(codeFromSearch(''), '');
  assert.equal(joinUrl('abc234', 'https://example.com/about-time/?x=1#y'), 'https://example.com/about-time/?code=ABC234');
});

test('battery values snap to the five steps', () => {
  assert.deepEqual(BATTERY_STEPS, [100, 75, 50, 25, 0]);
  assert.equal(nearestBattery(92), 100);
  assert.equal(nearestBattery(70), 75);
  assert.equal(nearestBattery(51), 50);
  assert.equal(nearestBattery(3), 0);
  assert.equal(nearestBattery('nonsense'), 100);
});

test('battery labels and segments line up', () => {
  assert.equal(batteryLabel(100), 'Full');
  assert.equal(batteryLabel(75), 'Good');
  assert.equal(batteryLabel(50), 'Half');
  assert.equal(batteryLabel(25), 'Low');
  assert.equal(batteryLabel(0), 'Empty');

  assert.equal(batterySegments(100), 5);
  assert.equal(batterySegments(75), 4);
  assert.equal(batterySegments(50), 3);
  assert.equal(batterySegments(25), 2);
  assert.equal(batterySegments(0), 0);
});

test('ready people float to the top, then the emptiest battery', () => {
  const members = [
    { id: 'a', name: 'Dad', battery: 100, ready: false },
    { id: 'b', name: 'Mum', battery: 25, ready: false },
    { id: 'c', name: 'Grace', battery: 75, ready: true },
    { id: 'd', name: 'Noah', battery: 50, ready: true },
  ];

  assert.deepEqual(
    sortMembers(members).map((m) => m.id),
    ['d', 'c', 'b', 'a'],
  );
});

test('sorting does not mutate the input', () => {
  const members = [{ id: 'a', name: 'A', battery: 0, ready: false }];
  const copy = [...members];
  sortMembers(members);
  assert.deepEqual(members, copy);
});

test('summary counts and copy read naturally', () => {
  const none = readySummary([]);
  assert.equal(summaryText(none), 'Waiting for people to join');

  const quiet = readySummary([{ ready: false }, { ready: false }]);
  assert.equal(quiet.ready, 0);
  assert.equal(summaryText(quiet), 'Nobody is ready yet');

  const one = readySummary([{ ready: true, name: 'Mum' }, { ready: false }]);
  assert.equal(summaryText(one), '1 person is ready');
  assert.deepEqual(one.names, ['Mum']);

  const some = readySummary([{ ready: true }, { ready: true }, { ready: false }]);
  assert.equal(summaryText(some), '2 people are ready');
  assert.equal(some.allReady, false);

  const all = readySummary([{ ready: true }, { ready: true }]);
  assert.equal(summaryText(all), 'Everyone is ready');
  assert.equal(all.allReady, true);
});

test('relative time stays short', () => {
  const now = Date.parse('2026-11-08T20:00:00Z');
  assert.equal(relativeTime('2026-11-08T19:59:50Z', now), 'just now');
  assert.equal(relativeTime('2026-11-08T19:57:00Z', now), '3m ago');
  assert.equal(relativeTime('2026-11-08T18:00:00Z', now), '2h ago');
  assert.equal(relativeTime('2026-11-06T20:00:00Z', now), '2d ago');
  assert.equal(relativeTime('', now), '');
  assert.equal(relativeTime('not a date', now), '');
});

test('notification copy explains who and how many', () => {
  const first = readyNotification({ name: 'Dad', readyCount: 1, total: 5, title: 'Church' });
  assert.equal(first.title, 'Dad is ready to go');
  assert.equal(first.body, 'Nobody else is ready yet · Church');

  const third = readyNotification({ name: 'Mum', readyCount: 3, total: 5, title: 'Church' });
  assert.equal(third.body, '3 of 5 are ready · Church');

  const unnamed = readyNotification({ name: '   ', readyCount: 2, total: 4 });
  assert.equal(unnamed.title, 'Someone is ready to go');
});

test('names are cleaned and bounded', () => {
  assert.equal(cleanName('  Dad   B   '), 'Dad B');
  assert.equal(cleanName('x'.repeat(40)).length, 24);
  assert.equal(isValidName('   '), false);
  assert.equal(isValidName('Mum'), true);
});

test('truncate keeps titles tidy', () => {
  assert.equal(truncate('Sunday service'), 'Sunday service');
  assert.equal(truncate('Ruth and Tom’s extremely long wedding reception', 20), 'Ruth and Tom’s extr…');
  assert.equal(truncate('', 20), '');
});
