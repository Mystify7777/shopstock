import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, ERROR_CODES } from '../../src/middleware/AppError.js';

describe('AppError', () => {
  test('constructs successfully with a valid locked vocabulary code', () => {
    const err = new AppError('NOT_FOUND', 'Product not found.');
    assert.equal(err.code, 'NOT_FOUND');
    assert.equal(err.message, 'Product not found.');
    assert.equal(err instanceof Error, true);
  });

  test('throws if given a code outside the locked vocabulary', () => {
    assert.throws(() => {
      // eslint-disable-next-line no-new
      new AppError('SOMETHING_MADE_UP', 'This should never construct.');
    }, /not in the locked ERROR_CODES vocabulary/);
  });

  test('rejects an inherited Object.prototype property name as a code (e.g. "toString"), even though `code in ERROR_CODES` would incorrectly accept it', () => {
    // ERROR_CODES is a plain frozen object, so it still has Object.prototype
    // in its chain -- `code in ERROR_CODES` is true for 'toString',
    // 'constructor', 'hasOwnProperty', etc. even though none of them are
    // real vocabulary entries. The constructor must use an own-property
    // check (Object.hasOwn), not `in`, or this slips through and later
    // produces a status of `undefined` from DEFAULT_STATUS_BY_CODE.
    assert.throws(() => {
      // eslint-disable-next-line no-new
      new AppError('toString', 'This should never construct either.');
    }, /not in the locked ERROR_CODES vocabulary/);
  });

  test('defaults to the correct HTTP status per code', () => {
    assert.equal(new AppError('VALIDATION_ERROR', 'x').status, 400);
    assert.equal(new AppError('UNAUTHORIZED', 'x').status, 401);
    assert.equal(new AppError('FORBIDDEN', 'x').status, 403);
    assert.equal(new AppError('NOT_FOUND', 'x').status, 404);
    assert.equal(new AppError('CONFLICT', 'x').status, 409);
    assert.equal(new AppError('QUANTITY_CONSISTENCY_CONFLICT', 'x').status, 409);
    assert.equal(new AppError('ALREADY_REVERSED', 'x').status, 409);
    assert.equal(new AppError('DUPLICATE_ENTITY', 'x').status, 409);
    assert.equal(new AppError('INTERNAL_ERROR', 'x').status, 500);
  });

  test('allows an explicit status override', () => {
    const err = new AppError('CONFLICT', 'x', 418);
    assert.equal(err.status, 418);
  });

  test('ERROR_CODES is exactly the locked nine-code vocabulary', () => {
    assert.deepEqual(Object.keys(ERROR_CODES).sort(), [
      'ALREADY_REVERSED',
      'CONFLICT',
      'DUPLICATE_ENTITY',
      'FORBIDDEN',
      'INTERNAL_ERROR',
      'NOT_FOUND',
      'QUANTITY_CONSISTENCY_CONFLICT',
      'UNAUTHORIZED',
      'VALIDATION_ERROR'
    ]);
  });

  test('ERROR_CODES is frozen (cannot be mutated at runtime)', () => {
    assert.throws(() => {
      ERROR_CODES.NEW_CODE = 'NEW_CODE';
    });
  });
});
