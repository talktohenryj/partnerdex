import { useEffect, useRef, useState } from 'react';
import {
  cancelCampaign,
  fetchFailureGroups,
  fetchSends,
  pauseCampaign,
  renderCampaign,
  resumeCampaign,
  retryFailed,
  type EmailCampaign,
  type FailureGroup,
  type RenderedPreview,
  type SendFilter,
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

function percent(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

function StatTiles({ campaign }: { campaign: EmailCampaign }) {
  const { stats, rates } = campaign;
  if (stats.sent === 0) return null;
  const deliveredRate = stats.sent > 0 ? stats.delivered / stats.sent : null;
  const tiles: Array<{ label: string; value: number; note: string }> = [
    { label: 'Sent', value: stats.sent, note: stats.failed ? `${stats.failed.toLocaleString()} failed` : '' },
    { label: 'Delivered', value: stats.delivered, note: percent(deliveredRate) },
    { label: 'Opened ≈', value: stats.opened, note: `${percent(rates.open)} · approximate` },
    { label: 'Clicked', value: stats.clicked, note: percent(rates.click) },
    {
      label: 'Bounced',
      value: stats.bounced,
      note: `${percent(rates.bounce)}${stats.complained ? ` · ${stats.complained} spam complaint${stats.complained === 1 ? '' : 's'}` : ''}`,
    },
    { label: 'Unsubscribed', value: stats.unsubscribed, note: percent(rates.unsubscribe) },
  ];
  return (
    <>
      <div className="stat-row email-stats">
        {tiles.map((tile) => (
          <div className="stat" key={tile.label}>
            <div className="stat-label">{tile.label}</div>
            <div className="stat-value">{tile.value.toLocaleString()}</div>
            {tile.note ? <div className="stat-note">{tile.note}</div> : null}
          </div>
        ))}
      </div>
      <p className="email-sub">
        Opens are approximate: some mail apps load images for privacy, and some block them. Rates are over delivered;
        bounces are over sent. Delivery events come from the Resend webhook.
      </p>
    </>
  );
}

const WAIT_TEXT: Record<NonNullable<EmailCampaign['waiting']>['reason'], (until: string) => string> = {
  daily_limit: (until) => `The daily limit is reached. The rest sends after midnight UTC (${until} your time).`,
  daily_quota: (until) => `The Resend daily quota is reached. The rest sends after midnight UTC (${until} your time).`,
  monthly_quota: () =>
    'The Resend monthly quota is reached. Upgrade the Resend plan or wait for the next month. Sending tries again every hour.',
};

function WaitingBanner({ campaign }: { campaign: EmailCampaign }) {
  if (!campaign.waiting) return null;
  return (
    <div className="notice warn" role="status">
      <h2>Waiting to send</h2>
      <p>{WAIT_TEXT[campaign.waiting.reason](formatDateTime(campaign.waiting.until))}</p>
      <p className="email-sub">Nothing failed. The emails that wait stay in the queue.</p>
    </div>
  );
}

function RetryDialog({
  campaign,
  onClose,
  onDone,
}: {
  campaign: EmailCampaign;
  onClose: () => void;
  onDone: (campaign: EmailCampaign) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [groups, setGroups] = useState<FailureGroup[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    fetchFailureGroups(campaign.id)
      .then((result) => {
        setGroups(result.groups);
        setChosen(new Set(result.groups.filter((group) => !group.rejected).map((group) => group.error)));
      })
      .catch((cause: Error) => setError(cause.message));
  }, [campaign.id]);

  const total = (groups ?? []).filter((group) => chosen.has(group.error)).reduce((sum, group) => sum + group.count, 0);
  const uncertain = (groups ?? []).some((group) => group.uncertain && chosen.has(group.error));
  const toggle = (error: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(error)) next.delete(error);
      else next.add(error);
      return next;
    });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await retryFailed(campaign.id, [...chosen], Number(typed)));
      dialog.current?.close();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialog} className="modal" onClose={onClose} aria-labelledby="email-retry-title">
      <div className="modal-head">
        <h2 id="email-retry-title">Retry failed emails</h2>
        <button type="button" className="modal-close" aria-label="Close" onClick={() => dialog.current?.close()}>
          ×
        </button>
      </div>
      {groups === null && !error ? <p className="email-empty">Loading…</p> : null}
      {groups && groups.length === 0 ? <p className="email-empty">No failed email can be retried.</p> : null}
      {groups && groups.length > 0 ? (
        <>
          <p className="email-sub">
            Choose the failures to send again. Opt-outs and suppressions are checked again before each batch, and the
            daily limit applies.
          </p>
          <ul className="email-retry-groups">
            {groups.map((group) => (
              <li key={group.error}>
                <label>
                  <input type="checkbox" checked={chosen.has(group.error)} onChange={() => toggle(group.error)} />{' '}
                  <b>{group.count.toLocaleString()}</b> · {group.error || 'No error text'}
                </label>
                {group.rejected ? <span className="cell-note">Resend refused these. They will likely fail again.</span> : null}
              </li>
            ))}
          </ul>
          {uncertain ? (
            <div className="notice warn">
              <p>
                Resend may have sent some of these. Check the{' '}
                <a href="https://resend.com/emails" target="_blank" rel="noreferrer noopener">
                  Resend log
                </a>{' '}
                first. A 429 quota error means Resend sent nothing, so those are safe.
              </p>
            </div>
          ) : null}
          <div className="email-actions">
            <div className="control">
              <label htmlFor="email-retry-count">Type {total.toLocaleString()} to confirm</label>
              <input
                id="email-retry-count"
                inputMode="numeric"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
              />
            </div>
            <button
              type="button"
              className="primary"
              disabled={busy || total === 0 || Number(typed) !== total}
              onClick={submit}
            >
              {busy ? 'Queuing…' : `Send ${total.toLocaleString()} again`}
            </button>
          </div>
        </>
      ) : null}
      {error ? <p className="channel-status bad">{error}</p> : null}
    </dialog>
  );
}

const REPORT_FILTERS: Array<{ key: SendFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'opened', label: 'Opened' },
  { key: 'clicked', label: 'Clicked' },
  { key: 'bounced', label: 'Bounced' },
  { key: 'complained', label: 'Spam complaint' },
  { key: 'unsubscribed', label: 'Unsubscribed' },
  { key: 'failed', label: 'Failed' },
  { key: 'skipped', label: 'Skipped' },
];

function rowResult(row: SentEmailRow): string {
  if (row.status === 'failed') return `Failed${row.error ? ` · ${row.error}` : ''}`;
  if (row.status === 'skipped') return `Skipped${row.skipReason ? ` · ${row.skipReason.replace(/_/g, ' ')}` : ''}`;
  if (row.status !== 'sent') return 'Waiting';
  const parts: string[] = [];
  if (row.complainedAt) parts.push('spam complaint');
  if (row.bouncedAt) parts.push('bounced');
  if (row.deliveredAt) parts.push('delivered');
  if (row.openedAt) parts.push('opened');
  if (row.clickedAt) parts.push('clicked');
  if (row.unsubscribedAt) parts.push('unsubscribed');
  const text = parts.length ? parts.join(' · ') : 'sent';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function ReportList({ campaign }: { campaign: EmailCampaign }) {
  const [filter, setFilter] = useState<SendFilter>('all');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<SentEmailRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [viewing, setViewing] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchSends(campaign.id, { status: filter, q: q.trim() || undefined, limit: 100 })
        .then((result) => {
          if (cancelled) return;
          setRows(result.rows);
          setTotal(result.total);
        })
        .catch(() => !cancelled && setRows([]));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [campaign.id, filter, q, campaign.counts.sent, campaign.counts.failed]);

  return (
    <div className="email-sent">
      <h3 className="card-label">Recipients</h3>
      <div className="email-actions email-actions-wrap">
        {REPORT_FILTERS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            className={`email-chip${filter === entry.key ? ' on' : ''}`}
            aria-pressed={filter === entry.key}
            onClick={() => setFilter(entry.key)}
          >
            {entry.label}
          </button>
        ))}
        <input
          type="search"
          className="email-search"
          placeholder="Search name, email, store"
          aria-label="Search recipients"
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
      </div>
      {rows === null ? <p className="email-empty">Loading…</p> : null}
      {rows && rows.length === 0 ? <p className="email-empty">No one matches.</p> : null}
      {rows && rows.length > 0 ? (
        <div className="table-wrap">
          <table className="email-table">
            <thead>
              <tr>
                <th scope="col">Recipient</th>
                <th scope="col">Store</th>
                <th scope="col">Result</th>
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
                  <td>{rowResult(row)}</td>
                  <td>{row.sentAt ? formatDateTime(row.sentAt) : '—'}</td>
                  <td>
                    {row.status === 'sent' ? (
                      <button type="button" className="link-button" onClick={() => setViewing(row.email)}>
                        View email
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {rows && total > rows.length ? <p className="email-sub">Showing the first {rows.length} of {total.toLocaleString()}.</p> : null}
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
  const [retrying, setRetrying] = useState(false);
  const finished = campaign.status === 'sent' || campaign.status === 'failed' || campaign.status === 'cancelled';
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
        {(campaign.status === 'sent' || campaign.status === 'failed') && campaign.counts.failed > 0 ? (
          <div className="email-actions">
            <button type="button" onClick={() => setRetrying(true)}>
              Retry {campaign.counts.failed.toLocaleString()} failed
            </button>
          </div>
        ) : null}
      </div>
      <WaitingBanner campaign={campaign} />
      <StatTiles campaign={campaign} />
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
      {paused ? <SentList campaign={campaign} /> : null}
      {finished ? <ReportList campaign={campaign} /> : null}
      {retrying ? <RetryDialog campaign={campaign} onClose={() => setRetrying(false)} onDone={onChange} /> : null}
    </section>
  );
}
