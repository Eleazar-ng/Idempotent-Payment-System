import type { Kysely } from 'kysely';
import type { Database } from './database.types';

export async function getWebhookEndpoint(db: Kysely<Database>, merchantId: number): Promise<{ url: string } | undefined> {
  const row = await db.selectFrom('merchants').select('webhook_url').where('id', '=', merchantId).executeTakeFirst();
  return row?.webhook_url ? { url: row.webhook_url } : undefined;
}

/**
 * Sets where a merchant's events go. The first time, `newSecret` becomes the signing secret (`created: true`: show it once).
 * Afterwards only the URL changes and the existing secret is kept, so a merchant who edits the URL does not have to redeploy
 * their verifier. One statement: two concurrent first registrations cannot both think they created the secret.
 */
export async function setWebhookEndpoint(
  db: Kysely<Database>,
  merchantId: number,
  url: string,
  newSecret: string,
): Promise<{ created: boolean } | undefined> {
  const row = await db
    .updateTable('merchants')
    .set((eb) => ({ webhook_url: url, webhook_secret: eb.fn.coalesce('webhook_secret', eb.val(newSecret)) }))
    .where('id', '=', merchantId)
    .returning(['webhook_secret'])
    .executeTakeFirst();
  return row ? { created: row.webhook_secret === newSecret } : undefined;
}

/** Replaces the signing secret. False if the merchant has no endpoint to rotate. Events already signed keep the secret they were signed with only until their next retry: they are signed at SEND time. */
export async function rotateWebhookSecret(db: Kysely<Database>, merchantId: number, newSecret: string): Promise<boolean> {
  const r = await db
    .updateTable('merchants')
    .set({ webhook_secret: newSecret })
    .where('id', '=', merchantId)
    .where('webhook_url', 'is not', null)
    .executeTakeFirst();
  return Number(r.numUpdatedRows) === 1;
}

/** Removes the endpoint. Events not yet delivered are skipped from then on (Stage 8). */
export async function clearWebhookEndpoint(db: Kysely<Database>, merchantId: number): Promise<void> {
  await db.updateTable('merchants').set({ webhook_url: null, webhook_secret: null }).where('id', '=', merchantId).execute();
}
