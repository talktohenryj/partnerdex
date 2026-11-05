import { useEffect, useState } from 'react';
import { fetchCampaigns, type AppSummary } from '../api';
import { EmailCampaigns } from './EmailCampaigns';
import { EmailCompose } from './EmailCompose';
import { EmailSettings } from './EmailSettings';

/**
 * The Email page: Campaigns and Settings tabs. Links, so every tab and every
 * campaign has a URL — `#/email`, `#/email/settings`, `#/email/new`,
 * `#/email/<campaign id>`.
 */
export function Email({ section, apps }: { section: string; apps: AppSummary[] }) {
  const onSettings = section === 'settings';
  const [campaignCount, setCampaignCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCampaigns()
      .then((result) => {
        if (!cancelled) setCampaignCount(result.campaigns.length);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [section]);

  const tab = (active: boolean) => (active ? 'page-tab is-active' : 'page-tab');

  return (
    <div className="email-page">
      <nav className="page-tabs" aria-label="Email sections">
        <a href="#/email" className={tab(!onSettings)} aria-current={!onSettings ? 'page' : undefined}>
          Campaigns
          {campaignCount !== null ? <span className="page-tab-count">{campaignCount}</span> : null}
        </a>
        <a href="#/email/settings" className={tab(onSettings)} aria-current={onSettings ? 'page' : undefined}>
          Settings
        </a>
      </nav>

      {onSettings ? (
        <EmailSettings apps={apps} />
      ) : section ? (
        <EmailCompose key={section} campaignId={section === 'new' ? null : section} />
      ) : (
        <EmailCampaigns />
      )}
    </div>
  );
}
