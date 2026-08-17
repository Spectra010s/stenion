import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pinVerifyFullSslMode } from './env.ts';

describe('pinVerifyFullSslMode', () => {
  it('adds sslmode=verify-full when it is missing', () => {
    assert.equal(
      pinVerifyFullSslMode('postgresql://user:pass@example.com/stenion'),
      'postgresql://user:pass@example.com/stenion?sslmode=verify-full',
    );
  });

  it('replaces sslmode=require with sslmode=verify-full', () => {
    assert.equal(
      pinVerifyFullSslMode('postgresql://user:pass@example.com/stenion?sslmode=require'),
      'postgresql://user:pass@example.com/stenion?sslmode=verify-full',
    );
  });

  it('preserves existing query parameters', () => {
    assert.equal(
      pinVerifyFullSslMode('postgresql://user:pass@example.com/stenion?connect_timeout=10'),
      'postgresql://user:pass@example.com/stenion?connect_timeout=10&sslmode=verify-full',
    );
  });

  // The security-relevant half: a weaker mode already in DATABASE_URL is the
  // case the pin exists to beat, so it must lose rather than be treated as an
  // opt-out. A refactor to "set it only if absent" would pass every test above
  // and fail these two.
  for (const weaker of ['disable', 'no-verify', 'prefer', 'verify-ca']) {
    it(`overrides the weaker sslmode=${weaker} on a remote host`, () => {
      assert.equal(
        pinVerifyFullSslMode(`postgresql://user:pass@example.com/stenion?sslmode=${weaker}`),
        'postgresql://user:pass@example.com/stenion?sslmode=verify-full',
      );
    });
  }

  it('is idempotent, so repeated normalization cannot drift', () => {
    const once = pinVerifyFullSslMode('postgresql://user:pass@example.com/stenion?sslmode=require');
    assert.equal(pinVerifyFullSslMode(once), once);
  });

  it('keeps a percent-encoded password, port and Neon options intact', () => {
    assert.equal(
      pinVerifyFullSslMode(
        'postgresql://user:p%40ss%3Aw@ep-x-pooler.region.aws.neon.tech:5432/stenion?sslmode=require&channel_binding=require',
      ),
      'postgresql://user:p%40ss%3Aw@ep-x-pooler.region.aws.neon.tech:5432/stenion?sslmode=verify-full&channel_binding=require',
    );
  });

  // No local Postgres serves a verifiable certificate, so pinning loopback
  // would break the container flow in CONTRIBUTING.md for no security gain.
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'LOCALHOST']) {
    it(`leaves a loopback host (${host}) untouched`, () => {
      const url = `postgresql://postgres:test@${host}:5433/stenion_test?sslmode=disable`;
      assert.equal(pinVerifyFullSslMode(url), url);
    });
  }

  it('still pins a host that merely looks loopback-ish', () => {
    assert.equal(
      pinVerifyFullSslMode('postgresql://user:pass@localhost.example.com/stenion'),
      'postgresql://user:pass@localhost.example.com/stenion?sslmode=verify-full',
    );
  });
});
