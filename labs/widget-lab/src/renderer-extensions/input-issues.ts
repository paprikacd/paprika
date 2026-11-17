import type { WidgetInputIssue } from '@insights/widget-registry';

/** Keeps an issue short enough to sit in the editor's status line. */
const bounded = (message: string) => message.slice(0, 240);

function issueFrom(error: unknown): WidgetInputIssue {
  // A configuration that fails its schema names the field it concerns; its message is the schema's own.
  const first = (error as { issues?: readonly { message?: unknown; path?: readonly PropertyKey[] }[] } | null)?.issues?.[0];
  if (first && typeof first.message === 'string') {
    const field = first.path?.[0];
    return { ...(typeof field === 'string' ? { field } : {}), message: bounded(first.message) };
  }
  return { message: bounded(error instanceof Error && error.message ? error.message : 'The loaded result cannot be drawn with this configuration.') };
}

/**
 * Runs a lab data check and returns its outcome as validateInput issues. The lab's data helpers report a problem by
 * throwing; the message becomes the one issue, so the editor shows it verbatim. Nothing throws past the registry.
 */
export function checkedInput(check: () => unknown): WidgetInputIssue[] {
  try {
    check();
    return [];
  } catch (error) {
    return [issueFrom(error)];
  }
}
