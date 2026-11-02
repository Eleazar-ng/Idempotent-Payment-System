import { createDb } from './create-db';
import { createApiKey, createMerchantWithKey, listApiKeys, revokeApiKey } from './api-keys';

/**
 * Operator commands (`pnpm admin <command>`). There is no public sign-up: merchants and keys are created by someone with
 * access to the database, which is the point. Keys are printed once and cannot be shown again.
 *
 *   merchant:create <name>            creates a merchant and its first key
 *   key:create <merchantId> [name]    adds a key (rotation: create the new one, deploy it, then revoke the old one)
 *   key:revoke <prefix>               ends a key immediately
 *   key:list <merchantId>             shows a merchant's keys (prefix, state), never the secrets
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (copy .env.example to .env first)');
  const [command, ...args] = process.argv.slice(2);
  const db = createDb(url, { maxConnections: 1 });
  try {
    switch (command) {
      case 'merchant:create': {
        const name = args.join(' ').trim();
        if (!name) throw new Error('usage: merchant:create <name>');
        const { merchantId, key } = await createMerchantWithKey(db, { name });
        console.log(`merchant ${merchantId} created`);
        printKey(key.prefix, key.key);
        break;
      }
      case 'key:create': {
        const merchantId = Number(args[0]);
        if (!Number.isInteger(merchantId) || merchantId < 1) throw new Error('usage: key:create <merchantId> [name]');
        const key = await createApiKey(db, { merchantId, name: args.slice(1).join(' ').trim() || 'key' });
        printKey(key.prefix, key.key);
        break;
      }
      case 'key:revoke': {
        if (!args[0]) throw new Error('usage: key:revoke <prefix>');
        console.log((await revokeApiKey(db, args[0])) ? `key ${args[0]} revoked` : `no active key with prefix ${args[0]}`);
        break;
      }
      case 'key:list': {
        const merchantId = Number(args[0]);
        if (!Number.isInteger(merchantId) || merchantId < 1) throw new Error('usage: key:list <merchantId>');
        for (const k of await listApiKeys(db, merchantId)) {
          const state = k.revoked_at ? 'revoked' : k.expires_at && k.expires_at <= new Date() ? 'expired' : 'active';
          console.log(`${k.key_prefix}  ${state.padEnd(7)}  ${k.name}  last used: ${k.last_used_at?.toISOString() ?? 'never'}`);
        }
        break;
      }
      default:
        throw new Error('commands: merchant:create <name> | key:create <merchantId> [name] | key:revoke <prefix> | key:list <merchantId>');
    }
  } finally {
    await db.destroy();
  }
}

function printKey(prefix: string, key: string): void {
  console.log(`key ${prefix} created. Copy it now; it cannot be shown again:\n\n  ${key}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
