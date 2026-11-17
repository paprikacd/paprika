"use client";

import { useId, useState } from "react";
import { ImageIcon, Plus, Tag, X } from "lucide-react";
import { GammaButton } from "./gamma/button";
import { GammaDisclosure } from "./gamma/disclosure";
import { GammaInput } from "./gamma/input";
import {
  MAX_SAVED_QUERY_METADATA,
  MAX_SAVED_QUERY_TAGS,
  savedQueryImageUrlSchema,
  savedQueryMetadataKeySchema,
  savedQueryTagSchema,
  type SavedQuery,
} from "./schema";
import styles from "./saved-query-details-editor.module.css";

/** Optional library presentation. These fields never change the executed query. */
export function SavedQueryDetailsEditor({
  query,
  onChange,
  disabled = false,
  section = "all",
  collapsible = true,
}: {
  query: SavedQuery;
  onChange: (patch: Partial<SavedQuery>) => void;
  disabled?: boolean;
  section?: "all" | "tags" | "metadata";
  collapsible?: boolean;
}) {
  const id = useId();
  const [tagDraft, setTagDraft] = useState("");
  const [tagError, setTagError] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [valueDraft, setValueDraft] = useState("");
  const [metadataError, setMetadataError] = useState("");
  const [failedImage, setFailedImage] = useState("");
  const tags = query.tags ?? [];
  const metadata = Object.entries(query.metadata ?? {});
  const imageUrl = query.imageUrl ?? "";
  const imageValid = !!imageUrl && savedQueryImageUrlSchema.safeParse(imageUrl).success;
  const details = [imageUrl && "Image", tags.length && `${tags.length} tags`, metadata.length && `${metadata.length} fields`].filter(Boolean).join(" · ");

  function addTag() {
    const tag = tagDraft.trim();
    const parsed = savedQueryTagSchema.safeParse(tag);
    if (!parsed.success) { setTagError("Use a tag of 1–32 characters."); return; }
    if (tags.includes(tag)) { setTagError("That tag is already included."); return; }
    if (tags.length >= MAX_SAVED_QUERY_TAGS) { setTagError("Use at most 12 tags."); return; }
    onChange({ tags: [...tags, tag] });
    setTagDraft("");
    setTagError("");
  }

  function addMetadata() {
    const key = keyDraft.trim();
    if (!savedQueryMetadataKeySchema.safeParse(key).success) {
      setMetadataError("Use a key of 1–64 characters, without reserved names.");
      return;
    }
    if (metadata.some(([name]) => name === key)) { setMetadataError("That key already exists. Edit its value below."); return; }
    if (metadata.length >= MAX_SAVED_QUERY_METADATA) { setMetadataError("Use at most 12 metadata entries."); return; }
    onChange({ metadata: Object.fromEntries([...metadata, [key, valueDraft]]) });
    setKeyDraft("");
    setValueDraft("");
    setMetadataError("");
  }

  const fields = (
      <fieldset className={styles.editor} disabled={disabled}>
        <legend className={styles.srOnly}>Saved query {section === "tags" ? "tags" : "library details"}</legend>
        {section !== "tags" && <div className={styles.field}>
          <label htmlFor={`${id}-image`}>Cover image</label>
          <div className={styles.imageRow}>
            <div className={styles.preview}>
              {imageValid && failedImage !== imageUrl ? (
                // Arbitrary HTTPS and local assets are author-provided; no Next image proxy is needed.
                // eslint-disable-next-line @next/next/no-img-element
                <img key={imageUrl} src={imageUrl} alt="Saved query cover preview" referrerPolicy="no-referrer" onError={() => setFailedImage(imageUrl)} />
              ) : <ImageIcon size={20} aria-hidden="true" />}
            </div>
            <GammaInput
              id={`${id}-image`} aria-describedby={`${id}-image-help`} aria-invalid={!!imageUrl && !imageValid}
              size="sm" value={imageUrl} maxLength={2048} placeholder="https://… or /images/…"
              onChange={(event) => onChange({ imageUrl: event.target.value || undefined })}
            />
          </div>
          <p id={`${id}-image-help`} className={imageUrl && (!imageValid || failedImage === imageUrl) ? styles.error : styles.hint}>
            {!imageUrl ? "An HTTPS image URL or local image path. Shown in the query library."
              : !imageValid ? "Use an HTTPS URL or a path beginning with /, without credentials."
                : failedImage === imageUrl ? "Image could not be loaded. Check the URL or choose another image."
                  : "Cover preview. The image URL is saved with this query."}
          </p>
        </div>}

        {section !== "metadata" && <div className={styles.field}>
          <label htmlFor={`${id}-tag`}>Tags <span className={styles.count}>{tags.length}/12</span></label>
          {tags.length > 0 && <div className={styles.tags}>
            {tags.map((tag) => <span key={tag} className={styles.tag}>
              <Tag size={11} aria-hidden="true" /><span>{tag}</span>
              <button type="button" aria-label={`Remove tag ${tag}`} onClick={() => onChange({ tags: tags.filter((item) => item !== tag) })}><X size={12} aria-hidden="true" /></button>
            </span>)}
          </div>}
          <div className={styles.addRow}>
            <GammaInput id={`${id}-tag`} aria-label="New tag" size="sm" value={tagDraft} maxLength={32} placeholder="e.g. production" disabled={disabled || tags.length >= MAX_SAVED_QUERY_TAGS}
              aria-describedby={tagError ? `${id}-tag-error` : undefined} aria-invalid={!!tagError}
              onChange={(event) => { setTagDraft(event.target.value); setTagError(""); }}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addTag(); } }} />
            <GammaButton size="sm" disabled={!tagDraft.trim() || tags.length >= MAX_SAVED_QUERY_TAGS} onClick={addTag}><Plus size={13} aria-hidden="true" />Add tag</GammaButton>
          </div>
          {tagError && <p id={`${id}-tag-error`} role="alert" className={styles.error}>{tagError}</p>}
        </div>}

        {section !== "tags" && <div className={styles.field}>
          <span className={styles.label}>Metadata <span className={styles.count}>{metadata.length}/12</span></span>
          {metadata.map(([key, value]) => <div key={key} className={styles.metadataRow}>
            <label htmlFor={`${id}-metadata-${encodeURIComponent(key)}`} title={key}>{key}</label>
            <GammaInput id={`${id}-metadata-${encodeURIComponent(key)}`} size="sm" value={value} maxLength={256}
              onChange={(event) => onChange({ metadata: Object.fromEntries(metadata.map(([name, entry]) => [name, name === key ? event.target.value : entry])) })} />
            <GammaButton variant="quiet" size="sm" iconOnly aria-label={`Remove metadata ${key}`} onClick={() => onChange({ metadata: Object.fromEntries(metadata.filter(([name]) => name !== key)) })}><X size={13} aria-hidden="true" /></GammaButton>
          </div>)}
          {metadata.length < MAX_SAVED_QUERY_METADATA && <div className={styles.newMetadata}>
            <GammaInput size="sm" aria-label="New metadata key" value={keyDraft} maxLength={64} placeholder="Key, e.g. team"
              aria-invalid={!!metadataError} aria-describedby={metadataError ? `${id}-metadata-error` : undefined}
              onChange={(event) => { setKeyDraft(event.target.value); setMetadataError(""); }} />
            <GammaInput size="sm" aria-label="New metadata value" value={valueDraft} maxLength={256} placeholder="Value, e.g. platform" onChange={(event) => setValueDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addMetadata(); } }} />
            <GammaButton size="sm" disabled={!keyDraft.trim()} onClick={addMetadata}><Plus size={13} aria-hidden="true" />Add field</GammaButton>
          </div>}
          {metadataError && <p id={`${id}-metadata-error`} role="alert" className={styles.error}>{metadataError}</p>}
        </div>}
      </fieldset>
  );

  return collapsible ? <GammaDisclosure title="Library details" meta={details || "Optional"}>{fields}</GammaDisclosure> : fields;
}
