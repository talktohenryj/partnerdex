import { useEffect, useRef, useState } from 'react';
import {
  fetchPreviewRecipients,
  type PreviewFilter,
  type PreviewRecipient,
  type PreviewRecipientList,
  type RenderedPreview,
} from '../api';

/**
 * The Preview card: "Preview as" one recipient of the audience, the arrows
 * that step through it (inside the active filter), a searchable picker, a
 * hidden-by-default list of that person's merge values, and the email.
 */

function nameOf(row: PreviewRecipient): string {
  return [row.firstName, row.lastName].filter((part) => part && part.trim()).join(' ').trim();
}

function subOf(row: PreviewRecipient): string {
  const name = nameOf(row);
  return [name ? row.email : 'No name', row.shopName].filter(Boolean).join(' · ');
}

function flagsOf(row: PreviewRecipient): string[] {
  return [...row.blank.map((field) => `${field} blank`), ...row.noLink.map((key) => `no ${key} link`)];
}

const FILTERS: Array<{ id: PreviewFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'blank', label: 'Blank in this email' },
  { id: 'nolink', label: 'No page link' },
];

function Picker({
  campaignId,
  current,
  filter,
  onPick,
  onFilter,
  onClose,
}: {
  campaignId: string;
  current: string;
  filter: PreviewFilter;
  onPick: (email: string) => void;
  onFilter: (filter: PreviewFilter) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [list, setList] = useState<PreviewRecipientList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    search.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      fetchPreviewRecipients(campaignId, { q: query, filter, limit: 50 })
        .then((result) => !cancelled && setList(result))
        .catch((cause: Error) => !cancelled && setError(cause.message));
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [campaignId, query, filter]);

  // Close on Escape and on a click outside the panel.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panel.current && !panel.current.contains(target) && !(target as Element).closest?.('.pa-pick')) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  return (
    <div className="pa-pop" role="dialog" aria-label="Choose a recipient" ref={panel}>
      <input
        ref={search}
        type="search"
        aria-label="Search recipients"
        placeholder="Search name, email, or store"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="pa-filters">
        {FILTERS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="pa-filter"
            aria-pressed={filter === entry.id}
            onClick={() => onFilter(entry.id)}
          >
            {entry.label}
            {list ? ` · ${list.counts[entry.id].toLocaleString()}` : ''}
          </button>
        ))}
      </div>
      {error ? <p className="channel-status bad">{error}</p> : null}
      <ul className="pa-list" role="listbox" aria-label="Recipients">
        {(list?.rows ?? []).map((row) => {
          const flags = flagsOf(row);
          const selected = row.email === current;
          return (
            <li key={row.email} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={selected}
                className="pa-opt"
                onClick={() => onPick(row.email)}
              >
                <span className="pa-opt-who">
                  <b>{nameOf(row) || row.email}</b>
                  <span>{subOf(row)}</span>
                </span>
                <span className="pa-tags">
                  {flags.length ? (
                    flags.map((flag) => (
                      <span key={flag} className="pa-flag">
                        {flag}
                      </span>
                    ))
                  ) : row.status ? (
                    <span className={`pill pill-${row.status}`}>{row.status}</span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {list && list.matching === 0 ? <p className="email-empty">No recipient matches.</p> : null}
      {list && list.matching > list.rows.length ? (
        <div className="pa-more">
          Showing {list.rows.length} of {list.matching.toLocaleString()}. Type to search.
        </div>
      ) : null}
    </div>
  );
}

function Variables({ preview }: { preview: RenderedPreview }) {
  return (
    <details className="pa-vars">
      <summary>
        <span className="pa-when-closed">Show variables</span>
        <span className="pa-when-open">Hide variables</span>
        {preview.blankCount > 0 ? <span className="pa-flag">{preview.blankCount} blank in this email</span> : null}
      </summary>
      <table className="pa-table">
        <tbody>
          {preview.variables.map((variable) => (
            <tr key={variable.key} className={variable.used ? 'used' : undefined}>
              <th scope="row">{variable.key}</th>
              <td>
                {variable.value ? (
                  variable.value
                ) : variable.used ? (
                  <span className="pa-warn">
                    Blank — shows{' '}
                    {variable.fallbacks.length ? variable.fallbacks.map((text) => `“${text}”`).join(' or ') : 'nothing'}
                  </span>
                ) : (
                  <span className="pa-blank">blank</span>
                )}
              </td>
            </tr>
          ))}
          {preview.pages.map((page) => (
            <tr key={`page:${page.key}`} className={page.used ? 'used' : undefined}>
              <th scope="row">page: {page.key}</th>
              <td>
                {page.url ? (
                  <code>{page.url}</code>
                ) : page.used ? (
                  <span className="pa-warn">No link for this store. The button shows as text.</span>
                ) : (
                  <span className="pa-blank">no link</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pa-legend">
        <b>•</b> used in this email
      </div>
    </details>
  );
}

export function EmailPreview({
  campaignId,
  preview,
  filter,
  onAs,
  onFilter,
}: {
  campaignId: string;
  preview: RenderedPreview;
  filter: PreviewFilter;
  onAs: (email: string) => void;
  onFilter: (filter: PreviewFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const { recipient, position } = preview;
  const name = nameOf(recipient);
  const close = useRef(() => setOpen(false)).current;

  const posLabel =
    position.index !== null
      ? `${position.index.toLocaleString()} of ${position.total.toLocaleString()}`
      : position.total
        ? `Not in filter · ${position.total.toLocaleString()}`
        : '';

  return (
    <>
      <div className="pa-head">
        <h2 className="card-label">Preview as</h2>
        <div className="pa-nav">
          <button
            type="button"
            className="pa-step"
            aria-label="Previous recipient"
            disabled={!position.prevEmail}
            onClick={() => position.prevEmail && onAs(position.prevEmail)}
          >
            ‹
          </button>
          <button
            type="button"
            className="pa-pick"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <span className="pa-who">
              <b>{name || recipient.email}</b>
              <span>{subOf(recipient)}</span>
            </span>
            <span className="pa-caret" aria-hidden="true">
              ▾
            </span>
          </button>
          <button
            type="button"
            className="pa-step"
            aria-label="Next recipient"
            disabled={!position.nextEmail}
            onClick={() => position.nextEmail && onAs(position.nextEmail)}
          >
            ›
          </button>
        </div>
        <span className="pa-pos">{posLabel}</span>
        {open ? (
          <Picker
            campaignId={campaignId}
            current={recipient.email}
            filter={filter}
            onFilter={onFilter}
            onClose={close}
            onPick={(email) => {
              onAs(email);
              setOpen(false);
            }}
          />
        ) : null}
      </div>
      {filter !== 'all' ? (
        <p className="email-sub">
          {filter === 'blank'
            ? 'The arrows step only through people with a blank value in this email.'
            : 'The arrows step only through people with no link for a page button.'}{' '}
          <button type="button" className="link-button" onClick={() => onFilter('all')}>
            Show all
          </button>
        </p>
      ) : null}

      <Variables preview={preview} />

      <dl className="email-headers">
        <dt>To</dt>
        <dd>{preview.to}</dd>
        <dt>From</dt>
        <dd>{preview.from || 'Fill in the sender on the Settings tab'}</dd>
        {preview.replyTo ? (
          <>
            <dt>Reply-To</dt>
            <dd>{preview.replyTo}</dd>
          </>
        ) : null}
        <dt>Subject</dt>
        <dd>{preview.subject}</dd>
      </dl>
      <iframe className="email-frame" title="Email preview" sandbox="" srcDoc={preview.html} />
    </>
  );
}
