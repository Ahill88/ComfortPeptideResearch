import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { describeNodeEnv, isNonProductionRuntime, isProductionLikeRuntime } from '../runtime';
import { NODE_ENV_MATRIX, envOf, isAllowed, label } from './node-env-matrix';

describe('runtime allowlist', () => {
  for (const value of NODE_ENV_MATRIX) {
    test(`NODE_ENV=${label(value)}: non-production only for exactly development|test`, () => {
      assert.equal(isNonProductionRuntime(envOf(value)), isAllowed(value));
      assert.equal(isProductionLikeRuntime(envOf(value)), !isAllowed(value));
    });
  }

  test('describeNodeEnv makes unset and whitespace-padded values visible', () => {
    assert.equal(describeNodeEnv({}), '<unset>');
    assert.equal(describeNodeEnv({ NODE_ENV: 'production ' }), '"production "');
  });

  test('defaults to process.env', () => {
    assert.equal(isNonProductionRuntime(), process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development');
  });
});
