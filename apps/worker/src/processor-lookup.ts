import { z } from 'zod';
import type { ChargeSnapshot } from '@app/payments-core';

/** The processor could not be asked, or its answer cannot be trusted. Callers change NOTHING when they see this. */
export class ProcessorLookupError extends Error {
  readonly code = 'PROCESSOR_LOOKUP_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'ProcessorLookupError';
  }
}

const chargeSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['succeeded', 'failed', 'requires_action', 'pending']),
  amount: z.number().int(),
  currency: z.string(),
  failure_code: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  created: z.number().int().optional(),
});
const listSchema = z.object({ data: z.array(chargeSchema) });

export interface ListedCharge {
  charge: ChargeSnapshot;
  /** `metadata.reference`: the attempt's processor idempotency key, if it carried one. */
  reference: string | undefined;
  /** Unix seconds. */
  created: number | undefined;
}

export interface ProcessorLookupOptions {
  baseUrl: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

/**
 * Read-only questions to the processor, for recovery and reconciliation.
 *
 * The one rule: "I could not find out" is an exception, never a `null`. A `null` means the processor
 * answered and has no such charge, and recovery acts on that (it may mark an attempt unknown or never
 * sent); acting on a failed lookup would turn a network blip into a wrong answer about money.
 */
export class ProcessorLookup {
  constructor(private readonly options: ProcessorLookupOptions) {}

  async findByReference(reference: string): Promise<ChargeSnapshot | null> {
    const charges = await this.get(`/v1/charges?reference=${encodeURIComponent(reference)}`);
    if (charges.length === 0) return null;
    if (charges.length > 1) {
      // Two charges for one idempotency key should be impossible. Do not pick one.
      throw new ProcessorLookupError(`${charges.length} charges carry reference ${reference}`);
    }
    return toListed(charges[0]).charge;
  }

  async listCharges(): Promise<ListedCharge[]> {
    return (await this.get('/v1/charges')).map(toListed);
  }

  private async get(path: string): Promise<z.infer<typeof chargeSchema>[]> {
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`${this.options.baseUrl}${path}`, {
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw new ProcessorLookupError(`processor unreachable: ${(error as Error).message}`);
    }
    if (!response.ok) throw new ProcessorLookupError(`processor answered ${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ProcessorLookupError('processor answered with something that is not JSON');
    }
    const parsed = listSchema.safeParse(body);
    if (!parsed.success) throw new ProcessorLookupError('processor answered with an unexpected shape');
    return parsed.data.data;
  }
}

function toListed(c: z.infer<typeof chargeSchema>): ListedCharge {
  return {
    charge: { id: c.id, status: c.status, amount: c.amount, currency: c.currency, failureCode: c.failure_code ?? null },
    reference: c.metadata?.reference,
    created: c.created,
  };
}
