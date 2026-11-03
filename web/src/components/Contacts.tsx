import { useEffect, useMemo, useState } from 'react';
import {
  audienceExportUrl,
  createAudience,
  deleteAudience,
  fetchAudiences,
  fetchContactCandidates,
  fetchContacts,
  matchContactToShop,
  previewAudience,
  setContactSuppressed,
  updateAudience,
  type AppSummary,
  type AudienceDefinition,
  type AudienceExcludedPerson,
  type AudiencePreview,
  type AudienceRecipient,
  type ContactLinkedFilter,
  type ContactMatchMethod,
  type ContactRole,
  type ContactShopCandidate,
  type ContactSummary,
  type CustomerStatus,
  type SavedAudienceSummary,
} from '../api';
import { formatFullDate } from '../format';
import { ContactLists } from './ContactLists';
import { RuleButton, type RuleOption } from './RuleButton';

/**
 * The people behind the stores, and the saved lists over them.
 *
 * One table, many lists. "All contacts" is every person in scope with the
 * hygiene filter (Show). Setting a Store status or Role rule there filters the
 * table in place; "Save audience" keeps those rules as a new tab. An audience
 * is resolved live on the server, with suppressed, unconfirmed, and
 * status-less people moved to "Left out" and each person counted once.
 *
 * Search runs on the server: the list is the send-list, and finding one person
 * among hundreds by the email on a support ticket should not mean shipping
 * the whole table to the browser first.
 */

const PAGE_SIZE = 50;
const EXPORT_PAGE = 200;

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  staff: 'Staff',
  collaborator: 'Collaborator',
};

const SOURCE_LABEL: Record<string, string> = {
  app_capture: 'App login',
  csv_import: 'CSV import',
};

const STATUSES: CustomerStatus[] = ['paying', 'trialing', 'installed', 'churned', 'gone'];
const ROLES: ContactRole[] = ['owner', 'staff', 'collaborator'];

const STATUS_LABEL: Record<CustomerStatus, string> = {
  paying: 'Paying',
  trialing: 'Trialing',
  installed: 'Installed',
  churned: 'Churned',
  gone: 'Gone',
};

const STATUS_HINT: Record<CustomerStatus, string> = {
  paying: 'A live paid subscription',
  trialing: 'Inside a free trial',
  installed: 'Installed, not paying, not in a trial now (free plan)',
  churned: 'Paid before, no install or subscription now',
  gone: 'Installed before, never paid, not installed now',
};

const LINKED_FILTERS: Array<{ value: ContactLinkedFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'unlinked', label: 'Unlinked' },
  { value: 'ambiguous', label: 'Ambiguous' },
  { value: 'suppressed', label: 'Suppressed' },
];

type SortKey = 'name' | 'customer' | 'created' | 'recent';

/** First click uses this direction. A second click on the same title flips it. */
const NATURAL_SORT: Record<SortKey, string> = {
  name: 'name',
  customer: 'customer',
  created: 'created',
  recent: 'recent',
};

const FLIPPED_SORT: Record<SortKey, string> = {
  name: 'name_desc',
  customer: 'customer_desc',
  created: 'created_asc',
  recent: 'recent_asc',
};

function sortKeyOf(sort: string): SortKey | null {
  if (sort === 'name' || sort === 'name_desc') return 'name';
  if (sort === 'customer' || sort === 'customer_desc') return 'customer';
  if (sort === 'created' || sort === 'created_asc') return 'created';
  if (sort === 'recent' || sort === 'recent_asc') return 'recent';
  return null;
}

function sortDir(sort: string): 'asc' | 'desc' {
  return sort.endsWith('_desc') || sort === 'created' || sort === 'recent' ? 'desc' : 'asc';
}

function nextSort(current: string, key: SortKey): string {
  if (current === NATURAL_SORT[key]) return FLIPPED_SORT[key];
  if (current === FLIPPED_SORT[key]) return NATURAL_SORT[key];
  return NATURAL_SORT[key];
}

/**
 * One row of the table, whichever list it came from. All contacts and an
 * audience render through the same component, so the columns cannot drift.
 */
interface TableRow {
  email: string;
  firstName: string | null;
  lastName: string | null;
  isSuppressed: boolean;
  source: string;
  createdAt: string | null;
  lastSeenAt: string | null;
  primary: {
    shopId: string;
    name: string | null;
    domain: string | null;
    role: ContactRole;
    matchMethod: ContactMatchMethod;
  } | null;
  /** The "+N": other stores this person is linked to. */
  extra: number;
  status: CustomerStatus | null;
  /** The app a Resolve should link under. Empty means "let the server pick". */
  appId: string;
}

function fromContact(row: ContactSummary, appId: string): TableRow {
  const primary = row.primaryShop;
  return {
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    isSuppressed: row.isSuppressed,
    source: row.source,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    primary: primary
      ? {
          shopId: primary.shopId,
          name: primary.name,
          domain: primary.domain,
          role: primary.role,
          matchMethod: primary.matchMethod,
        }
      : null,
    extra: Math.max(row.shops.length - 1, 0),
    status: primary?.status ?? null,
    appId: primary?.appId ?? appId,
  };
}

function fromRecipient(row: AudienceRecipient | AudienceExcludedPerson, appId: string): TableRow {
  return {
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    isSuppressed: row.isSuppressed,
    source: row.source,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    primary: {
      shopId: row.shopId,
      name: row.shopName,
      domain: row.shopDomain,
      role: row.role,
      matchMethod: row.matchMethod,
    },
    extra: row.otherShops,
    status: row.status,
    appId,
  };
}

function personName(row: { firstName: string | null; lastName: string | null }): string {
  return [row.firstName, row.lastName].filter(Boolean).join(' ').trim();
}

function displayName(row: TableRow): string {
  return personName(row) || row.email;
}

function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source.replace(/_/g, ' ');
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** Canonical order, so two definitions that ask the same thing compare equal. */
function canonical(def: AudienceDefinition): AudienceDefinition {
  return {
    appId: def.appId,
    statuses: STATUSES.filter((value) => def.statuses.includes(value)),
    roles: ROLES.filter((value) => def.roles.includes(value)),
  };
}

function sameDefinition(a: AudienceDefinition | null, b: AudienceDefinition | null): boolean {
  return JSON.stringify(a && canonical(a)) === JSON.stringify(b && canonical(b));
}

function ruleValue(selected: string[], all: string[], label: (value: string) => string): string {
  if (selected.length === 0) return 'Any';
  if (selected.length === all.length) return 'All';
  const labels = selected.map(label);
  if (labels.length <= 2) return labels.join(', ');
  return `${labels.slice(0, 2).join(', ')} +${labels.length - 2}`;
}

/* ---------------------------------------------------------------- csv out */

function csvCell(value: string | null | undefined): string {
  let text = value ?? '';
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

function downloadCsv(filename: string, lines: string[][]): void {
  const body = `${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`;
  const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ------------------------------------------------------------ components */

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: string;
  onSort: (sort: string) => void;
  className?: string;
}) {
  const active = sortKeyOf(sort) === sortKey;
  const dir = sortDir(sort);
  return (
    <th className={className} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        className={active ? 'th-sort is-active' : 'th-sort'}
        onClick={() => onSort(nextSort(sort, sortKey))}
      >
        {label}
        {active ? (
          <span className="th-sort-mark" aria-hidden="true">
            {dir === 'asc' ? '↑' : '↓'}
          </span>
        ) : null}
      </button>
    </th>
  );
}

/** Waits for the typing to stop before asking the server. */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/**
 * Choosing which merchant a contact belongs to.
 *
 * Candidates come from the shops table by name or domain. The partner
 * recognises the store; the importer would not guess.
 */
function MatchPicker({
  contact,
  appId,
  onMatched,
}: {
  contact: TableRow;
  appId: string;
  onMatched: () => void;
}) {
  const [search, setSearch] = useState('');
  const [candidates, setCandidates] = useState<ContactShopCandidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounced = useDebounced(search, 250);

  useEffect(() => {
    let cancelled = false;
    fetchContactCandidates(debounced)
      .then((result) => {
        if (!cancelled) setCandidates(result.candidates);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  const link = (shopId: string) => {
    setBusy(true);
    setError(null);
    matchContactToShop(contact.email, shopId, appId)
      .then(onMatched)
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="review-picker">
      <label htmlFor={`contact-picker-${contact.email}`}>
        Which store does <strong>{displayName(contact)}</strong> belong to?
      </label>
      <input
        id={`contact-picker-${contact.email}`}
        type="search"
        placeholder="Store name, myshopify domain, or shop id"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        autoComplete="off"
      />
      {error ? <p className="review-picker-error">{error}</p> : null}
      <ul className="review-candidates">
        {candidates.map((candidate) => (
          <li key={candidate.shopId}>
            <button type="button" disabled={busy} onClick={() => link(candidate.shopId)}>
              <span className="candidate-name">
                {candidate.name ?? candidate.domain ?? candidate.shopId}
              </span>
              <span className="candidate-meta">{candidate.domain ?? `Shop ${candidate.shopId}`}</span>
            </button>
          </li>
        ))}
        {candidates.length === 0 ? <li className="candidate-empty">No merchants match.</li> : null}
      </ul>
    </div>
  );
}

function CustomersCell({
  row,
  resolving,
  onToggleResolve,
  onMatched,
}: {
  row: TableRow;
  resolving: boolean;
  onToggleResolve: () => void;
  onMatched: () => void;
}) {
  const primary = row.primary;
  const needsMatch = !primary || primary.matchMethod === 'ambiguous' || primary.matchMethod === 'none';

  return (
    <td className="col-customer">
      {primary ? (
        <div className="contact-customer">
          <a
            className="customer-link contact-customer-link"
            href={`#/customers/${encodeURIComponent(primary.shopId)}`}
          >
            <span className="customer-name">{primary.name || primary.domain || primary.shopId}</span>
          </a>
          <span className="contact-role">
            {ROLE_LABEL[primary.role] ?? primary.role}
            {row.extra > 0 ? ` · +${row.extra}` : ''}
          </span>
          {primary.matchMethod === 'ambiguous' ? (
            <span className="pill pill-ambiguous" title="More than one shop answered to this domain.">
              Ambiguous
            </span>
          ) : null}
        </div>
      ) : (
        <span className="pill pill-ambiguous">Unlinked</span>
      )}
      {needsMatch ? (
        <button type="button" className="link-button" onClick={onToggleResolve}>
          {resolving ? 'Cancel' : 'Resolve'}
        </button>
      ) : null}
      {resolving ? <MatchPicker contact={row} appId={row.appId} onMatched={onMatched} /> : null}
    </td>
  );
}

function ContactsTable({
  rows,
  sort,
  onSort,
  onChanged,
  onError,
  leftOut = false,
}: {
  rows: TableRow[];
  sort: string;
  onSort: (sort: string) => void;
  onChanged: () => void;
  onError: (message: string) => void;
  leftOut?: boolean;
}) {
  const [resolving, setResolving] = useState<string | null>(null);
  const [busyEmail, setBusyEmail] = useState<string | null>(null);

  const toggleSuppressed = (row: TableRow) => {
    setBusyEmail(row.email);
    setContactSuppressed(row.email, !row.isSuppressed)
      .then(onChanged)
      .catch((cause: Error) => onError(cause.message))
      .finally(() => setBusyEmail(null));
  };

  return (
    <div className="table-wrap">
      <table className={`customer-table contacts-table cv-table${leftOut ? ' cv-table-out' : ''}`}>
        <thead>
          <tr>
            <SortHeader label="Name" sortKey="name" sort={sort} onSort={onSort} />
            <th>Source</th>
            <SortHeader label="Created" sortKey="created" sort={sort} onSort={onSort} />
            <SortHeader label="Last seen" sortKey="recent" sort={sort} onSort={onSort} />
            <SortHeader
              label="Customers"
              sortKey="customer"
              sort={sort}
              onSort={onSort}
              className="col-customer"
            />
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.email}
              className={leftOut || row.isSuppressed ? 'contact-row-suppressed' : undefined}
            >
              <td>
                <div className="contact-person">
                  <span>
                    <span className="customer-name">{displayName(row)}</span>
                    {row.isSuppressed ? <span className="pill pill-suppressed">Suppressed</span> : null}
                  </span>
                  {personName(row) ? <span className="contact-email">{row.email}</span> : null}
                </div>
              </td>
              <td>
                {row.source ? (
                  <span className={`pill pill-source-${row.source}`}>{sourceLabel(row.source)}</span>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td>{row.createdAt ? formatFullDate(row.createdAt) : '—'}</td>
              <td>{row.lastSeenAt ? formatFullDate(row.lastSeenAt) : '—'}</td>
              <CustomersCell
                row={row}
                resolving={resolving === row.email}
                onToggleResolve={() =>
                  setResolving((current) => (current === row.email ? null : row.email))
                }
                onMatched={() => {
                  setResolving(null);
                  onChanged();
                }}
              />
              <td>
                {row.status ? (
                  <span className={`pill pill-${row.status}`} title={STATUS_HINT[row.status]}>
                    {STATUS_LABEL[row.status]}
                  </span>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td>
                <button
                  type="button"
                  className="link-button"
                  disabled={busyEmail === row.email}
                  onClick={() => toggleSuppressed(row)}
                >
                  {row.isSuppressed ? 'Unsuppress' : 'Suppress'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Pager({
  page,
  total,
  onPage,
}: {
  page: number;
  total: number;
  onPage: (page: number) => void;
}) {
  if (total <= PAGE_SIZE) return null;
  const lastPage = Math.max(Math.ceil(total / PAGE_SIZE) - 1, 0);
  return (
    <div className="pager">
      <button type="button" onClick={() => onPage(page - 1)} disabled={page === 0}>
        Previous
      </button>
      <span>
        {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total.toLocaleString()}
      </span>
      <button type="button" onClick={() => onPage(page + 1)} disabled={page >= lastPage}>
        Next
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

type Mode = 'all' | 'saved' | 'loading';

export function Contacts({
  appId: initialAppId,
  listId,
  apps,
}: {
  appId: string;
  /** '' = All contacts, otherwise a saved audience id. */
  listId: string;
  apps: AppSummary[];
}) {
  // Shared by every list: search carries over when a list opens.
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('recent');
  const [page, setPage] = useState(0);
  const [reloadTick, setReloadTick] = useState(0);
  const reload = () => setReloadTick((n) => n + 1);

  // All contacts.
  const [linked, setLinked] = useState<ContactLinkedFilter>('all');
  const [allAppId, setAllAppId] = useState(initialAppId);
  const [rows, setRows] = useState<ContactSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [totals, setTotals] = useState({ all: 0, unlinked: 0, ambiguous: 0, suppressed: 0 });
  const [allCount, setAllCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // Audiences.
  const [audiences, setAudiences] = useState<SavedAudienceSummary[] | null>(null);
  // Store status / Role rules on All contacts. Empty means "Any".
  const [rules, setRules] = useState<{ statuses: CustomerStatus[]; roles: ContactRole[] }>({
    statuses: [],
    roles: [],
  });
  const [working, setWorking] = useState<AudienceDefinition | null>(null);
  const [workingFor, setWorkingFor] = useState<string | null>(null);
  const [preview, setPreview] = useState<AudiencePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [outOpen, setOutOpen] = useState(true);
  const [naming, setNaming] = useState<'save' | 'rename' | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const debounced = useDebounced(search, 250);
  const defaultAppId = allAppId || apps[0]?.id || '';
  const appName = (id: string) => apps.find((app) => app.id === id)?.name ?? `App ${id}`;

  const loadAudiences = () =>
    fetchAudiences()
      .then((result) => {
        setAudiences(result.audiences);
        return result.audiences;
      })
      .catch((cause: Error) => {
        setActionError(cause.message);
        return null;
      });

  useEffect(() => {
    void loadAudiences();
  }, [reloadTick]);

  // The All contacts tab count is the whole store, whichever list is open.
  useEffect(() => {
    let cancelled = false;
    fetchContacts({ limit: 1 })
      .then((result) => {
        if (!cancelled) setAllCount(result.totals.all);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const saved = listId ? audiences?.find((audience) => audience.id === listId) : undefined;
  let mode: Mode = 'all';
  if (listId) mode = audiences === null ? 'loading' : saved ? 'saved' : 'all';

  // An unknown id falls back to All contacts.
  useEffect(() => {
    if (listId && audiences !== null && !saved) {
      window.location.replace('#/contacts');
    }
  }, [listId, audiences, saved]);

  // A saved audience is edited on a working copy until "Save changes".
  if (mode === 'saved' && saved && workingFor !== saved.id) {
    setWorkingFor(saved.id);
    setWorking(saved.definition);
  }
  if (mode !== 'saved' && workingFor !== null) {
    setWorkingFor(null);
    setWorking(null);
  }

  // All contacts with a Store status or Role rule set is resolved like an
  // audience, so what the table shows is exactly what "Save audience" keeps.
  // An unset rule means every value.
  const hasRules = rules.statuses.length > 0 || rules.roles.length > 0;
  const allDefinition: AudienceDefinition | null =
    hasRules && defaultAppId
      ? canonical({
          appId: defaultAppId,
          statuses: rules.statuses.length > 0 ? rules.statuses : [...STATUSES],
          roles: rules.roles.length > 0 ? rules.roles : [...ROLES],
        })
      : null;

  const definition = mode === 'saved' ? working : mode === 'all' ? allDefinition : null;
  const filtered = definition !== null;
  const dirty = mode === 'saved' && saved ? !sameDefinition(working, saved.definition) : false;

  // The Show filter and the audience rules do not mix.
  useEffect(() => {
    if (hasRules) setLinked('all');
  }, [hasRules]);

  // Leaving a list closes its inline forms.
  useEffect(() => {
    setNaming(null);
    setMoreOpen(false);
    setConfirmDelete(false);
    setActionError(null);
    setPage(0);
  }, [listId]);

  useEffect(() => {
    setPage(0);
  }, [debounced, linked, sort, allAppId, JSON.stringify(definition)]);

  /* ---- All contacts */

  useEffect(() => {
    if (mode !== 'all' || filtered) return;
    let cancelled = false;
    setLoading(true);
    fetchContacts({
      search: debounced,
      linked,
      sort,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      appId: allAppId,
    })
      .then((result) => {
        if (cancelled) return;
        setRows(result.contacts);
        setTotal(result.total);
        setTotals(result.totals);
        setError(null);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, filtered, debounced, linked, sort, page, allAppId, reloadTick]);

  /* ---- Audience preview, 300 ms after the last rule or search change */

  const previewKey = useMemo(
    () =>
      definition
        ? JSON.stringify({ definition: canonical(definition), q: search, sort, page, reloadTick })
        : '',
    [definition, search, sort, page, reloadTick],
  );
  const settledKey = useDebounced(previewKey, 300);

  useEffect(() => {
    if (!settledKey) {
      setPreview(null);
      return;
    }
    const parsed = JSON.parse(settledKey) as {
      definition: AudienceDefinition;
      q: string;
      sort: string;
      page: number;
    };
    let cancelled = false;
    setPreviewLoading(true);
    previewAudience({
      definition: parsed.definition,
      q: parsed.q,
      sort: parsed.sort,
      limit: PAGE_SIZE,
      offset: parsed.page * PAGE_SIZE,
    })
      .then((result) => {
        if (cancelled) return;
        setPreview(result);
        setPreviewError(null);
      })
      .catch((cause: Error) => {
        if (!cancelled) setPreviewError(cause.message);
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [settledKey]);

  /* ---- Actions */

  const setStatuses = (next: CustomerStatus[]) => {
    if (mode === 'saved') {
      if (working && next.length > 0) setWorking(canonical({ ...working, statuses: next }));
    } else {
      setRules((current) => ({ ...current, statuses: next }));
    }
  };

  const setRoles = (next: ContactRole[]) => {
    if (mode === 'saved') {
      if (working && next.length > 0) setWorking(canonical({ ...working, roles: next }));
    } else {
      setRules((current) => ({ ...current, roles: next }));
    }
  };

  const setApp = (appId: string) => {
    if (mode === 'saved') {
      if (working && appId) setWorking({ ...working, appId });
    } else {
      setAllAppId(appId);
    }
  };

  const clearRules = () => {
    setRules({ statuses: [], roles: [] });
    if (mode === 'saved') window.location.hash = '#/contacts';
  };

  const showAll = (filter: ContactLinkedFilter) => {
    if (definition) setAllAppId(definition.appId);
    setRules({ statuses: [], roles: [] });
    setLinked(filter);
    window.location.hash = '#/contacts';
  };

  const run = (work: () => Promise<void>) => {
    setActionBusy(true);
    setActionError(null);
    work()
      .catch((cause: Error) => setActionError(cause.message))
      .finally(() => setActionBusy(false));
  };

  const saveNew = () =>
    run(async () => {
      if (!allDefinition) return;
      const created = await createAudience(nameInput.trim(), allDefinition);
      await loadAudiences();
      setNaming(null);
      setRules({ statuses: [], roles: [] });
      window.location.hash = `#/contacts/${encodeURIComponent(created.id)}`;
    });

  const saveChanges = () =>
    run(async () => {
      if (!saved || !working) return;
      await updateAudience(saved.id, { definition: working });
      await loadAudiences();
      setWorkingFor(null);
    });

  const rename = () =>
    run(async () => {
      if (!saved) return;
      await updateAudience(saved.id, { name: nameInput.trim() });
      await loadAudiences();
      setNaming(null);
    });

  const remove = () =>
    run(async () => {
      if (!saved) return;
      await deleteAudience(saved.id);
      await loadAudiences();
      setConfirmDelete(false);
      window.location.hash = '#/contacts';
    });

  const exportAll = () => {
    setExporting(true);
    setError(null);
    (async () => {
      const lines: string[][] = [
        ['email', 'first_name', 'last_name', 'role', 'store', 'store_domain', 'status', 'source', 'suppressed'],
      ];
      for (let offset = 0; ; offset += EXPORT_PAGE) {
        const result = await fetchContacts({
          search: debounced,
          linked,
          sort,
          limit: EXPORT_PAGE,
          offset,
          appId: allAppId,
        });
        for (const row of result.contacts) {
          const shop = row.primaryShop;
          lines.push([
            row.email,
            row.firstName ?? '',
            row.lastName ?? '',
            shop?.role ?? '',
            shop?.name ?? '',
            shop?.domain ?? '',
            shop?.status ?? '',
            row.source,
            row.isSuppressed ? 'yes' : 'no',
          ]);
        }
        if (offset + EXPORT_PAGE >= result.total || result.contacts.length === 0) break;
      }
      downloadCsv(`contacts-${today()}.csv`, lines);
    })()
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setExporting(false));
  };

  /* ---- Rule bar */

  const appOptions: RuleOption[] = apps.map((app) => ({ value: app.id, label: app.name }));
  const showAppRule = apps.length > 1;

  const statusOptions = (counts?: Record<CustomerStatus, number>): RuleOption[] =>
    STATUSES.map((status) => ({
      value: status,
      label: STATUS_LABEL[status],
      pill: `pill-${status}`,
      count: counts ? counts[status] : null,
      hint: STATUS_HINT[status],
    }));

  const roleOptions = (counts?: Record<ContactRole, number>): RuleOption[] =>
    ROLES.map((role) => ({
      value: role,
      label: ROLE_LABEL[role]!,
      count: counts ? counts[role] : null,
    }));

  const searchBox = (
    <div className="control cv-search">
      <input
        type="search"
        placeholder="Find a person by name or email"
        aria-label="Find a person"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        autoComplete="off"
      />
    </div>
  );

  const statusSelected = mode === 'saved' ? working?.statuses ?? [] : rules.statuses;
  const roleSelected = mode === 'saved' ? working?.roles ?? [] : rules.roles;
  const barAppId = definition ? definition.appId : allAppId;

  const ruleBar = (
    <div className="cv-bar">
      {searchBox}
      <div className="cv-filters">
        {mode === 'all' && !filtered ? (
          <RuleButton
            label="Show"
            value={LINKED_FILTERS.find((item) => item.value === linked)?.label ?? 'All'}
            isSet={linked !== 'all'}
            heading="Show"
            multiple={false}
            options={LINKED_FILTERS.map((item) => ({
              value: item.value,
              label: item.label,
              count: item.value === 'all' ? totals.all : totals[item.value],
            }))}
            selected={[linked]}
            onChange={(next) => setLinked((next[0] ?? 'all') as ContactLinkedFilter)}
          />
        ) : null}
        <RuleButton
          label="Store status"
          value={ruleValue(statusSelected, STATUSES, (s) => STATUS_LABEL[s as CustomerStatus])}
          isSet={statusSelected.length > 0}
          heading={`Store status in ${appName(definition?.appId ?? defaultAppId)}`}
          options={statusOptions(filtered ? preview?.optionCounts.statuses : undefined)}
          selected={statusSelected}
          onChange={(next) => setStatuses(next as CustomerStatus[])}
        />
        <RuleButton
          label="Role"
          value={ruleValue(roleSelected, ROLES, (r) => ROLE_LABEL[r] ?? r)}
          isSet={roleSelected.length > 0}
          heading="Role at the store"
          options={roleOptions(filtered ? preview?.optionCounts.roles : undefined)}
          selected={roleSelected}
          onChange={(next) => setRoles(next as ContactRole[])}
        />
        {showAppRule ? (
          <RuleButton
            label="App"
            value={barAppId ? appName(barAppId) : 'All apps'}
            isSet={mode === 'all' && allAppId !== ''}
            heading="App"
            multiple={false}
            options={
              filtered ? appOptions : [{ value: '', label: 'All apps in scope' }, ...appOptions]
            }
            selected={[barAppId]}
            onChange={(next) => setApp(next[0] ?? '')}
          />
        ) : null}
        {filtered ? (
          <button type="button" className="link-button cv-clear" onClick={clearRules}>
            Clear rules
          </button>
        ) : null}
      </div>
      <div className="aud-actions">
        {filtered && definition ? (
          <a
            className="aud-secondary"
            href={audienceExportUrl(
              saved && !dirty ? { id: saved.id } : { definition: canonical(definition) },
            )}
            download
          >
            Export CSV
          </a>
        ) : (
          <button type="button" className="aud-secondary" disabled={exporting} onClick={exportAll}>
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        )}
        {mode === 'all' ? (
          naming === 'save' && filtered ? (
            <form
              className="aud-name-form"
              onSubmit={(event) => {
                event.preventDefault();
                saveNew();
              }}
            >
              <input
                type="text"
                aria-label="Audience name"
                placeholder="Audience name"
                maxLength={80}
                autoFocus
                value={nameInput}
                onChange={(event) => setNameInput(event.target.value)}
              />
              <button type="submit" className="primary" disabled={actionBusy || !nameInput.trim()}>
                Save
              </button>
              <button type="button" className="aud-secondary" onClick={() => setNaming(null)}>
                Cancel
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={!filtered}
              title={filtered ? undefined : 'Pick a store status or a role first'}
              onClick={() => {
                setNameInput('');
                setNaming('save');
              }}
            >
              Save audience…
            </button>
          )
        ) : null}
        {mode === 'saved' && saved ? (
          <>
            <button
              type="button"
              className="primary"
              disabled={!dirty || actionBusy}
              onClick={saveChanges}
            >
              Save changes
            </button>
            <span className="cv-filter-wrap">
              <button
                type="button"
                className="aud-secondary aud-more"
                aria-label="More actions"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((current) => !current)}
              >
                ⋯
              </button>
              {moreOpen ? (
                <div className="cv-menu cv-menu-right" role="menu">
                  <ul>
                    <li>
                      <button
                        type="button"
                        role="menuitem"
                        className="cv-menu-row cv-menu-plain"
                        onClick={() => {
                          setNameInput(saved.name);
                          setNaming('rename');
                          setMoreOpen(false);
                        }}
                      >
                        Rename
                      </button>
                    </li>
                    <li>
                      <button
                        type="button"
                        role="menuitem"
                        className="cv-menu-row cv-menu-plain cv-menu-danger"
                        onClick={() => {
                          setConfirmDelete(true);
                          setMoreOpen(false);
                        }}
                      >
                        Delete
                      </button>
                    </li>
                  </ul>
                </div>
              ) : null}
            </span>
          </>
        ) : null}
      </div>
    </div>
  );

  const savedPanel =
    mode === 'saved' && saved && (naming === 'rename' || confirmDelete) ? (
      <div className="notice aud-inline">
        {naming === 'rename' ? (
          <form
            className="aud-name-form"
            onSubmit={(event) => {
              event.preventDefault();
              rename();
            }}
          >
            <label htmlFor="audience-rename">Rename audience</label>
            <input
              id="audience-rename"
              type="text"
              maxLength={80}
              autoFocus
              value={nameInput}
              onChange={(event) => setNameInput(event.target.value)}
            />
            <button type="submit" className="primary" disabled={actionBusy || !nameInput.trim()}>
              Rename
            </button>
            <button type="button" className="aud-secondary" onClick={() => setNaming(null)}>
              Cancel
            </button>
          </form>
        ) : (
          <div className="aud-name-form">
            <span>
              Delete <strong>{saved.name}</strong>? This removes the saved rule. No contact is
              changed.
            </span>
            <button type="button" className="primary danger" disabled={actionBusy} onClick={remove}>
              Delete
            </button>
            <button type="button" className="aud-secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
          </div>
        )}
      </div>
    ) : null;

  /* ---- Render */

  const tabs = (
    <ContactLists
      listId={mode === 'all' ? '' : listId}
      allCount={allCount}
      audiences={audiences ?? []}
    />
  );

  if (mode === 'loading') {
    return (
      <>
        {tabs}
        <div className="skeleton">Loading audience…</div>
      </>
    );
  }

  if (mode === 'saved' || filtered) {
    const excludedTotal = preview
      ? preview.excluded.suppressed + preview.excluded.ambiguous + preview.excluded.noStatus
      : 0;
    const headline = preview ? (search.trim() ? preview.matching : preview.count) : null;
    const tableRows = (preview?.rows ?? []).map((row) => fromRecipient(row, preview!.definition.appId));
    const outRows = (preview?.excludedSample ?? []).map((row) =>
      fromRecipient(row, preview!.definition.appId),
    );

    return (
      <>
        {tabs}
        {saved?.stale ? (
          <div className="notice error">
            <h2>App out of scope</h2>
            <p>
              This audience names app {saved.definition.appId}, which is no longer in the reporting
              scope. Pick an app in scope and save the changes, or delete the audience.
            </p>
          </div>
        ) : null}
        {ruleBar}
        {savedPanel}
        {actionError ? (
          <div className="notice error">
            <p>{actionError}</p>
          </div>
        ) : null}
        {previewError ? (
          <div className="notice error">
            <h2>Could not resolve the audience</h2>
            <p>{previewError}</p>
          </div>
        ) : null}

        {definition ? (
          <section className="card full cv-list">
            <div className="cv-summary">
              {preview ? (
                <>
                  <span>
                    <b className="tabular">{headline!.toLocaleString()}</b>{' '}
                    {headline === 1 ? 'contact' : 'contacts'}
                    {search.trim() ? ` matching “${search.trim()}” of ${preview.count.toLocaleString()}` : ''}{' '}
                    at {plural(preview.stores, 'store')}
                  </span>
                  {excludedTotal > 0 ? (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => {
                        setOutOpen(true);
                        window.setTimeout(
                          () => document.getElementById('cv-out')?.scrollIntoView({ behavior: 'smooth' }),
                          0,
                        );
                      }}
                    >
                      {excludedTotal.toLocaleString()} left out
                    </button>
                  ) : null}
                  {preview.multiStorePeople > 0 ? (
                    <span className="cv-sub">
                      {plural(preview.multiStorePeople, 'person', 'people')} on several stores{' '}
                      {preview.multiStorePeople === 1 ? 'is' : 'are'} counted once
                    </span>
                  ) : null}
                  {previewLoading ? <span className="cv-sub">Updating…</span> : null}
                </>
              ) : (
                <span className="cv-sub">{previewLoading ? 'Resolving…' : ''}</span>
              )}
            </div>

            {preview && tableRows.length === 0 ? (
              <p className="contact-footnote">
                {search.trim()
                  ? 'Nobody in this audience matches that search.'
                  : 'Nobody matches these rules right now.'}
              </p>
            ) : null}

            {tableRows.length > 0 ? (
              <ContactsTable
                rows={tableRows}
                sort={sort}
                onSort={setSort}
                onChanged={reload}
                onError={setActionError}
              />
            ) : null}

            {preview ? <Pager page={page} total={preview.matching} onPage={setPage} /> : null}

            {preview && excludedTotal > 0 ? (
              <div className="aud-out" id="cv-out">
                <div className="aud-out-head">
                  <button
                    type="button"
                    className="aud-out-toggle"
                    aria-expanded={outOpen}
                    onClick={() => setOutOpen((current) => !current)}
                  >
                    <svg
                      className={outOpen ? 'aud-caret' : 'aud-caret is-closed'}
                      viewBox="0 0 22 22"
                      aria-hidden="true"
                    >
                      <path d="M6 8l5 5 5-5" fill="none" strokeWidth="1.8" />
                    </svg>
                    <span>
                      <b>{excludedTotal.toLocaleString()} left out</b> — match the rules, but are not
                      in the audience
                    </span>
                  </button>
                  <span className="aud-out-why">
                    {preview.excluded.suppressed > 0 ? (
                      <button type="button" className="link-button" onClick={() => showAll('suppressed')}>
                        {preview.excluded.suppressed.toLocaleString()} suppressed
                      </button>
                    ) : (
                      '0 suppressed'
                    )}
                    {' · '}
                    {preview.excluded.ambiguous > 0 ? (
                      <button type="button" className="link-button" onClick={() => showAll('ambiguous')}>
                        {preview.excluded.ambiguous.toLocaleString()} store not confirmed
                      </button>
                    ) : (
                      '0 store not confirmed'
                    )}
                    {' · '}
                    {preview.excluded.noStatus.toLocaleString()} no status
                  </span>
                </div>
                {outOpen ? (
                  <>
                    <ContactsTable
                      rows={outRows}
                      sort={sort}
                      onSort={setSort}
                      onChanged={reload}
                      onError={setActionError}
                      leftOut
                    />
                    {excludedTotal > outRows.length ? (
                      <p className="contact-footnote">
                        Showing {outRows.length} of {excludedTotal.toLocaleString()}.
                      </p>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}
      </>
    );
  }

  const searching = debounced.trim() !== '' || linked !== 'all';

  return (
    <>
      {tabs}
      {ruleBar}

      {error ? (
        <div className="notice error">
          <h2>Could not load contacts</h2>
          <p>{error}</p>
        </div>
      ) : null}

      {!error && !loading && rows.length === 0 ? (
        <div className="notice">
          <h2>No contacts found</h2>
          <p>
            {searching
              ? 'Nothing matches those filters. Search matches name and email.'
              : 'Import a contacts CSV or wait for an app to push a login, then reload.'}
          </p>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <section className="card full cv-list">
          <div className="cv-summary">
            <span>
              <b className="tabular">{total.toLocaleString()}</b> {total === 1 ? 'contact' : 'contacts'}
              {debounced ? ` matching “${debounced}”` : ''}
            </span>
            <span className="cv-sub">
              {totals.unlinked.toLocaleString()} unlinked · {totals.ambiguous.toLocaleString()} ambiguous
              · {totals.suppressed.toLocaleString()} suppressed
            </span>
            {loading ? <span className="cv-sub">Updating…</span> : null}
          </div>

          <ContactsTable
            rows={rows.map((row) => fromContact(row, allAppId))}
            sort={sort}
            onSort={setSort}
            onChanged={reload}
            onError={setError}
          />

          <p className="contact-footnote">
            Suppressed rows are excluded from any send. A “+N” is a person linked to several
            stores — one contact, many memberships.
          </p>

          <Pager page={page} total={total} onPage={setPage} />
        </section>
      ) : null}
    </>
  );
}
