import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateEnv, loadConfig } from '../../src/config/env.js';

function completeEnv(overrides = {}) {
  return {
    MONGODB_URI: 'mongodb://localhost:27017/shopstock-test',
    PORT: '4000',
    NODE_ENV: 'test',
    JWT_ACCESS_SECRET: 'test-secret',
    JWT_ACCESS_EXPIRES_IN: '15m',
    REFRESH_TOKEN_EXPIRES_IN_DAYS: '90',
    SEED_USERNAME: 'shopowner',
    SEED_PASSWORD: 'test-password',
    CORS_ORIGIN: 'http://localhost:5173',
    ...overrides
  };
}

describe('validateEnv', () => {
  test('returns ok:true when every required variable is present', () => {
    const result = validateEnv(completeEnv());
    assert.deepEqual(result, { ok: true });
  });

  test('returns ok:false with the missing variable name when one is absent', () => {
    const env = completeEnv();
    delete env.MONGODB_URI;
    const result = validateEnv(env);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['MONGODB_URI']);
  });

  test('reports every missing variable, not just the first', () => {
    const env = completeEnv();
    delete env.MONGODB_URI;
    delete env.JWT_ACCESS_SECRET;
    delete env.SEED_PASSWORD;
    const result = validateEnv(env);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['MONGODB_URI', 'JWT_ACCESS_SECRET', 'SEED_PASSWORD']);
  });

  test('treats an empty-string value the same as a missing one', () => {
    const env = completeEnv({ CORS_ORIGIN: '' });
    const result = validateEnv(env);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['CORS_ORIGIN']);
  });

  test('treats a whitespace-only value the same as missing', () => {
    const env = completeEnv({ SEED_USERNAME: '   ' });
    const result = validateEnv(env);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['SEED_USERNAME']);
  });

  test('rejects a non-numeric REFRESH_TOKEN_EXPIRES_IN_DAYS', () => {
    const env = completeEnv({ REFRESH_TOKEN_EXPIRES_IN_DAYS: 'banana' });
    const result = validateEnv(env);
    assert.equal(result.ok, false);
    assert.deepEqual(result.invalid, ['REFRESH_TOKEN_EXPIRES_IN_DAYS']);
    assert.deepEqual(result.missing, []);
  });

  test('rejects a zero REFRESH_TOKEN_EXPIRES_IN_DAYS', () => {
    const env = completeEnv({ REFRESH_TOKEN_EXPIRES_IN_DAYS: '0' });
    const result = validateEnv(env);
    assert.equal(result.ok, false);
    assert.deepEqual(result.invalid, ['REFRESH_TOKEN_EXPIRES_IN_DAYS']);
  });

  test('rejects a negative REFRESH_TOKEN_EXPIRES_IN_DAYS', () => {
    const env = completeEnv({ REFRESH_TOKEN_EXPIRES_IN_DAYS: '-90' });
    const result = validateEnv(env);
    assert.equal(result.ok, false);
    assert.deepEqual(result.invalid, ['REFRESH_TOKEN_EXPIRES_IN_DAYS']);
  });

  test('accepts a fractional-but-positive REFRESH_TOKEN_EXPIRES_IN_DAYS', () => {
    // Finite and positive is the actual contract -- not integer-only.
    const env = completeEnv({ REFRESH_TOKEN_EXPIRES_IN_DAYS: '0.5' });
    const result = validateEnv(env);
    assert.deepEqual(result, { ok: true });
  });

  test('does not double-report a missing REFRESH_TOKEN_EXPIRES_IN_DAYS as also invalid', () => {
    const env = completeEnv();
    delete env.REFRESH_TOKEN_EXPIRES_IN_DAYS;
    const result = validateEnv(env);
    assert.deepEqual(result.missing, ['REFRESH_TOKEN_EXPIRES_IN_DAYS']);
    assert.deepEqual(result.invalid, []);
  });

  test('rejects a non-numeric PORT when PORT is present', () => {
    const env = completeEnv({ PORT: 'not-a-port' });
    const result = validateEnv(env);
    assert.equal(result.ok, false);
    assert.deepEqual(result.invalid, ['PORT']);
  });

  test('rejects a non-integer PORT (e.g. a fractional value)', () => {
    const env = completeEnv({ PORT: '4000.5' });
    const result = validateEnv(env);
    assert.equal(result.ok, false);
    assert.deepEqual(result.invalid, ['PORT']);
  });

  test('rejects a zero or negative PORT', () => {
    const env = completeEnv({ PORT: '0' });
    const result = validateEnv(env);
    assert.equal(result.ok, false);
    assert.deepEqual(result.invalid, ['PORT']);
  });

  test('PORT is optional -- an absent PORT is not reported as invalid', () => {
    const env = completeEnv();
    delete env.PORT;
    const result = validateEnv(env);
    assert.deepEqual(result, { ok: true });
  });

  test('reports both missing and invalid variables together in one result', () => {
    const env = completeEnv({ REFRESH_TOKEN_EXPIRES_IN_DAYS: 'banana' });
    delete env.MONGODB_URI;
    const result = validateEnv(env);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['MONGODB_URI']);
    assert.deepEqual(result.invalid, ['REFRESH_TOKEN_EXPIRES_IN_DAYS']);
  });
});

describe('loadConfig', () => {
  test('returns a fully-populated, correctly-typed config object for a complete env', () => {
    const config = loadConfig(completeEnv());
    assert.deepEqual(config, {
      mongodbUri: 'mongodb://localhost:27017/shopstock-test',
      port: 4000,
      nodeEnv: 'test',
      jwtAccessSecret: 'test-secret',
      jwtAccessExpiresIn: '15m',
      refreshTokenExpiresInDays: 90,
      seedUsername: 'shopowner',
      seedPassword: 'test-password',
      corsOrigin: 'http://localhost:5173'
    });
  });

  test('REFRESH_TOKEN_EXPIRES_IN_DAYS is parsed as a number, not a string', () => {
    const config = loadConfig(completeEnv());
    assert.equal(typeof config.refreshTokenExpiresInDays, 'number');
  });

  test('PORT defaults to 4000 when absent', () => {
    const env = completeEnv();
    delete env.PORT;
    const config = loadConfig(env);
    assert.equal(config.port, 4000);
  });

  test('NODE_ENV defaults to "development" when absent', () => {
    const env = completeEnv();
    delete env.NODE_ENV;
    const config = loadConfig(env);
    assert.equal(config.nodeEnv, 'development');
  });

  test('a valid, non-default PORT is used as-is', () => {
    const config = loadConfig(completeEnv({ PORT: '8080' }));
    assert.equal(config.port, 8080);
  });

  // Note: loadConfig()'s process.exit(1) failure path is intentionally not
  // exercised here -- calling it directly would terminate the test runner
  // process itself. validateEnv() above already covers the underlying
  // missing-variable detection logic that decides whether loadConfig()
  // takes that path.
});
