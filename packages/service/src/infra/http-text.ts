/** Ensure text responses declare UTF-8 so browsers don't default to ISO-8859-1. */
export function withUtf8Charset(contentType: string): string {
  const base = (contentType || "text/plain").split(";")[0].trim() || "text/plain";
  if (/charset=/i.test(contentType)) return contentType;
  return `${base}; charset=utf-8`;
}

export function isTextualMime(mime: string | null | undefined): boolean {
  if (!mime) return false;
  const m = mime.toLowerCase().split(";")[0].trim();
  return (
    m.startsWith("text/") ||
    m === "application/json" ||
    m === "application/xml" ||
    m === "application/javascript" ||
    m.endsWith("+json") ||
    m.endsWith("+xml") ||
    m === "application/x-yaml" ||
    m === "application/yaml"
  );
}
