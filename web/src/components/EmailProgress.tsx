import { useEffect, useRef, useState } from 'react';
import {
  cancelCampaign,
  fetchSends,
  pauseCampaign,
  renderCampaign,
  resumeCampaign,
  type EmailCampaign,
  type RenderedPreview,
  type SentEmailRow,
} from '../api';
import { formatDateTime } from '../format';
import { CampaignStatusPill } from './EmailCampaigns';

/**
 * A campaign after Send: progress, Pause while it sends, and — while it is
 * paused — the people who got it so far, each one viewable as they got it,
 * with Resume and Cancel.
 */

export const PAUSE_CHOICES = [5, 10, 25] as const;

function PreviewModal({ campaignId, email, onClose }: { campaignId: string; email: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<RenderedPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    renderCampaign(campaignId, { email })
      .then(setPreview)
      .catch((cause: Error) => setError(cause.message));
  }, [campaignId, email]);

  return (
    <dialog ref={dialog} className="modal email-sent-modal" onClose={onClose} aria-labelledby="email-sent-title">
      <div className="modal-head">
        <h2 id="email-sent-title">The email to {email}</h2>
        <button type="button" className="modal-close" aria-label="Close" onClick={() => dialog.current?.close()}>
          ×
        </button>
      </div>
      {error ? <p className="channel-status bad">{error}</p> : null}
      {preview ? (
        <>
          <dl className="email-headers">
            <dt>From</dt>
            <dd>{preview.from}</dd>
            {preview.replyTo ? (
              <>
                <dt>Reply-To</dt>
                <dd>{preview.replyTo}</dd>
              </>
            ) : null}
            <dt>Subject</dt>
            <dd>{preview.subject}</dd>
          </dl>
          <iframe className="email-frame" title={`The email to ${email}`} sandbox="" srcDoc={preview.html} />
          <p className="email-sub">
            Rendered again from the same values that went out. A yellow mark shows a fallback value; the sent email has no
            marks.
          </p>
        </>
      ) : error ? null : (
        <p className="email-empty">Rendering…</p>
      )}
    </dialog>
  );
}

function SentList({ campaign }: { campaign: EmailCampaign }) {
  const [rows, setRows] = useState<SentEmailRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [viewing, setViewing] = useState<string | null>(null);

  useEffect(() => {
    fetchSends(campaign.id, { status: 'sent', limit: 100 })
      .then((result) => {
        setRows(result.rows);
        setTotal(result.total);
      })
      .catch(() => setRows([]));
  }, [campaign.id, campaign.counts.sent]);

  if (!rows) return <p className="email-empty">Loading the sent emails…</p>;
  if (rows.length === 0) return null;

  return (
    <div className="email-sent">
      <h3 className="card-label">Sent so far</h3>
      <div className="table-wrap">
        <table className="email-table">
          <thead>
            <tr>
              <th scope="col">Recipient</th>
              <th scope="col">Store</th>
              <th scope="col">Sent</th>
              <th scope="col">
                <span className="sr-only">View</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.email}>
                <td>
                  {row.name ? <b>{row.name}</b> : null}
                  {row.name ? ' · ' : ''}
                  {row.email}
                </td>
                <td>{row.shopName ?? '—'}</td>
                <td>{row.sentAt ? formatDateTime(row.sentAt) : '—'}</td>
                <td>
                  <button type="button" className="link-button" onClick={() => setViewing(row.email)}>
                    View email
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > rows.length ? <p className="email-sub">Showing the first {rows.length} of {total.toLocaleString()}.</p> : null}
      {viewing ? <PreviewModal campaignId={campaign.id} email={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}

export function EmailProgress({
  campaign,
  onChange,
}: {
  campaign: EmailCampaign;
  onChange: (campaign: EmailCampaign) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [next, setNext] = useState<string>('all');
  const total = campaign.recipientCount || 1;
  const done = campaign.counts.sent + campaign.counts.failed;
  const left = campaign.counts.queued;
  const paused = campaign.status === 'paused';

  const act = async (label: string, fn: () => Promise<EmailCampaign>) => {
    setBusy(label);
    setError(null);
    try {
      onChange(await fn());
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card full email-card">
      <div className="card-head">
        <div>
          <h2 className="card-label">
            {campaign.name} <CampaignStatusPill status={campaign.status} />
          </h2>
          <p className="email-sub">
            Subject: {campaign.subject}
            {campaign.startedAt ? ` · started ${formatDateTime(campaign.startedAt)}` : ''}
            {campaign.finishedAt ? ` · finished ${formatDateTime(campaign.finishedAt)}` : ''}
          </p>
        </div>
        {campaign.status === 'sending' ? (
          <div className="email-actions">
            {left > 0 ? (
              <button type="button" onClick={() => act('pause', () => pauseCampaign(campaign.id))} disabled={busy !== null}>
                {busy === 'pause' ? 'Pausing…' : 'Pause'}
              </button>
            ) : null}
            <button type="button" onClick={() => act('cancel', () => cancelCampaign(campaign.id))} disabled={busy !== null}>
              {busy === 'cancel' ? 'Cancelling…' : 'Cancel'}
            </button>
          </div>
        ) : null}
      </div>
      <div
        className="email-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={campaign.recipientCount}
        aria-valuenow={campaign.counts.sent}
        aria-label="Sent"
      >
        <span style={{ width: `${Math.min(100, (done / total) * 100)}%` }} />
      </div>
      <p>
        <b>{campaign.counts.sent.toLocaleString()}</b> of {campaign.recipientCount.toLocaleString()} sent ·{' '}
        {campaign.counts.failed.toLocaleString()} failed · {campaign.counts.skipped.toLocaleString()} skipped
        {left > 0 ? ` · ${left.toLocaleString()} waiting` : ''}
      </p>
      {campaign.status === 'sending' ? (
        <p className="email-sub">
          This page updates every 3 seconds. You can leave it; sending goes on.
          {campaign.pauseAt !== null ? ` It pauses by itself after ${campaign.pauseAt.toLocaleString()} emails.` : ''}
        </p>
      ) : null}

      {paused ? (
        <div className="notice warn email-paused">
          <h2>Paused</h2>
          <p>
            {done.toLocaleString()} email{done === 1 ? '' : 's'} went out. {left.toLocaleString()} wait. Check the sent
            emails below, or open them in{' '}
            <a href="https://resend.com/emails" target="_blank" rel="noreferrer noopener">
              Resend → Emails
            </a>
            . Then resume or cancel.
          </p>
          <p className="email-sub">
            Unsubscribes and suppressions are checked again before each batch, so nobody who left during the pause gets
            the email.
          </p>
          <div className="email-actions">
            <div className="control">
              <label htmlFor="email-resume-next">Resume with</label>
              <select id="email-resume-next" value={next} onChange={(event) => setNext(event.target.value)}>
                <option value="all">All the rest ({left.toLocaleString()})</option>
                {PAUSE_CHOICES.filter((n) => n < left).map((n) => (
                  <option key={n} value={String(n)}>
                    {n} more, then pause
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="primary"
              disabled={busy !== null}
              onClick={() => act('resume', () => resumeCampaign(campaign.id, next === 'all' ? null : Number(next)))}
            >
              {busy === 'resume'
                ? 'Resuming…'
                : next === 'all'
                  ? `Send the other ${left.toLocaleString()}`
                  : `Send ${next} more`}
            </button>
            <button type="button" onClick={() => act('cancel', () => cancelCampaign(campaign.id))} disabled={busy !== null}>
              {busy === 'cancel' ? 'Cancelling…' : 'Cancel the rest'}
            </button>
          </div>
        </div>
      ) : null}

      {error ? <p className="channel-status bad">{error}</p> : null}
      {paused || campaign.status === 'sent' || campaign.status === 'cancelled' ? <SentList campaign={campaign} /> : null}
    </section>
  );
}
