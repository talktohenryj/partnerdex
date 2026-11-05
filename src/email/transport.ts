import { getConfig } from '../config.js';
import { resendTransport } from './resend.js';

/**
 * The one seam between PartnerDex and whoever delivers the mail.
 *
 * Resend is the only implementation. Tests replace it with a fake through
 * setTransportForTests() and never reach the network.
 */

export interface OutgoingEmail {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

export type DomainStatus = 'verified' | 'pending' | 'failed' | 'not_found';

export interface EmailTransport {
  /** At most 100 emails. The ids come back in input order. */
  sendBatch(emails: OutgoingEmail[], idempotencyKey: string): Promise<{ ids: string[] }>;
  sendOne(email: OutgoingEmail): Promise<{ id: string }>;
  domainStatus(domain: string): Promise<DomainStatus>;
}

export class TransportError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** Network errors, 429, and 5xx: the same request may succeed later. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export const MAX_BATCH = 100;

let override: EmailTransport | null = null;

export function setTransportForTests(transport: EmailTransport | null): void {
  override = transport;
}

/** The configured transport, or null when RESEND_API_KEY is unset. */
export function getTransport(): EmailTransport | null {
  if (override) return override;
  const key = getConfig().email.resendApiKey;
  return key ? resendTransport(key) : null;
}
