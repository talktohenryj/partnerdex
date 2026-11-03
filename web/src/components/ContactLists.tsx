import type { SavedAudienceSummary } from '../api';

/**
 * The saved lists over the Contacts table: All contacts first, then each
 * saved audience with its live count. Saving the rules on All contacts adds
 * a tab. Links, so every list has a URL.
 */
export function ContactLists({
  listId,
  allCount,
  audiences,
}: {
  /** '' for All contacts, otherwise an audience id. */
  listId: string;
  allCount: number | null;
  audiences: SavedAudienceSummary[];
}) {
  const tab = (active: boolean) => (active ? 'page-tab is-active' : 'page-tab');
  return (
    <nav className="page-tabs cv-views" aria-label="Contact lists">
      <a
        href="#/contacts"
        className={tab(listId === '')}
        aria-current={listId === '' ? 'page' : undefined}
      >
        All contacts
        {allCount !== null ? (
          <span className="page-tab-count">{allCount.toLocaleString()}</span>
        ) : null}
      </a>
      {audiences.map((audience) => (
        <a
          key={audience.id}
          href={`#/contacts/${encodeURIComponent(audience.id)}`}
          className={tab(listId === audience.id)}
          aria-current={listId === audience.id ? 'page' : undefined}
        >
          {audience.name}
          {audience.stale ? (
            <span className="pill pill-ambiguous cv-stale">App out of scope</span>
          ) : (
            <span className="page-tab-count">{(audience.count ?? 0).toLocaleString()}</span>
          )}
        </a>
      ))}
    </nav>
  );
}
