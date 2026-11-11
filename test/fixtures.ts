import type { Plugin } from '@opencode/plugin';

/** Only get/set/remove are exercised by the session observer checks. */
export function memoryStorage(): Plugin.Context['storage'] {
  type Value = Parameters<Plugin.Context['storage']['set']>[1];
  const values = new Map<string, Value>();
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => {
      values.set(key, value);
    },
    remove: async (key) => {
      values.delete(key);
    },
    scan: async () => {
      throw new Error('Storage scan is not part of this fixture');
    },
  };
}
