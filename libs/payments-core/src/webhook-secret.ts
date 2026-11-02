import { randomBytes } from 'node:crypto';

/** The secret a merchant verifies our signatures with: `whsec_` and 256 random bits. Shown once, when created or rotated. */
export function generateWebhookSecret(random: (n: number) => Buffer = randomBytes): string {
  return `whsec_${random(32).toString('base64url')}`;
}
