import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { validateEnv, loadConfig, parseCorsOrigins, parseTrustProxy, JWT_SECRET_MIN_LENGTH } from '../../src/config/env.js';

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
      corsOrigins: ['http://localhost:5173'],
      trustProxy: null
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

describe('CORS_ORIGIN allow-list', () => {
  test('parseCorsOrigins splits on commas, trims whitespace and drops empty entries', () => {
    assert.deepEqual(
      parseCorsOrigins(' http://localhost:5173 ,http://localhost:4173,, '),
      ['http://localhost:5173', 'http://localhost:4173']
    );
    assert.deepEqual(parseCorsOrigins(''), []);
    assert.deepEqual(parseCorsOrigins(undefined), []);
  });

  test('loadConfig exposes every listed origin as an array', () => {
    const config = loadConfig(
      completeEnv({ CORS_ORIGIN: 'http://localhost:5173, http://localhost:4173,https://shop.example.com' })
    );
    assert.deepEqual(config.corsOrigins, [
      'http://localhost:5173',
      'http://localhost:4173',
      'https://shop.example.com'
    ]);
  });

  test('validateEnv accepts a list of valid origins, with or without a port', () => {
    const env = completeEnv({ CORS_ORIGIN: 'http://localhost:5173,https://shop.example.com' });
    assert.deepEqual(validateEnv(env), { ok: true });
  });

  for (const [label, value] of [
    ['a trailing slash', 'http://localhost:5173/'],
    ['a path', 'http://localhost:5173/app'],
    ['a wildcard', '*'],
    ['a missing scheme', 'localhost:5173'],
    ['a non-http scheme', 'ftp://localhost:5173'],
    ['one bad entry among valid ones', 'http://localhost:5173,http://localhost:4173/'],
    ['only commas', ',,']
  ]) {
    test(`validateEnv rejects ${label}`, () => {
      const result = validateEnv(completeEnv({ CORS_ORIGIN: value }));
      assert.equal(result.ok, false);
      assert.deepEqual(result.invalid, ['CORS_ORIGIN']);
      assert.deepEqual(result.missing, []);
    });
  }
});

// ---------------------------------------------------------------------------
// Production deployment hardening: TRUST_PROXY and production JWT validation.
// ---------------------------------------------------------------------------

const ENV_MODULE_URL = new URL('../../src/config/env.js', import.meta.url).href;

// backend/.env.example as a plain env object (KEY=value lines).
function exampleEnv() {
  const env = {};
  for (const line of readFileSync(new URL('../../.env.example', import.meta.url), 'utf8').replace(/\r\n/g, '\n').split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

// loadConfig()'s failure path calls process.exit(1), so it is run in a child
// process; the child sees only the variables given here.
function loadConfigInChild(env) {
  const code = `import { loadConfig } from ${JSON.stringify(ENV_MODULE_URL)}; const c = loadConfig(); console.log(JSON.stringify({ trustProxy: c.trustProxy, nodeEnv: c.nodeEnv }));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('parseTrustProxy', () => {
  test('unset, empty and blank all mean "not configured" (null), so Express keeps its default', () => {
    for (const value of [undefined, null, '', '   ']) {
      assert.deepEqual(parseTrustProxy(value), { ok: true, value: null });
    }
  });

  test('a whole, non-negative number is the hop count', () => {
    for (const [value, hops] of [['0', 0], ['1', 1], ['2', 2], ['10', 10], [' 3 ', 3]]) {
      assert.deepEqual(parseTrustProxy(value), { ok: true, value: hops });
    }
  });

  test('anything else is rejected: negative, fractional, boolean, list, exponent, hex, words, overflow', () => {
    for (const value of ['-1', '1.5', 'abc', 'true', 'false', '1e2', '0x1', '2 hops', '1,2', 'loopback', '+1', '99999999999999999999']) {
      assert.deepEqual(parseTrustProxy(value), { ok: false }, `expected ${JSON.stringify(value)} to be rejected`);
    }
  });
});

describe('TRUST_PROXY in validateEnv / loadConfig', () => {
  test('unset: valid, and the config says null (Express default untouched)', () => {
    assert.deepEqual(validateEnv(completeEnv()), { ok: true });
    assert.equal(loadConfig(completeEnv()).trustProxy, null);
  });

  test('an empty TRUST_PROXY= line, as copied from .env.example, is the same as unset', () => {
    assert.deepEqual(validateEnv(completeEnv({ TRUST_PROXY: '' })), { ok: true });
    assert.equal(loadConfig(completeEnv({ TRUST_PROXY: '' })).trustProxy, null);
  });

  test('a valid hop count is accepted and parsed to a number', () => {
    for (const [value, hops] of [['0', 0], ['1', 1], ['2', 2]]) {
      assert.equal(loadConfig(completeEnv({ TRUST_PROXY: value })).trustProxy, hops);
    }
  });

  test('an invalid value is reported by name, and nothing else', () => {
    for (const value of ['-1', '1.5', 'true', 'abc']) {
      const result = validateEnv(completeEnv({ TRUST_PROXY: value }));
      assert.equal(result.ok, false);
      assert.deepEqual(result.invalid, ['TRUST_PROXY']);
      assert.deepEqual(result.missing, []);
    }
  });

  test('an invalid value stops startup with a clear message that says what is expected', () => {
    const result = loadConfigInChild({ ...completeEnv({ TRUST_PROXY: 'yes' }), PATH: process.env.PATH });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing to start: invalid value for environment variable\(s\): TRUST_PROXY \(expected a whole number of proxy hops \(0 or more\), or leave it unset\)/);
  });

  test('a valid value starts, through the real loadConfig', () => {
    const result = loadConfigInChild({ ...completeEnv({ TRUST_PROXY: '2' }), PATH: process.env.PATH });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { trustProxy: 2, nodeEnv: 'test' });
  });
});

describe('JWT_ACCESS_SECRET in production', () => {
  const production = (secret) => completeEnv({ NODE_ENV: 'production', JWT_ACCESS_SECRET: secret });
  const goodSecret = 'k3Jx9QvT7mN2pLw8RzYb4HcD6sFa1GeU0iOoV5tXnMq';

  test('a missing secret is reported as missing, as in every environment', () => {
    const env = production(undefined);
    delete env.JWT_ACCESS_SECRET;
    const result = validateEnv(env);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['JWT_ACCESS_SECRET']);
    assert.deepEqual(result.invalid, []);
  });

  test('a blank secret is missing, not a second, "invalid" report', () => {
    const result = validateEnv(production('    '));
    assert.deepEqual(result.missing, ['JWT_ACCESS_SECRET']);
    assert.deepEqual(result.invalid, []);
  });

  test('the placeholder documented in .env.example is rejected', () => {
    const placeholder = exampleEnv().JWT_ACCESS_SECRET;
    assert.ok(placeholder, 'the example documents a JWT_ACCESS_SECRET placeholder');
    // It is long enough to pass a length check, so only the placeholder rule rejects it.
    assert.ok(placeholder.length >= JWT_SECRET_MIN_LENGTH);
    const result = validateEnv(production(placeholder));
    assert.equal(result.ok, false);
    assert.deepEqual(result.invalid, ['JWT_ACCESS_SECRET']);
  });

  test('any "change-me" style placeholder is rejected, whatever its case or length', () => {
    for (const value of ['change-me', 'CHANGE-ME-to-a-long-random-string-please-do', 'changeme-changeme-changeme-changeme', 'Change-Me-Before-Seeding-Now-Really']) {
      assert.deepEqual(validateEnv(production(value)).invalid, ['JWT_ACCESS_SECRET'], `expected ${value} to be rejected`);
    }
  });

  test(`a secret shorter than ${JWT_SECRET_MIN_LENGTH} characters is rejected; exactly ${JWT_SECRET_MIN_LENGTH} is accepted`, () => {
    assert.deepEqual(validateEnv(production('a'.repeat(JWT_SECRET_MIN_LENGTH - 1))).invalid, ['JWT_ACCESS_SECRET']);
    assert.deepEqual(validateEnv(production('a'.repeat(JWT_SECRET_MIN_LENGTH))), { ok: true });
  });

  test('padding does not count towards the length', () => {
    assert.deepEqual(validateEnv(production(`${'a'.repeat(JWT_SECRET_MIN_LENGTH - 1)}   `)).invalid, ['JWT_ACCESS_SECRET']);
  });

  test('a real-looking secret is accepted', () => {
    assert.deepEqual(validateEnv(production(goodSecret)), { ok: true });
    assert.deepEqual(validateEnv(production('9f2c'.repeat(16))), { ok: true });
  });

  test('"Production" in any case, with whitespace, counts as production', () => {
    for (const nodeEnv of ['production', 'Production', 'PRODUCTION', ' production ']) {
      assert.deepEqual(validateEnv(completeEnv({ NODE_ENV: nodeEnv, JWT_ACCESS_SECRET: 'short' })).invalid, ['JWT_ACCESS_SECRET'], `NODE_ENV=${JSON.stringify(nodeEnv)}`);
    }
  });

  test('outside production nothing changes: short and placeholder secrets still boot', () => {
    for (const nodeEnv of ['development', 'test', 'staging', 'prod', undefined]) {
      for (const secret of ['short', 'change-me-to-a-long-random-string']) {
        const env = completeEnv({ NODE_ENV: nodeEnv, JWT_ACCESS_SECRET: secret });
        if (nodeEnv === undefined) delete env.NODE_ENV;
        assert.deepEqual(validateEnv(env), { ok: true }, `NODE_ENV=${nodeEnv} secret=${secret}`);
      }
    }
  });

  test('.env.example copied as-is cannot boot in production, but is fine for development', () => {
    const example = exampleEnv();
    assert.deepEqual(validateEnv({ ...example, NODE_ENV: 'development' }), { ok: true });
    const production = validateEnv({ ...example, NODE_ENV: 'production' });
    assert.equal(production.ok, false);
    assert.ok(production.invalid.includes('JWT_ACCESS_SECRET'));
  });

  test('the startup message names the variable and what is required, and never prints the secret', () => {
    const secret = 'short-secret-that-must-never-be-printed';
    const shortSecret = 'tiny-9Qz';
    for (const value of [shortSecret, secret.slice(0, 20)]) {
      const result = loadConfigInChild({ ...production(value), PATH: process.env.PATH });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /invalid value for environment variable\(s\): JWT_ACCESS_SECRET \(in production it must be at least 32 characters and not the example placeholder\)/);
      assert.ok(!result.stderr.includes(value), 'the secret must not appear in the startup message');
      assert.ok(!result.stdout.includes(value));
    }
  });

  test('a valid production secret starts, through the real loadConfig, with the secret passed through unchanged', () => {
    const result = loadConfigInChild({ ...production(goodSecret), PATH: process.env.PATH });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).nodeEnv, 'production');
    assert.equal(loadConfig(production(goodSecret)).jwtAccessSecret, goodSecret);
  });
});
