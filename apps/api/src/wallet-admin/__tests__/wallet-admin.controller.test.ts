import 'reflect-metadata';
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { AdminTokenGuard } from '../admin-token.guard';
import { WalletAdminController } from '../wallet-admin.controller';
import { WalletAdminModule } from '../wallet-admin.module';

const proto = WalletAdminController.prototype as unknown as Record<string, unknown>;
const handlerNames = Object.getOwnPropertyNames(proto).filter((name) => name !== 'constructor');
const REQUEST_METHODS = [RequestMethod.GET, RequestMethod.POST, RequestMethod.PUT, RequestMethod.DELETE, RequestMethod.PATCH, RequestMethod.ALL, RequestMethod.OPTIONS, RequestMethod.HEAD];

describe('WalletAdminController (read-only surface)', () => {
  it('is mounted at admin/wallets', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, WalletAdminController), 'admin/wallets');
  });

  it('exposes only GET handlers', () => {
    assert.ok(handlerNames.length > 0);
    for (const name of handlerNames) {
      const method = Reflect.getMetadata(METHOD_METADATA, proto[name] as object);
      assert.equal(method, RequestMethod.GET, `${name} must be a GET handler (got ${REQUEST_METHODS[method] ?? method})`);
    }
  });

  it('exposes exactly the documented routes', () => {
    const paths = handlerNames.map((name) => Reflect.getMetadata(PATH_METADATA, proto[name] as object)).sort();
    assert.deepEqual(paths, ['balances', 'directory', 'failed', 'funding', 'payment-intents', 'pending-orders', 'providers', 'reconciliation', 'settlements', 'transactions']);
  });

  it('accepts only query parameters (no body, path params, or headers/req) on any handler', () => {
    const QUERY = 4;
    for (const name of handlerNames) {
      const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, WalletAdminController, name) ?? {};
      for (const key of Object.keys(args)) {
        assert.equal(Number(key.split(':')[0]), QUERY, `${name} has non-query route argument ${key}`);
      }
    }
  });

  it('protects the whole controller with AdminTokenGuard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, WalletAdminController) as unknown[];
    assert.ok(guards.includes(AdminTokenGuard));
  });

  it('module registers no providers that sign or mutate', () => {
    const providers = (Reflect.getMetadata('providers', WalletAdminModule) as Array<{ name: string }>).map((p) => p.name).sort();
    assert.deepEqual(providers, ['AdminTokenGuard', 'WalletAdminService']);
  });
});
