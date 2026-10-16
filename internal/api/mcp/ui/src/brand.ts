// The production build embeds the existing Paprika icon. A source-only view
// render (for tests) does not need an image loader or a browser asset request.
declare const __PAPRIKA_MARK_DATA_URI__: string;
export const paprikaMark = typeof __PAPRIKA_MARK_DATA_URI__ === "string" ? __PAPRIKA_MARK_DATA_URI__ : "";
