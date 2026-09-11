import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isAllowed, parseRobots } from '../src/robots.js';

const FILE = `
# a comment
User-agent: *
Disallow: /admin/
Disallow: /search
Allow: /events/
Crawl-delay: 2
Sitemap: https://example.com/sitemap.xml

User-agent: BadBot
Disallow: /
`;

test('the catch-all group is the one that applies to us', () => {
  const rules = parseRobots(FILE, 'event-scout-crawler');
  assert.equal(rules.crawlDelay, 2);
  assert.deepEqual(rules.sitemaps, ['https://example.com/sitemap.xml']);
  assert.equal(isAllowed(rules, '/events/spring-fair'), true);
  assert.equal(isAllowed(rules, '/admin/login'), false);
  assert.equal(isAllowed(rules, '/search?q=x'), false);
  assert.equal(isAllowed(rules, '/anything-else'), true);
});

/** A file that singles us out has said something more specific than its `*`. */
test('a group naming us wins over the catch-all', () => {
  const rules = parseRobots(FILE, 'BadBot');
  assert.equal(isAllowed(rules, '/events/spring-fair'), false, 'the * Allow no longer applies');
  assert.equal(isAllowed(rules, '/'), false);
});

/**
 * Consecutive agent lines share the rules that follow, which is the shape most
 * real files use and the one a naive parser drops on the floor.
 */
test('stacked user-agent lines share one group', () => {
  const rules = parseRobots(
    'User-agent: alpha\nUser-agent: beta\nDisallow: /private\n',
    'beta'
  );
  assert.equal(isAllowed(rules, '/private/x'), false);
  assert.equal(isAllowed(rules, '/public'), true);
});

/** A new agent line after a rule starts a new group rather than joining. */
test('a second group does not inherit the first one rules', () => {
  const rules = parseRobots(
    'User-agent: alpha\nDisallow: /a\n\nUser-agent: *\nDisallow: /b\n',
    'somebody'
  );
  assert.equal(isAllowed(rules, '/a'), true, 'alpha rules are not ours');
  assert.equal(isAllowed(rules, '/b'), false);
});

/**
 * "Disallow:" with nothing after it means the opposite of "Disallow: /", and
 * reading it as a rule would lock the crawler out of the whole site.
 */
test('an empty Disallow permits everything', () => {
  const rules = parseRobots('User-agent: *\nDisallow:\n', 'x');
  assert.equal(isAllowed(rules, '/'), true);
  assert.equal(isAllowed(rules, '/anything'), true);
});

/** Longest match wins, and Allow breaks a tie: the RFC rule. */
test('a re-opened page inside a closed tree is fetchable', () => {
  const rules = parseRobots(
    'User-agent: *\nDisallow: /calendar\nAllow: /calendar/events\n',
    'x'
  );
  assert.equal(isAllowed(rules, '/calendar/list'), false);
  assert.equal(isAllowed(rules, '/calendar/events/spring'), true);
});

test('wildcards and end-anchors are honoured', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /a/*/b\n', 'x');
  assert.equal(isAllowed(rules, '/files/report.pdf'), false);
  assert.equal(isAllowed(rules, '/files/report.pdf.html'), true, '$ anchors the end');
  assert.equal(isAllowed(rules, '/a/middle/b'), false);
  assert.equal(isAllowed(rules, '/a/b'), true);
});

/**
 * Paths carry regex metacharacters routinely. Left unescaped, "/a.b" would
 * match "/axb" and the crawler would decline pages it was allowed to fetch.
 */
test('a dot in a path is a dot', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /a.b\n', 'x');
  assert.equal(isAllowed(rules, '/a.b'), false);
  assert.equal(isAllowed(rules, '/axb'), true);
});

test('an absent or unreadable file allows everything', () => {
  assert.equal(isAllowed(parseRobots('', 'x'), '/anything'), true);
  assert.equal(isAllowed(parseRobots('<html>404</html>', 'x'), '/anything'), true);
});
