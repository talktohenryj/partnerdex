import { getDb } from '../src/db/index.js';
import { upsertContact } from '../src/contacts/upsert.js';
import { saveSettings } from '../src/email/settings.js';
import {
  setTransportForTests,
  TransportError,
  type DomainStatus,
  type EmailTransport,
  type OutgoingEmail,
} from '../src/email/transport.js';
import { resetTestLimits } from '../src/email/campaigns.js';
import { APP_ID, resetEnvironment, seed } from './helpers.js';

export const SECRET = 'test-secret-test-secret-test-secret-0123';
export const BASE = 'https://partnerdex.example.com';

export const SENDING_ENV = {
  DASHBOARD_PASSWORD: 'correct horse battery',
  RESEND_API_KEY: 're_test',
  PUBLIC_BASE_URL: BASE,
  EMAIL_LINK_SECRET: SECRET,
};

export interface FakeCall {
  kind: 'batch' | 'one';
  key?: string;
  emails: OutgoingEmail[];
}

export class FakeTransport implements EmailTransport {
  calls: FakeCall[] = [];
  domain: DomainStatus = 'verified';
  /** Errors to throw on the next batch calls, in order. */
  failures: Array<TransportError> = [];
  private seq = 0;

  async sendBatch(emails: OutgoingEmail[], idempotencyKey: string) {
    this.calls.push({ kind: 'batch', key: idempotencyKey, emails });
    const failure = this.failures.shift();
    if (failure) throw failure;
    return { ids: emails.map(() => `re_${++this.seq}`) };
  }

  async sendOne(email: OutgoingEmail) {
    this.calls.push({ kind: 'one', emails: [email] });
    return { id: `re_${++this.seq}` };
  }

  async domainStatus(): Promise<DomainStatus> {
    return this.domain;
  }

  batches(): FakeCall[] {
    return this.calls.filter((call) => call.kind === 'batch');
  }
}

export function retryable(): TransportError {
  return new TransportError('Resend: service unavailable', 503, true);
}

export function rejected(): TransportError {
  return new TransportError('Resend: invalid from address', 422, false);
}

/** A sending-ready environment: env set, sender saved, a fake transport in place. */
export function sendingSetup(env: Record<string, string> = SENDING_ENV): FakeTransport {
  resetEnvironment({ PARTNER_APP_IDS: APP_ID, ...env });
  resetTestLimits();
  const fake = new FakeTransport();
  setTransportForTests(fake);
  return fake;
}

export function saveSender(): void {
  saveSettings({
    fromName: 'Sam from Example App',
    fromEmail: 'sam@updates.example.com',
    replyTo: 'sam@example.com',
    footerAddress: '123 Placeholder St, Example City, ST 00000',
  });
}

/**
 * `count` paying shops, one owner each, named owner<N>@example-shop<N>.test.
 * Shop 1's myshopify domain is example-candles.myshopify.com.
 */
export function seedOwners(count: number, firstName: (index: number) => string | null = (i) => `Owner${i}`): void {
  const ids = Array.from({ length: count }, (_, index) => String(index + 1));
  seed(
    ids.map((shopId) => ({
      chargeRef: `pay-${shopId}`,
      shopId,
      amount: 30,
      activatedAt: '2024-01-01T00:00:00Z',
      firstSaleAt: '2024-01-02T00:00:00Z',
    })),
  );
  const db = getDb();
  db.prepare(`UPDATE shops SET myshopify_domain = 'example-candles.myshopify.com', name = 'Example Candles Co' WHERE id = '1'`).run();
  db.prepare(`INSERT OR IGNORE INTO apps (id, name, discovered_at) VALUES (?, 'Example App', '2024-01-01')`).run(APP_ID);
  db.prepare(`UPDATE apps SET name = 'Example App' WHERE id = ?`).run(APP_ID);
  ids.forEach((shopId, index) => {
    upsertContact(
      {
        email: `owner${shopId.padStart(3, '0')}@example-shop${shopId}.test`,
        firstName: firstName(index + 1),
        shop: { appId: APP_ID, shopId },
        role: 'owner',
        source: 'csv_import',
        seenAt: '2026-08-01T00:00:00.000Z',
      },
      db,
    );
  });
}

export const PAYING_OWNERS = { appId: APP_ID, statuses: ['paying'], roles: ['owner'] };
