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

function RecipientCell({ row }: { row: SentEmailRow }) {
  return (
    <div className="email-recipient">
      {row.name ? <b>{row.name}</b> : null}
      <span className={row.name ? 'email-recipient-address' : undefined}>{row.email}</span>
    </div>
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
                  <RecipientCell row={row} />
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

type Outcome = keyof EmailCampaign['outcomes'];

const OUTCOMES: Array<{ key: Outcome; label: string }> = [
  { key: 'delivered', label: 'Delivered' },
  { key: 'pending', label: 'Sent, no result yet' },
  { key: 'bounced', label: 'Bounced' },
  { key: 'failed', label: 'Failed' },
  { key: 'skipped', label: 'Skipped' },
  { key: 'queued', label: 'Queued' },
];

function of(part: number, whole: number, base: string): string {
  return whole > 0 ? `${percent(part / whole)} of ${base}` : '—';
}

function OutcomeSummary({ campaign }: { campaign: EmailCampaign }) {
  const { stats, rates, outcomes } = campaign;
  if (stats.total === 0) return null;
  // Always show the four end states; show pending and queued only while they hold anyone.
  const shown = OUTCOMES.filter((entry) => outcomes[entry.key] > 0 || !['pending', 'queued'].includes(entry.key));
  const label = shown.map((entry) => `${entry.label} ${outcomes[entry.key].toLocaleString()}`).join(', ');
  const numbers: Array<{ label: string; value: number; note: string }> = [
    { label: 'Sent', value: stats.sent, note: of(stats.sent, stats.total, stats.total.toLocaleString()) },
    { label: 'Delivered', value: stats.delivered, note: of(stats.delivered, stats.sent, 'sent') },
    { label: 'Opened ≈', value: stats.opened, note: `${percent(rates.open)} of delivered` },
    { label: 'Clicked', value: stats.clicked, note: `${percent(rates.click)} of delivered` },
    {
      label: 'Unsubscribed',
      value: stats.unsubscribed,
      note: `${percent(rates.unsubscribe)} · ${stats.complained.toLocaleString()} complaint${stats.complained === 1 ? '' : 's'}`,
    },
  ];
  return (
    <div className="email-outcomes">
      <h3 className="card-label">What happened to the {stats.total.toLocaleString()}</h3>
      <div className="email-outcome-bar" role="img" aria-label={label}>
        {OUTCOMES.filter((entry) => outcomes[entry.key] > 0).map((entry) => (
          <span
            key={entry.key}
            className={`email-outcome-${entry.key}`}
            style={{ flexGrow: outcomes[entry.key] }}
            title={`${entry.label}: ${outcomes[entry.key].toLocaleString()}`}
          />
        ))}
      </div>
      <ul className="email-outcome-legend">
        {shown.map((entry) => (
          <li key={entry.key}>
            <span className={`email-dot email-outcome-${entry.key}`} aria-hidden="true" />
            {entry.label} <b>{outcomes[entry.key].toLocaleString()}</b>
          </li>
        ))}
      </ul>
      {stats.sent > 0 ? (
        <>
          <div className="email-numbers">
            {numbers.map((number) => (
              <div key={number.label}>
                <div className="stat-label">{number.label}</div>
                <div className="email-number">{number.value.toLocaleString()}</div>
                <div className="stat-note">{number.note}</div>
              </div>
            ))}
          </div>
          <p className="email-sub">
            Opens are approximate: some mail apps load images for privacy, and some block them. Delivery events come
            from the Resend webhook.
          </p>
        </>
      ) : null}
    </div>
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

type StatusKey = Exclude<SendFilter, 'all' | 'queued' | 'sending' | 'sent'>;

const STATUS_GROUPS: Array<{ label: string; items: Array<{ key: StatusKey; label: string; count: (c: EmailCampaign) => number }> }> = [
  {
    label: 'Engaged',
    items: [
      { key: 'clicked', label: 'Clicked', count: (c) => c.stats.clicked },
      { key: 'opened', label: 'Opened', count: (c) => c.stats.opened },
      { key: 'delivered', label: 'Delivered', count: (c) => c.stats.delivered },
    ],
  },
  {
    label: 'Problems',
    items: [
      { key: 'failed', label: 'Failed', count: (c) => c.stats.failed },
      { key: 'bounced', label: 'Bounced', count: (c) => c.stats.bounced },
      { key: 'unsubscribed', label: 'Unsubscribed', count: (c) => c.stats.unsubscribed },
      { key: 'complained', label: 'Spam complaint', count: (c) => c.stats.complained },
      { key: 'skipped', label: 'Skipped', count: (c) => c.stats.skipped },
    ],
  },
];

const STATUS_LABEL = Object.fromEntries(
  STATUS_GROUPS.flatMap((group) => group.items.map((item) => [item.key, item.label])),
) as Record<StatusKey, string>;

const DOT_FOR: Record<StatusKey, Outcome | 'muted'> = {
  clicked: 'delivered',
  opened: 'delivered',
  delivered: 'delivered',
  failed: 'failed',
  bounced: 'bounced',
  unsubscribed: 'muted',
  complained: 'muted',
  skipped: 'skipped',
};

function rowOutcome(row: SentEmailRow): Outcome | 'muted' {
  if (row.status === 'failed') return 'failed';
  if (row.status === 'skipped') return 'skipped';
  if (row.status !== 'sent') return 'queued';
  if (row.bouncedAt) return 'bounced';
  if (row.complainedAt || row.unsubscribedAt) return 'muted';
  return row.deliveredAt ? 'delivered' : 'pending';
}

function StatusMenu({
  campaign,
  chosen,
  onChange,
}: {
  campaign: EmailCampaign;
  chosen: StatusKey[];
  onChange: (next: StatusKey[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const toggle = (key: StatusKey) =>
    onChange(chosen.includes(key) ? chosen.filter((entry) => entry !== key) : [...chosen, key]);

  return (
    <div className="email-status" ref={box}>
      <button type="button" aria-expanded={open} aria-controls="email-status-menu" onClick={() => setOpen(!open)}>
        Status{chosen.length ? ` · ${chosen.length}` : ''} <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className="email-status-menu" id="email-status-menu">
          {STATUS_GROUPS.map((group) => (
            <fieldset key={group.label}>
              <legend>{group.label}</legend>
              {group.items.map((item) => {
                const count = item.count(campaign);
                return (
                  <label key={item.key} className={count === 0 && !chosen.includes(item.key) ? 'is-empty' : undefined}>
                    <input
                      type="checkbox"
                      checked={chosen.includes(item.key)}
                      disabled={count === 0 && !chosen.includes(item.key)}
                      onChange={() => toggle(item.key)}
                    />
                    <span className={`email-dot email-outcome-${DOT_FOR[item.key]}`} aria-hidden="true" />
                    <span>{item.label}</span>
                    <b>{count.toLocaleString()}</b>
                  </label>
                );
              })}
            </fieldset>
          ))}
        </div>
      ) : null}
    </div>
  );
}

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
  const [chosen, setChosen] = useState<StatusKey[]>([]);
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<SentEmailRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [viewing, setViewing] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchSends(campaign.id, { status: chosen.length ? chosen : 'all', q: q.trim() || undefined, limit: 100 })
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
  }, [campaign.id, chosen, q, campaign.counts.sent, campaign.counts.failed]);

  return (
    <div className="email-sent">
      <h3 className="card-label">Recipients</h3>
      <div className="email-report-tools">
        <input
          type="search"
          className="email-search"
          placeholder="Search name, email, store"
          aria-label="Search recipients"
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
        <StatusMenu campaign={campaign} chosen={chosen} onChange={setChosen} />
        {chosen.map((key) => (
          <span className="email-token" key={key}>
            <span className={`email-dot email-outcome-${DOT_FOR[key]}`} aria-hidden="true" />
            {STATUS_LABEL[key]}
            <button
              type="button"
              aria-label={`Remove ${STATUS_LABEL[key]}`}
              onClick={() => setChosen(chosen.filter((entry) => entry !== key))}
            >
              ×
            </button>
          </span>
        ))}
        {chosen.length ? (
          <button type="button" className="link-button" onClick={() => setChosen([])}>
            Clear
          </button>
        ) : null}
        {rows ? (
          <span className="email-report-count">
            {total.toLocaleString()} of {campaign.stats.total.toLocaleString()}
          </span>
        ) : null}
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
                    <RecipientCell row={row} />
                  </td>
                  <td>{row.shopName ?? '—'}</td>
                  <td>
                    <span className={`email-dot email-outcome-${rowOutcome(row)}`} aria-hidden="true" />
                    {rowResult(row)}
                  </td>
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
      <OutcomeSummary campaign={campaign} />
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
