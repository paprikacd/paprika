/** The messages of a validateInput result, one per line, for assertions that read what the editor would show. */
export const issueText = (issues?: readonly { message: string }[]) => (issues ?? []).map(issue => issue.message).join('\n');
