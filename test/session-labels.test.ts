import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogs } from '../web/catalogs.js';

test('session panel controls and author labels are translated in English and Polish', () => {
  const keys = [
    'sessionFollowEnabled',
    'sessionFollowDisabled',
    'sessionActiveGroup',
    'sessionHistoryGroup',
    'sessionOutputPending',
    'sessionOutputEmpty',
    'sessionAuthorHuman',
    'sessionAuthorCoordinator',
    'sessionAuthorAgent',
    'sessionAuthorDelegation',
    'sessionAuthorSystem',
    'sessionAuthorSynthetic',
    'sessionAuthorUnknown',
  ];
  for (const locale of ['en', 'pl'])
    for (const key of keys) {
      assert.equal(typeof catalogs[locale][key], 'string', `${locale}.${key}`);
      assert.notEqual(catalogs[locale][key], key, `${locale}.${key}`);
    }
});
