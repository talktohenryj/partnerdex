import { useEffect, useState } from 'react';
import {
  fetchAppLinks,
  fetchContactCandidates,
  fetchEmailSettings,
  fetchSenderDomain,
  saveAppLinks,
  saveEmailSettings,
  type AppPage,
  type AppSummary,
  type DomainStatus,
  type EmailSender,
} from '../api';
import { BlockedBanner } from './EmailCampaigns';

const DOMAIN_LABEL: Record<DomainStatus, string> = {
  verified: 'Domain verified',
  pending: 'Domain pending',
  failed: 'Domain failed',
  not_found: 'Not in Resend',
};

const EMPTY: EmailSender = { fromName: '', fromEmail: '', replyTo: '', footerAddress: '', buttonColor: '#2e72d2' };

function SenderCard({ onBlocked }: { onBlocked: (reason: string | null) => void }) {
  const [form, setForm] = useState<EmailSender>(EMPTY);
  const [saved, setSaved] = useState<EmailSender>(EMPTY);
  const [domain, setDomain] = useState<{ domain: string | null; status: DomainStatus | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const loadDomain = () =>
    fetchSenderDomain()
      .then((result) => {
        setDomain(result);
        onBlocked(result.blockedReason);
      })
      .catch(() => setDomain({ domain: null, status: null }));

  useEffect(() => {
    fetchEmailSettings()
      .then((result) => {
        const sender = { ...EMPTY, ...result.settings };
        setForm(sender);
        setSaved(sender);
        onBlocked(result.blockedReason);
      })
      .catch((cause: Error) => setError(cause.message));
    void loadDomain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (field: keyof EmailSender) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((current) => ({ ...current, [field]: event.target.value }));

  const dirty = (Object.keys(form) as Array<keyof EmailSender>).some((key) => form[key] !== saved[key]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await saveEmailSettings(form);
      const sender = { ...EMPTY, ...result.settings };
      setForm(sender);
      setSaved(sender);
      onBlocked(result.blockedReason);
      setNote('Saved. Changes apply to the next campaign you prepare.');
      void loadDomain();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card full email-card">
      <div className="card-head">
        <div>
          <h2 className="card-label">Sender</h2>
          <p className="email-sub">Every email goes out with these details. Changes apply to the next campaign you prepare.</p>
        </div>
        {domain?.status ? (
          <span className={`pill email-domain-${domain.status}`} title={domain.domain ?? undefined}>
            {DOMAIN_LABEL[domain.status]}
          </span>
        ) : null}
      </div>
      <form className="email-form" onSubmit={save}>
        <div className="email-grid">
          <div className="control">
            <label htmlFor="email-from-name">From name</label>
            <input id="email-from-name" value={form.fromName} onChange={set('fromName')} maxLength={80} placeholder="Sam from Example App" />
          </div>
          <div className="control">
            <label htmlFor="email-from-email">From email</label>
            <input id="email-from-email" type="email" value={form.fromEmail} onChange={set('fromEmail')} placeholder="sam@updates.example.com" spellCheck={false} />
          </div>
          <div className="control">
            <label htmlFor="email-reply-to">Reply-To</label>
            <input id="email-reply-to" type="email" value={form.replyTo} onChange={set('replyTo')} placeholder="sam@example.com" spellCheck={false} />
          </div>
          <div className="control">
            <label htmlFor="email-button-color">Button colour</label>
            <div className="email-color">
              <input
                type="color"
                aria-label="Button colour picker"
                value={/^#[0-9a-f]{6}$/i.test(form.buttonColor) ? form.buttonColor : '#2e72d2'}
                onChange={set('buttonColor')}
              />
              <input id="email-button-color" value={form.buttonColor} onChange={set('buttonColor')} spellCheck={false} />
            </div>
          </div>
          <div className="control email-span">
            <label htmlFor="email-footer">Footer postal address</label>
            <textarea
              id="email-footer"
              rows={2}
              value={form.footerAddress}
              onChange={set('footerAddress')}
              placeholder="Business name · Street · City, State ZIP"
            />
          </div>
        </div>
        <div className="email-actions">
          <button type="submit" className="primary" disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save sender'}
          </button>
          {domain?.domain && domain.status && domain.status !== 'verified' ? (
            <span className="channel-status bad">
              {domain.domain}: {DOMAIN_LABEL[domain.status].toLowerCase()}. Verify it in Resend before you send.
            </span>
          ) : null}
        </div>
        {error ? <p className="channel-status bad">{error}</p> : null}
        {note ? <p className="channel-status good">{note}</p> : null}
      </form>
    </section>
  );
}

interface StoreOption {
  name: string;
  domain: string;
}

function AppLinksCard({ apps }: { apps: AppSummary[] }) {
  const [appId, setAppId] = useState('');
  const [handle, setHandle] = useState('');
  const [pages, setPages] = useState<AppPage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [tryPage, setTryPage] = useState('');
  const [tryStore, setTryStore] = useState('example-store.myshopify.com');
  const [stores, setStores] = useState<StoreOption[]>([]);

  // Suggestions for the store box: shops whose name or domain matches.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const term = tryStore.trim();
      fetchContactCandidates(term.endsWith('.myshopify.com') ? '' : term)
        .then((result) =>
          setStores(
            result.candidates
              .filter((candidate) => candidate.domain)
              .map((candidate) => ({ name: candidate.name ?? candidate.domain!, domain: candidate.domain! })),
          ),
        )
        .catch(() => setStores([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [tryStore]);

  useEffect(() => {
    if (!appId && apps[0]) setAppId(apps[0].id);
  }, [apps, appId]);

  useEffect(() => {
    if (!appId) return;
    setError(null);
    setNote(null);
    fetchAppLinks(appId)
      .then((links) => {
        setHandle(links.adminHandle);
        setPages(links.pages);
        setTryPage(links.pages[0]?.key ?? '');
      })
      .catch((cause: Error) => setError(cause.message));
  }, [appId]);

  const update = (index: number, field: keyof AppPage, value: string) =>
    setPages((current) => current.map((page, i) => (i === index ? { ...page, [field]: value } : page)));

  const save = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const saved = await saveAppLinks(appId, { adminHandle: handle, pages });
      setHandle(saved.adminHandle);
      setPages(saved.pages);
      setNote('Links saved.');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const storeHandle = /^([a-z0-9][a-z0-9-]*)\.myshopify\.com$/.exec(tryStore.trim().toLowerCase())?.[1] ?? null;
  const page = pages.find((entry) => entry.key === tryPage) ?? pages[0];
  const builtUrl = storeHandle && page && handle ? `https://admin.shopify.com/store/${storeHandle}/apps/${handle}${page.path}` : null;

  if (apps.length === 0) {
    return (
      <section className="card full email-card">
        <h2 className="card-label">App links</h2>
        <p className="email-empty">No apps in reporting scope yet.</p>
      </section>
    );
  }

  return (
    <section className="card full email-card">
      <div className="card-head">
        <div>
          <h2 className="card-label">App links</h2>
          <p className="email-sub">
            The pages a button in an email can open. Each link is admin.shopify.com/store/&lt;store&gt;/apps/&lt;admin
            handle&gt;&lt;path&gt;, built for each recipient&rsquo;s store.
          </p>
        </div>
      </div>
      <div className="field-row">
        <div className="control">
          <label htmlFor="email-links-app">App</label>
          <select id="email-links-app" value={appId} onChange={(event) => setAppId(event.target.value)}>
            {apps.map((app) => (
              <option key={app.id} value={app.id}>
                {app.name}
              </option>
            ))}
          </select>
        </div>
        <div className="control control-grow">
          <label htmlFor="email-links-handle">Admin handle</label>
          <input id="email-links-handle" value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="example-app" spellCheck={false} />
        </div>
      </div>

      <div className="email-pages" role="group" aria-label="Pages">
        {pages.length > 0 ? (
          <div className="email-page-row email-page-head" aria-hidden="true">
            <span>Page key</span>
            <span>Label</span>
            <span>Path</span>
            <span />
          </div>
        ) : null}
        {pages.map((entry, index) => (
          <div className="email-page-row" key={index}>
            <input aria-label={`Page ${index + 1} key`} placeholder="orders" value={entry.key} onChange={(event) => update(index, 'key', event.target.value)} spellCheck={false} />
            <input aria-label={`Page ${index + 1} label`} placeholder="Orders" value={entry.label} onChange={(event) => update(index, 'label', event.target.value)} />
            <input aria-label={`Page ${index + 1} path`} placeholder="/react/orders" value={entry.path} onChange={(event) => update(index, 'path', event.target.value)} spellCheck={false} />
            <button type="button" className="link-button" onClick={() => setPages((current) => current.filter((_, i) => i !== index))}>
              Remove
            </button>
          </div>
        ))}
        {pages.length === 0 ? <p className="email-empty">No pages yet.</p> : null}
      </div>

      <div className="email-actions">
        <button
          type="button"
          onClick={() => setPages((current) => [...current, { key: '', label: '', path: '/' }])}
          disabled={pages.length >= 20}
        >
          Add page
        </button>
        <button type="button" className="primary" onClick={save} disabled={busy || !appId}>
          {busy ? 'Saving…' : 'Save links'}
        </button>
      </div>
      {error ? <p className="channel-status bad">{error}</p> : null}
      {note ? <p className="channel-status good">{note}</p> : null}

      <div className="email-try">
        <h3 className="card-label">Try it</h3>
        <div className="field-row">
          <div className="control control-grow">
            <label htmlFor="email-try-store">Store (myshopify domain)</label>
            <input id="email-try-store" list="email-try-stores" value={tryStore} onChange={(event) => setTryStore(event.target.value)} spellCheck={false} />
            <datalist id="email-try-stores">
              {stores.map((store) => (
                <option key={store.domain} value={store.domain}>
                  {store.name}
                </option>
              ))}
            </datalist>
          </div>
          <div className="control">
            <label htmlFor="email-try-page">Page</label>
            <select id="email-try-page" value={page?.key ?? ''} onChange={(event) => setTryPage(event.target.value)}>
              {pages.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.label || entry.key}
                </option>
              ))}
            </select>
          </div>
        </div>
        {builtUrl ? (
          <p className="email-url">
            <code>{builtUrl}</code>{' '}
            <a href={builtUrl} target="_blank" rel="noreferrer noopener">
              Open
            </a>
          </p>
        ) : (
          <p className="email-sub">Enter a store such as example-store.myshopify.com, an admin handle, and a page.</p>
        )}
      </div>

      <div className="email-try">
        <h3 className="card-label">How a page button looks</h3>
        <p className="email-sub">
          In the editor: <code>{'{{button "Go to your Orders page" page="orders"}}'}</code>. A link instead of a button:{' '}
          <code>[your orders](page:orders)</code>. The text version of the email shows the label and the URL.
        </p>
      </div>
    </section>
  );
}

export function EmailSettings({ apps }: { apps: AppSummary[] }) {
  const [blocked, setBlocked] = useState<string | null>(null);
  return (
    <>
      <BlockedBanner reason={blocked} />
      <SenderCard onBlocked={setBlocked} />
      <AppLinksCard apps={apps} />
    </>
  );
}
