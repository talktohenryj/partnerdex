import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createCampaign,
  deleteCampaign,
  fetchAudiences,
  fetchCampaign,
  fetchEmailSettings,
  prepareCampaign,
  renderCampaign,
  sendCampaign,
  sendTestEmail,
  updateCampaign,
  type EmailCampaign,
  type EmailSettingsResponse,
  type PrepareResult,
  type PreviewFilter,
  type RenderedPreview,
  type SavedAudienceSummary,
} from '../api';
import { BlockedBanner, CampaignStatusPill } from './EmailCampaigns';
import { EmailPreview } from './EmailPreview';
import { EmailProgress, PAUSE_CHOICES } from './EmailProgress';

const INSERTS: Array<{ label: string; text: string }> = [
  { label: 'first_name', text: '{{first_name|there}}' },
  { label: 'shop_name', text: '{{shop_name}}' },
  { label: 'app_name', text: '{{app_name}}' },
  { label: 'button', text: '{{button "Open the app" page="home"}}' },
];

interface Draft {
  name: string;
  audienceId: string;
  emailType: string;
  subject: string;
  previewText: string;
  body: string;
}

const BLANK: Draft = { name: '', audienceId: '', emailType: 'product_updates', subject: '', previewText: '', body: '' };

function draftOf(campaign: EmailCampaign): Draft {
  return {
    name: campaign.name,
    audienceId: campaign.audienceId ?? '',
    emailType: campaign.emailType,
    subject: campaign.subject,
    previewText: campaign.previewText,
    body: campaign.body,
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (Object.keys(a) as Array<keyof Draft>).every((key) => a[key] === b[key]);
}

/** The one modal: what goes out, to how many, and a box to type the count. */
function ConfirmSend({
  campaign,
  result,
  audienceName,
  onClose,
  onSent,
}: {
  campaign: EmailCampaign;
  result: PrepareResult;
  audienceName: string;
  onClose: () => void;
  onSent: (campaign: EmailCampaign) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState('');
  // Send the first few, then pause: the safe default when there are more than that.
  const canStage = result.count > PAUSE_CHOICES[0];
  const [mode, setMode] = useState<'stage' | 'all'>(canStage ? 'stage' : 'all');
  const [first, setFirst] = useState<number>(PAUSE_CHOICES.find((n) => n === 10 && n < result.count) ?? PAUSE_CHOICES[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      onSent(await sendCampaign(campaign.id, Number(typed), mode === 'stage' ? first : null));
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  };

  const { excluded } = result;
  const left = excluded.suppressed + excluded.ambiguous + excluded.noStatus + excluded.unsubscribedType;
  const parts = [
    excluded.suppressed ? `${excluded.suppressed} suppressed` : '',
    excluded.ambiguous ? `${excluded.ambiguous} store match not confirmed` : '',
    excluded.noStatus ? `${excluded.noStatus} no status` : '',
    excluded.unsubscribedType ? `${excluded.unsubscribedType} turned off ${result.typeLabel}` : '',
  ].filter(Boolean);
  const count = result.count.toLocaleString();

  return (
    <dialog ref={dialog} className="modal email-confirm" onClose={onClose} aria-labelledby="email-confirm-title">
      <div className="modal-head">
        <h2 id="email-confirm-title">Send this email?</h2>
        <button type="button" className="modal-close" aria-label="Close" onClick={() => dialog.current?.close()}>
          ×
        </button>
      </div>
      <p>
        This sends <b>{count}</b> email{result.count === 1 ? '' : 's'} from <b>{result.from}</b>.
      </p>
      <p className="email-sub">
        Subject: &ldquo;{campaign.subject}&rdquo; · Audience: {audienceName} · Type: {result.typeLabel}
      </p>
      {left > 0 || excluded.merged > 0 ? (
        <p className="email-sub">
          {left > 0 ? `${left} left out (${parts.join(' · ')})` : ''}
          {left > 0 && excluded.merged > 0 ? ' · ' : ''}
          {excluded.merged > 0 ? `${excluded.merged} duplicates merged` : ''}
        </p>
      ) : null}
      {result.missingFirstName > 0 ? (
        <p className="channel-status bad">
          {result.missingFirstName} recipient{result.missingFirstName === 1 ? ' has' : 's have'} no first name, and the
          email uses {'{{first_name}}'} with no fallback. Add one, for example {'{{first_name|there}}'}.
        </p>
      ) : null}
      {result.missingPageLinks > 0 ? (
        <p className="channel-status bad">
          {result.missingPageLinks} recipient{result.missingPageLinks === 1 ? '' : 's'} will get the button label without a
          link: their store has no myshopify domain, or the app has no admin handle.
        </p>
      ) : null}
      <p className="email-sub">Sample: {result.sample.map((entry) => entry.email).join(' · ')}{result.count > result.sample.length ? ' · …' : ''}</p>
      {canStage ? (
        <fieldset className="email-stage">
          <legend className="sr-only">How to send</legend>
          <label className="email-stage-option">
            <input type="radio" name="email-stage" checked={mode === 'stage'} onChange={() => setMode('stage')} />
            <span>
              <span className="email-stage-line">
                Send the first
                <select
                  aria-label="How many to send first"
                  value={first}
                  onChange={(event) => {
                    setFirst(Number(event.target.value));
                    setMode('stage');
                  }}
                >
                  {PAUSE_CHOICES.filter((n) => n < result.count).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                and pause
              </span>
              <small>Check them, then send the rest from the campaign page.</small>
            </span>
          </label>
          <label className="email-stage-option">
            <input type="radio" name="email-stage" checked={mode === 'all'} onChange={() => setMode('all')} />
            <span>
              Send all {count} now
              <small>You can still pause while it sends, but a small list goes out in seconds.</small>
            </span>
          </label>
        </fieldset>
      ) : null}
      <div className="control">
        <label htmlFor="email-confirm-count">Type {result.count} to send</label>
        <input
          id="email-confirm-count"
          inputMode="numeric"
          autoComplete="off"
          value={typed}
          onChange={(event) => setTyped(event.target.value.trim())}
        />
      </div>
      {error ? <p className="channel-status bad">{error}</p> : null}
      <div className="email-actions">
        <button type="button" onClick={() => dialog.current?.close()}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={busy || typed !== String(result.count)} onClick={send}>
          {busy ? 'Starting…' : mode === 'stage' ? `Send ${first}, then pause` : `Send ${count} emails`}
        </button>
      </div>
    </dialog>
  );
}

export function EmailCompose({ campaignId }: { campaignId: string | null }) {
  const [campaign, setCampaign] = useState<EmailCampaign | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [savedDraft, setSavedDraft] = useState<Draft>(BLANK);
  const [audiences, setAudiences] = useState<SavedAudienceSummary[]>([]);
  const [settings, setSettings] = useState<EmailSettingsResponse | null>(null);
  const [preview, setPreview] = useState<RenderedPreview | null>(null);
  // Whose values the preview and the test use; null = the first in the filter.
  const [previewAs, setPreviewAs] = useState<string | null>(null);
  const [previewFilter, setPreviewFilter] = useState<PreviewFilter>('all');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [testTo, setTestTo] = useState('');
  const [prepared, setPrepared] = useState<PrepareResult | null>(null);
  const [loading, setLoading] = useState(campaignId !== null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetchAudiences()
      .then((result) => setAudiences(result.audiences))
      .catch(() => setAudiences([]));
    fetchEmailSettings()
      .then((result) => {
        setSettings(result);
        setTestTo(result.settings.replyTo || result.settings.fromEmail);
      })
      .catch(() => setSettings(null));
  }, []);

  const adopt = useCallback((next: EmailCampaign) => {
    setCampaign(next);
    const nextDraft = draftOf(next);
    setDraft(nextDraft);
    setSavedDraft(nextDraft);
  }, []);

  useEffect(() => {
    if (!campaignId) return;
    fetchCampaign(campaignId)
      .then(adopt)
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setLoading(false));
  }, [campaignId, adopt]);

  const editable = !campaign || campaign.status === 'draft' || campaign.status === 'ready';

  // Poll while sending.
  useEffect(() => {
    if (!campaign || campaign.status !== 'sending') return;
    const timer = window.setInterval(() => {
      fetchCampaign(campaign.id).then(setCampaign).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [campaign]);

  const refreshPreview = useCallback(
    async (id: string) => {
      try {
        setPreview(await renderCampaign(id, { email: previewAs, filter: previewFilter }));
      } catch (cause) {
        setError((cause as Error).message);
      }
    },
    [previewAs, previewFilter],
  );

  // Live preview: save the draft 400 ms after typing stops, then render it.
  useEffect(() => {
    if (!campaign || !editable) return;
    if (sameDraft(draft, savedDraft)) {
      void refreshPreview(campaign.id);
      return;
    }
    const timer = window.setTimeout(async () => {
      if (!draft.name.trim() || !draft.audienceId) return;
      try {
        const next = await updateCampaign(campaign.id, draft);
        setCampaign(next);
        setSavedDraft(draftOf(next));
        setError(null);
      } catch (cause) {
        setError((cause as Error).message);
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [draft, savedDraft, campaign, editable, refreshPreview]);

  const set = (field: keyof Draft) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setDraft((current) => ({ ...current, [field]: event.target.value }));

  const insert = (text: string) => {
    const element = bodyRef.current;
    const start = element?.selectionStart ?? draft.body.length;
    const end = element?.selectionEnd ?? draft.body.length;
    const body = `${draft.body.slice(0, start)}${text}${draft.body.slice(end)}`;
    setDraft((current) => ({ ...current, body }));
    window.requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(start + text.length, start + text.length);
    });
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const saveDraft = () =>
    run('save', async () => {
      if (!campaign) {
        const created = await createCampaign(draft);
        window.location.hash = `#/email/${encodeURIComponent(created.id)}`;
        return;
      }
      adopt(await updateCampaign(campaign.id, draft));
      setNote('Draft saved.');
    });

  const sendTest = () =>
    run('test', async () => {
      if (!campaign) return;
      if (!sameDraft(draft, savedDraft)) adopt(await updateCampaign(campaign.id, draft));
      const sent = await sendTestEmail(campaign.id, testTo, preview?.to);
      setNote(`Test sent to ${sent.to}.`);
    });

  const review = () =>
    run('prepare', async () => {
      if (!campaign) return;
      if (!sameDraft(draft, savedDraft)) adopt(await updateCampaign(campaign.id, draft));
      const result = await prepareCampaign(campaign.id);
      setCampaign(await fetchCampaign(campaign.id));
      setPrepared(result);
    });

  const remove = () =>
    run('delete', async () => {
      if (!campaign) return;
      await deleteCampaign(campaign.id);
      window.location.hash = '#/email';
    });

  if (loading) return <div className="skeleton">Loading campaign…</div>;
  if (campaignId && !campaign) {
    return (
      <div className="notice error">
        <h2>Could not load the campaign</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (campaign && !editable) {
    return (
      <>
        <a className="back-link" href="#/email">
          ← Campaigns
        </a>
        <EmailProgress campaign={campaign} onChange={setCampaign} />
      </>
    );
  }

  const audience = audiences.find((entry) => entry.id === draft.audienceId);
  const blocked = settings?.blockedReason ?? null;

  return (
    <>
      <a className="back-link" href="#/email">
        ← Campaigns
      </a>
      <BlockedBanner reason={blocked} />
      <div className="email-compose">
        <section className="card email-card">
          <div className="card-head">
            <h2 className="card-label">
              Compose {campaign ? <CampaignStatusPill status={campaign.status} /> : null}
            </h2>
            {campaign ? (
              <button type="button" className="link-button" onClick={remove} disabled={busy !== null}>
                Delete
              </button>
            ) : null}
          </div>
          <div className="email-form">
            <div className="control">
              <label htmlFor="email-name">Name</label>
              <input id="email-name" value={draft.name} onChange={set('name')} placeholder="Q4 ideas" />
            </div>
            <div className="control">
              <label htmlFor="email-audience">Audience</label>
              <select id="email-audience" value={draft.audienceId} onChange={set('audienceId')}>
                <option value="">Choose a saved audience</option>
                {audiences.map((entry) => (
                  <option key={entry.id} value={entry.id} disabled={entry.stale}>
                    {entry.name}
                    {entry.stale ? ' (app out of scope)' : ` · ${(entry.count ?? 0).toLocaleString()} people`}
                  </option>
                ))}
              </select>
              <span className="email-sub">
                {draft.audienceId ? (
                  <a href={`#/contacts/${encodeURIComponent(draft.audienceId)}`}>Edit in Contacts</a>
                ) : (
                  <>
                    To make a new audience, save it on the <a href="#/contacts">Contacts page</a> first.
                  </>
                )}
              </span>
            </div>
            <div className="control">
              <label htmlFor="email-type">Email type</label>
              <select id="email-type" value={draft.emailType} onChange={set('emailType')}>
                {(settings?.types ?? []).map((type) => (
                  <option key={type.key} value={type.key}>
                    {type.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="control">
              <label htmlFor="email-subject">Subject</label>
              <input id="email-subject" value={draft.subject} onChange={set('subject')} maxLength={200} placeholder="{{first_name|Hi}}, 3 ideas for Q4" />
            </div>
            <div className="control">
              <label htmlFor="email-preview">Preview text</label>
              <input id="email-preview" value={draft.previewText} onChange={set('previewText')} maxLength={150} placeholder="The line inboxes show after the subject." />
            </div>
            <div className="control">
              <label htmlFor="email-body">Body</label>
              <textarea
                id="email-body"
                ref={bodyRef}
                rows={14}
                value={draft.body}
                onChange={set('body')}
                placeholder={'Hi {{first_name|there}},\n\nA blank line starts a new paragraph. **bold**, *italic*, [a link](https://example.com).'}
              />
              <div className="email-inserts" aria-label="Insert a merge field">
                {INSERTS.map((entry) => (
                  <button key={entry.label} type="button" className="email-chip" onClick={() => insert(entry.text)}>
                    + {entry.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="email-actions email-actions-wrap">
            <button type="button" onClick={saveDraft} disabled={busy !== null || !draft.name.trim() || !draft.audienceId}>
              {busy === 'save' ? 'Saving…' : campaign ? 'Save draft' : 'Create draft'}
            </button>
            {campaign ? (
              <span className="email-test">
                <input aria-label="Send the test to" type="email" value={testTo} onChange={(event) => setTestTo(event.target.value)} />
                <button type="button" onClick={sendTest} disabled={busy !== null || blocked !== null}>
                  {busy === 'test' ? 'Sending…' : 'Send test'}
                </button>
              </span>
            ) : null}
            <button
              type="button"
              className="primary"
              onClick={review}
              disabled={!campaign || busy !== null || blocked !== null || !draft.subject.trim() || !draft.body.trim()}
            >
              {busy === 'prepare' ? 'Preparing…' : 'Review and send…'}
            </button>
            {campaign && preview ? (
              <p className="pa-testnote">The test uses the values of {preview.to}, the recipient in the preview.</p>
            ) : null}
          </div>
          {error ? <p className="channel-status bad">{error}</p> : null}
          {note ? <p className="channel-status good">{note}</p> : null}
        </section>

        <section className="card email-card email-preview">
          {preview && campaign ? (
            <EmailPreview
              campaignId={campaign.id}
              preview={preview}
              filter={previewFilter}
              onAs={setPreviewAs}
              onFilter={(next) => {
                setPreviewFilter(next);
                setPreviewAs(null);
              }}
            />
          ) : (
            <>
              <h2 className="card-label">Preview</h2>
              <p className="email-empty">{campaign ? 'Rendering…' : 'Create the draft to see the preview.'}</p>
            </>
          )}
        </section>
      </div>

      {prepared && campaign ? (
        <ConfirmSend
          campaign={campaign}
          result={prepared}
          audienceName={audience?.name ?? campaign.audienceName ?? 'Audience'}
          onClose={() => setPrepared(null)}
          onSent={(next) => {
            setPrepared(null);
            setCampaign(next);
          }}
        />
      ) : null}
    </>
  );
}
