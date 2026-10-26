"use client";

import { useState } from "react";
import type { SavedQuery } from "./schema";
import type { GammaSelectOption } from "./gamma/select";
import { QuerySourceIcon } from "./source-identity";
import styles from "./saved-query-presentation.module.css";

export function SavedQueryArtwork({ query }: { query: SavedQuery }) {
  const [failed, setFailed] = useState<string>();
  return query.imageUrl && failed !== query.imageUrl ? (
    <span className={styles.artwork}>
      {/* External library artwork is optional and doesn't require image proxy configuration. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={query.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(query.imageUrl)} />
    </span>
  ) : <QuerySourceIcon kind="saved" />;
}

export function SavedQueryTags({ query, limit = 3 }: { query: SavedQuery; limit?: number }) {
  const tags = query.tags ?? [];
  if (!tags.length) return null;
  return <span className={styles.tags} data-query-tags="">
    <span className={styles.srOnly}>Tags: {tags.join(", ")}</span>
    {tags.slice(0, limit).map((tag) => <span key={tag} className={styles.tag} title={tag} aria-hidden="true">{tag}</span>)}
    {tags.length > limit && <span className={styles.more} title={tags.slice(limit).join(", ")} aria-hidden="true">+{tags.length - limit}</span>}
  </span>;
}

export function SavedQueryDetails({ query }: { query: SavedQuery }) {
  const metadata = Object.entries(query.metadata ?? {});
  if (!query.tags?.length && !metadata.length) return null;
  return (
    <span className={styles.details}>
      <SavedQueryTags query={query} />
      {metadata.length > 0 && <span className={styles.metadata}>
        {metadata.slice(0, 2).map(([key, value]) => <span key={key} title={`${key}: ${value}`}><span>{key}</span> {value}</span>)}
        {metadata.length > 2 && <span>+{metadata.length - 2} details</span>}
      </span>}
    </span>
  );
}

export function savedQuerySearchText(query: SavedQuery): string {
  return [query.name, query.description, query.id, query.providerId, query.query,
    ...(query.tags ?? []), ...Object.entries(query.metadata ?? {}).flat()].filter(Boolean).join(" ");
}

export function savedQueryOption(query: SavedQuery): GammaSelectOption {
  return {
    value: query.id,
    label: query.name,
    accessibleLabel: query.name,
    description: query.description || `${query.kind === "metrics" ? "PromQL" : "TraceQL"} · ${query.parameters?.length ?? 0} parameters`,
    icon: <SavedQueryArtwork query={query} />,
    details: <SavedQueryDetails query={query} />,
    ...(query.tags?.length ? { selectedDetails: <SavedQueryTags query={query} limit={2} /> } : {}),
    keywords: [savedQuerySearchText(query)],
  };
}
