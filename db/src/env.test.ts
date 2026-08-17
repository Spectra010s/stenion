import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { requireVerifyFullSslMode } from './env.ts';

describe('requireVerifyFullSslMode', () => {
  it('adds sslmode=verify-full when it is missing', () => {
    assert.equal(
      requireVerifyFullSslMode('postgresql://user:pass@example.com/stenion'),
      'postgresql://user:pass@example.com/stenion?sslmode=verify-full',
    );
  });

  it('replaces sslmode=require with sslmode=verify-full', () => {
    assert.equal(
      requireVerifyFullSslMode('postgresql://user:pass@example.com/stenion?sslmode=require'),
      'postgresql://user:pass@example.com/stenion?sslmode=verify-full',
    );
  });

  it('preserves existing query parameters', () => {
    assert.equal(
      requireVerifyFullSslMode('postgresql://user:pass@example.com/stenion?connect_timeout=10'),
      'postgresql://user:pass@example.com/stenion?connect_timeout=10&sslmode=verify-full',
    );
  });
});
