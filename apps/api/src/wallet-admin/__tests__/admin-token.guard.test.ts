import 'reflect-metadata';
import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { UnauthorizedException } from '@nestjs/common';
import { AdminTokenGuard } from '../admin-token.guard';

const contextFor = (headers: Record<string, unknown>) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) }) as never;

describe('AdminTokenGuard', () => {
  const original = process.env.ADMIN_API_TOKEN;
  const guard = new AdminTokenGuard();

  beforeEach(() => {
    delete process.env.ADMIN_API_TOKEN;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = original;
  });

  it('denies every request when ADMIN_API_TOKEN is unset (fail closed)', () => {
    assert.throws(() => guard.canActivate(contextFor({ 'x-admin-token': 'anything' })), UnauthorizedException);
    assert.throws(() => guard.canActivate(contextFor({ 'x-admin-token': '' })), UnauthorizedException);
    assert.throws(() => guard.canActivate(contextFor({})), UnauthorizedException);
  });

  it('denies when ADMIN_API_TOKEN is empty, even with an empty header', () => {
    process.env.ADMIN_API_TOKEN = '';
    assert.throws(() => guard.canActivate(contextFor({ 'x-admin-token': '' })), UnauthorizedException);
    assert.throws(() => guard.canActivate(contextFor({})), UnauthorizedException);
  });

  it('denies a missing header', () => {
    process.env.ADMIN_API_TOKEN = 'correct-token';
    assert.throws(() => guard.canActivate(contextFor({})), UnauthorizedException);
  });

  it('denies wrong tokens, including prefixes and different lengths', () => {
    process.env.ADMIN_API_TOKEN = 'correct-token';
    for (const wrong of ['wrong', 'correct-toke', 'correct-token2', 'CORRECT-TOKEN', ' correct-token']) {
      assert.throws(() => guard.canActivate(contextFor({ 'x-admin-token': wrong })), UnauthorizedException, wrong);
    }
  });

  it('denies array-valued headers', () => {
    process.env.ADMIN_API_TOKEN = 'correct-token';
    assert.throws(() => guard.canActivate(contextFor({ 'x-admin-token': ['correct-token'] })), UnauthorizedException);
  });

  it('allows the correct token', () => {
    process.env.ADMIN_API_TOKEN = 'correct-token';
    assert.equal(guard.canActivate(contextFor({ 'x-admin-token': 'correct-token' })), true);
  });

  it('uses one generic denial message regardless of reason', () => {
    const messages = new Set<string>();
    const attempt = () => {
      try {
        guard.canActivate(contextFor({ 'x-admin-token': 'nope' }));
      } catch (error) {
        messages.add((error as Error).message);
      }
    };
    attempt();
    process.env.ADMIN_API_TOKEN = 'correct-token';
    attempt();
    assert.equal(messages.size, 1);
  });
});
