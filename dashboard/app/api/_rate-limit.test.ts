// Tests for the public API's rate-limit policy.
//
// WHY THESE EXIST: every branch here is a decision about whether to REFUSE
// someone, and none of it shows up in normal operation. Stenion's real traffic
// will not hit the limit, so the first time this code runs in anger is either an
// abuse incident or a wallet integrator's launch — and if the client-identity
// derivation is wrong in the direction that pools clients together, the second
// case looks exactly like the first.
//
// The rules being pinned: unidentifiable clients are limited rather than
// exempted; identity is derived from the proxy header we trust, not the one a
// client can pick; a bad env value degrades to the default instead of taking the
// API down; and a refusal always names a wait a client can actually honour.
//
// The distributed counter itself is Postgres arithmetic and is tested in
// db/src/rate-limit.test.ts.
//
// Run with: pnpm --filter @stenion/dashboard test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_BURST,
  DEFAULT_PER_MINUTE,
  bucketKey,
  clientIp,
  createDenyCache,
  rateLimitHeaders,
  rateLimitedBody,
  readRateLimitSettings,
} from './_rate-limit.ts';

const NOW = Date.parse('2026-08-19T12:00:00.000Z');
const SETTINGS = { enabled: true, perMinute: 60, burst: 60, salt: 'pepper' };

describe('readRateLimitSettings', () => {
  it('is on by default', () => {
    // The failure mode: shipping with the limiter quietly off because nobody set
    // an env var. Protection has to be the thing you get for doing nothing.
    const settings = readRateLimitSettings({});
    assert.equal(settings.enabled, true);
    assert.equal(settings.perMinute, DEFAULT_PER_MINUTE);
    assert.equal(settings.burst, DEFAULT_BURST);
  });

  it('turns off only for the exact string "true"', () => {
    assert.equal(readRateLimitSettings({ STENION_RATE_LIMIT_DISABLED: 'true' }).enabled, false);
    assert.equal(readRateLimitSettings({ STENION_RATE_LIMIT_DISABLED: ' TRUE ' }).enabled, false);
    for (const value of ['false', '1', 'yes', 'no', '']) {
      assert.equal(
        readRateLimitSettings({ STENION_RATE_LIMIT_DISABLED: value }).enabled,
        true,
        `"${value}" must not disable the limiter`,
      );
    }
  });

  it('reads overrides', () => {
    const settings = readRateLimitSettings({
      STENION_RATE_LIMIT_PER_MIN: '120',
      STENION_RATE_LIMIT_BURST: '240',
      STENION_RATE_LIMIT_SALT: '  s3cret  ',
    });
    assert.equal(settings.perMinute, 120);
    assert.equal(settings.burst, 240);
    assert.equal(settings.salt, 's3cret');
  });

  it('falls back to defaults on a malformed value instead of throwing', () => {
    // A guard rail must not be able to crash the thing it guards. A typo in an
    // env var should cost the operator their override, not the public API.
    for (const bad of ['', '  ', 'abc', '0', '-5', 'NaN', 'Infinity']) {
      const settings = readRateLimitSettings({
        STENION_RATE_LIMIT_PER_MIN: bad,
        STENION_RATE_LIMIT_BURST: bad,
      });
      assert.equal(settings.perMinute, DEFAULT_PER_MINUTE, `per-min from "${bad}"`);
      assert.equal(settings.burst, DEFAULT_BURST, `burst from "${bad}"`);
    }
  });
});

describe('clientIp', () => {
  it('prefers x-real-ip', () => {
    const headers = new Headers({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' });
    assert.equal(clientIp(headers), '203.0.113.7');
  });

  it('falls back to the first x-forwarded-for hop', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18, 150.172.238.178' });
    assert.equal(clientIp(headers), '203.0.113.7');
  });

  it('returns null when the platform reports nothing', () => {
    // Not a fabricated identity. Null is handled explicitly by bucketKey, and
    // inventing a per-request one here would silently exempt every such client.
    assert.equal(clientIp(new Headers()), null);
    assert.equal(clientIp(new Headers({ 'x-forwarded-for': '   ' })), null);
  });
});

describe('bucketKey', () => {
  it('is stable for one client and different across clients', () => {
    assert.equal(bucketKey('203.0.113.7', 'pepper'), bucketKey('203.0.113.7', 'pepper'));
    assert.notEqual(bucketKey('203.0.113.7', 'pepper'), bucketKey('203.0.113.8', 'pepper'));
  });

  it('never contains the IP it was derived from', () => {
    // The rate-limit table must not become a log of who reads the public API.
    const key = bucketKey('203.0.113.7', 'pepper');
    assert.doesNotMatch(key, /203\.0\.113\.7/);
  });

  it('changes with the salt, which is what makes the hash worth having', () => {
    // Unsalted, an IPv4 hash is reversible by enumerating four billion inputs.
    assert.notEqual(bucketKey('203.0.113.7', ''), bucketKey('203.0.113.7', 'pepper'));
  });

  it('pools unidentifiable clients into one bucket rather than exempting them', () => {
    // Limited collectively is the safe direction. A per-request key would mean
    // "we could not identify you" reads as "you have no limit".
    assert.equal(bucketKey(null, 'pepper'), bucketKey(null, 'pepper'));
  });
});

describe('rateLimitHeaders', () => {
  it('gives a client everything it needs to back off', () => {
    const headers = rateLimitHeaders(SETTINGS, 2, NOW);
    assert.equal(headers['retry-after'], '2');
    assert.equal(headers['x-ratelimit-limit'], '60');
    assert.equal(headers['x-ratelimit-remaining'], '0');
    assert.equal(headers['x-ratelimit-reset'], String(NOW / 1000 + 2));
  });

  it('marks the refusal uncacheable', () => {
    // THE ONE THAT MATTERS. The CDN cache key is the URL, not the client. A 429
    // that a shared cache is allowed to keep would be replayed to every other
    // client that asked next, turning one scraper's limit into everyone's outage.
    assert.equal(rateLimitHeaders(SETTINGS, 2, NOW)['cache-control'], 'no-store');
  });
});

describe('rateLimitedBody', () => {
  it('keeps the { error } shape the rest of the API already uses', () => {
    // A 429 is a new status for this API, not a change to an existing payload —
    // consumers of the 200/404/500 bodies see nothing different. Matching the
    // established error shape means a client that already handles `error` needs
    // no new parsing.
    const body = rateLimitedBody(2);
    assert.equal(typeof body.error, 'string');
    assert.equal(body.retryAfter, 2);
    assert.match(body.error, /Retry-After/);
  });
});

describe('createDenyCache', () => {
  it('refuses a known-blocked client without asking the database', () => {
    const cache = createDenyCache();
    cache.block('ip:abc', 2, NOW);
    assert.equal(cache.blockedFor('ip:abc', NOW), 2);
  });

  it('knows nothing about a client it has not refused', () => {
    // The safe direction: not-in-the-cache means ask Postgres, never means allow.
    assert.equal(createDenyCache().blockedFor('ip:abc', NOW), null);
  });

  it('forgets a block once it expires', () => {
    // Otherwise a per-instance memo becomes a per-instance ban, and a client that
    // did back off stays refused by whichever instance remembers it.
    const cache = createDenyCache();
    cache.block('ip:abc', 2, NOW);
    assert.equal(cache.blockedFor('ip:abc', NOW + 2_000), null);
    assert.equal(cache.size, 0, 'the expired entry should be dropped, not just ignored');
  });

  it('counts down, rounding up so it never advertises too short a wait', () => {
    const cache = createDenyCache();
    cache.block('ip:abc', 2, NOW);
    assert.equal(cache.blockedFor('ip:abc', NOW + 500), 2);
    assert.equal(cache.blockedFor('ip:abc', NOW + 1_500), 1);
    assert.equal(cache.blockedFor('ip:abc', NOW + 1_999), 1);
  });

  it('stays bounded under a flood of distinct clients', () => {
    // This map lives for the life of a warm instance. Unbounded, a botnet with
    // many source addresses turns a rate limiter into a memory leak.
    const cache = createDenyCache(4);
    for (let i = 0; i < 50; i += 1) cache.block(`ip:${i}`, 2, NOW);
    assert.ok(cache.size <= 4, `cache grew to ${cache.size}`);
  });
});
