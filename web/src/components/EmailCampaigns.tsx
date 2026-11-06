import { useEffect, useState } from 'react';
import { fetchAudiences, fetchCampaigns, type EmailCampaign, type SavedAudienceSummary } from '../api';
import { formatDateTime } from '../format';

const STATUS_LABEL: Record<EmailCampaign['status'], string> = {
  draft: 'Draft',
  ready: 'Ready',
  sending: 'Sending',
  paused: 'Paused',
  sent: 'Sent',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

export function CampaignStatusPill({ status }: { status: EmailCampaign['status'] }) {
  return <span className={`pill email-status-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function audienceSummary(campaign: EmailCampaign, audiences: SavedAudienceSummary[]): string {
  if (campaign.audienceName) return campaign.audienceName;
  const saved = audiences.find((audience) => audience.id === campaign.audienceId);
  if (saved) return saved.name;
  const { statuses, roles } = campaign.audience;
  return `${statuses.join(', ')} · ${roles.join(', ')}`;
}

export function BlockedBanner({ reason }: { reason: string | null }) {
  if (!reason) return null;
  return (
    <div className="notice warn" role="status">
      <h2>Sending is off</h2>
      <p>{reason}</p>
    </div>
  );
}

export function EmailCampaigns() {
  const [campaigns, setCampaigns] = useState<EmailCampaign[] | null>(null);
  const [audiences, setAudiences] = useState<SavedAudienceSummary[]>([]);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchCampaigns(), fetchAudiences().catch(() => ({ audiences: [] }))])
      .then(([result, saved]) => {
        if (cancelled) return;
        setCampaigns(result.campaigns);
        setBlocked(result.blockedReason);
        setAudiences(saved.audiences);
      })
      .catch((cause: Error) => !cancelled && setError(cause.message));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="notice error">
        <h2>Could not load campaigns</h2>
        <p>{error}</p>
      </div>
    );
  }
  if (!campaigns) return <div className="skeleton">Loading campaigns…</div>;

  return (
    <>
      <BlockedBanner reason={blocked} />
      <section className="card full email-card">
        <div className="card-head">
          <div>
            <h2 className="card-label">Campaigns</h2>
            <p className="email-sub">One email to one audience. Prepare freezes the list; you confirm by typing the count.</p>
          </div>
          <a className="email-cta" href="#/email/new">
            New campaign
          </a>
        </div>
        {campaigns.length === 0 ? (
          <p className="email-empty">No campaigns yet. Save an audience on the Contacts page, then start one here.</p>
        ) : (
          <div className="table-wrap">
            <table className="email-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Status</th>
                  <th scope="col">Audience</th>
                  <th scope="col">Recipients</th>
                  <th scope="col">Sent</th>
                  <th scope="col">Date</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((campaign) => (
                  <tr key={campaign.id}>
                    <td>
                      <a className="customer-link" href={`#/email/${encodeURIComponent(campaign.id)}`}>
                        {campaign.name}
                      </a>
                    </td>
                    <td>
                      <CampaignStatusPill status={campaign.status} />
                    </td>
                    <td>{audienceSummary(campaign, audiences)}</td>
                    <td>{campaign.recipientCount ? campaign.recipientCount.toLocaleString() : '—'}</td>
                    <td>{campaign.sentCount ? campaign.sentCount.toLocaleString() : '—'}</td>
                    <td>{formatDateTime(campaign.finishedAt ?? campaign.startedAt ?? campaign.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
