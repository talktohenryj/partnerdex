import type { DomainStatus, EmailRecord, EmailTransport, OutgoingEmail } from './transport.js';
import { TransportError } from './transport.js';

/**
 * Resend over plain fetch. No SDK: three endpoints do not justify a
 * dependency, and upstream stays light.
 */

const API = 'https://api.resend.com';
const TIMEOUT_MS = 15_000;

function payload(email: OutgoingEmail): Record<string, unknown> {
  return {
    from: email.from,
    to: [email.to],
    ...(email.replyTo ? { reply_to: email.replyTo } : {}),
    subject: email.subject,
    text: email.text,
    html: email.html,
    headers: email.headers,
  };
}

async function call(
  apiKey: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    throw new TransportError(
      `Could not reach Resend: ${cause instanceof Error ? cause.message : String(cause)}`,
      null,
      true,
    );
  }

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const message =
      parsed && typeof parsed === 'object' && typeof (parsed as { message?: unknown }).message === 'string'
        ? (parsed as { message: string }).message
        : `HTTP ${response.status}`;
    const name =
      parsed && typeof parsed === 'object' && typeof (parsed as { name?: unknown }).name === 'string'
        ? (parsed as { name: string }).name
        : null;
    const retryable = response.status === 429 || response.status >= 500;
    throw new TransportError(`Resend: ${message}`, response.status, retryable, name);
  }
  return parsed;
}

export function resendTransport(apiKey: string): EmailTransport {
  return {
    async sendBatch(emails, idempotencyKey) {
      const result = (await call(apiKey, 'POST', '/emails/batch', emails.map(payload), {
        'Idempotency-Key': idempotencyKey,
      })) as { data?: Array<{ id?: string }> } | null;
      const ids = (result?.data ?? []).map((entry) => String(entry.id ?? ''));
      if (ids.length !== emails.length) {
        throw new TransportError(
          `Resend returned ${ids.length} ids for ${emails.length} emails.`,
          null,
          false,
        );
      }
      return { ids };
    },

    async sendOne(email) {
      const result = (await call(apiKey, 'POST', '/emails', payload(email))) as { id?: string } | null;
      return { id: String(result?.id ?? '') };
    },

    async getEmail(id): Promise<EmailRecord> {
      const result = (await call(apiKey, 'GET', `/emails/${encodeURIComponent(id)}`)) as {
        last_event?: unknown;
        created_at?: unknown;
      } | null;
      return {
        lastEvent: typeof result?.last_event === 'string' ? result.last_event : null,
        createdAt: typeof result?.created_at === 'string' ? result.created_at : null,
      };
    },

    async domainStatus(domain): Promise<DomainStatus> {
      const result = (await call(apiKey, 'GET', '/domains')) as {
        data?: Array<{ name?: string; status?: string }>;
      } | null;
      const wanted = domain.toLowerCase();
      const match = (result?.data ?? []).find((entry) => (entry.name ?? '').toLowerCase() === wanted);
      if (!match) return 'not_found';
      if (match.status === 'verified') return 'verified';
      if (match.status === 'failed' || match.status === 'temporary_failure') return 'failed';
      return 'pending';
    },
  };
}
