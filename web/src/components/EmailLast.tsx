import { useEffect, useRef, useState } from 'react';
import { fetchEmailHistory, fetchLastEmails, type EmailHistoryEntry } from '../api';
import { formatDateTime } from '../format';

/**
 * "Last email" on the Contacts tables: the newest campaign a person was in,
 * with what happened to it, and the full history on click.
 */

export function emailOutcome(entry: EmailHistoryEntry): { label: string; tone: string } {
  if (entry.status === 'failed') return { label: 'Failed', tone: 'bad' };
  if (entry.status === 'skipped') return { label: 'Skipped', tone: 'muted' };
  if (entry.status === 'queued' || entry.status === 'sending') return { label: 'Waiting', tone: 'muted' };
  if (entry.complainedAt) return { label: 'Spam complaint', tone: 'bad' };
  if (entry.bouncedAt) return { label: 'Bounced', tone: 'bad' };
  if (entry.unsubscribedAt) return { label: 'Unsubscribed', tone: 'warn' };
  if (entry.clickedAt) return { label: 'Clicked', tone: 'good' };
  if (entry.openedAt) return { label: 'Opened', tone: 'good' };
  if (entry.deliveredAt) return { label: 'Delivered', tone: 'good' };
  return { label: 'Sent', tone: 'muted' };
}

/** The last email for the rows on screen; one request per page of addresses. */
export function useLastEmails(emails: string[]): Record<string, EmailHistoryEntry> {
  const [last, setLast] = useState<Record<string, EmailHistoryEntry>>({});
  const key = emails.join(',');
  useEffect(() => {
    if (!key) {
      setLast({});
      return;
    }
    let cancelled = false;
    fetchLastEmails(key.split(','))
      .then((result) => !cancelled && setLast(result.last))
      .catch(() => !cancelled && setLast({}));
    return () => {
      cancelled = true;
    };
  }, [key]);
  return last;
}

function HistoryModal({ email, onClose }: { email: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [history, setHistory] = useState<EmailHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    fetchEmailHistory(email)
      .then((result) => setHistory(result.history))
      .catch((cause: Error) => setError(cause.message));
  }, [email]);

  return (
    <dialog ref={dialog} className="modal" onClose={onClose} aria-labelledby="email-history-title">
      <div className="modal-head">
        <h2 id="email-history-title">Emails to {email}</h2>
        <button type="button" className="modal-close" aria-label="Close" onClick={() => dialog.current?.close()}>
          ×
        </button>
      </div>
      {error ? <p className="channel-status bad">{error}</p> : null}
      {history === null && !error ? <p className="email-empty">Loading…</p> : null}
      {history && history.length === 0 ? <p className="email-empty">No campaign went to this person yet.</p> : null}
      {history && history.length > 0 ? (
        <div className="table-wrap">
          <table className="email-table">
            <thead>
              <tr>
                <th scope="col">Campaign</th>
                <th scope="col">Sent</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry) => {
                const outcome = emailOutcome(entry);
                return (
                  <tr key={entry.campaignId}>
                    <td>
                      <a className="customer-link" href={`#/email/${encodeURIComponent(entry.campaignId)}`}>
                        {entry.name}
                      </a>
                      <span className="cell-note">{entry.subject}</span>
                    </td>
                    <td>{entry.sentAt ? formatDateTime(entry.sentAt) : '—'}</td>
                    <td>
                      <span className={`email-outcome email-outcome-${outcome.tone}`}>{outcome.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </dialog>
  );
}

export function LastEmailCell({ email, entry }: { email: string; entry: EmailHistoryEntry | undefined }) {
  const [open, setOpen] = useState(false);
  if (!entry) {
    return (
      <td>
        <span className="muted">—</span>
      </td>
    );
  }
  const outcome = emailOutcome(entry);
  return (
    <td>
      <button type="button" className="link-button email-last" onClick={() => setOpen(true)}>
        {entry.name}
      </button>
      <span className={`email-outcome email-outcome-${outcome.tone}`}>{outcome.label}</span>
      {open ? <HistoryModal email={email} onClose={() => setOpen(false)} /> : null}
    </td>
  );
}
