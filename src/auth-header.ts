import { WazapError } from "./errors.js";

export interface AuthHeader {
  name: string;
  value: string;
}

/** Headers wazap sets itself, and the ones fetch owns or refuses to send. */
const RESERVED_HEADERS = new Set([
  "content-type",
  "content-length",
  "user-agent",
  "host",
  "connection",
  "transfer-encoding",
  "upgrade",
  "expect",
  "keep-alive",
  "proxy-connection",
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Authorization value or named header; errors never repeat the credential. */
export function parseAuthHeader(
  raw: string,
  label: string,
  fix: string,
  reserved: readonly string[] = []
): AuthHeader | null {
  const typed = raw.trim();
  if (typed === "") return null;
  // A header line puts a token, a colon and a space first; "Bearer abc:def" has a space before its colon.
  const named = /^([^\s:]+):\s*(.*)$/.exec(typed);
  const auth = named !== null ? { name: named[1]!, value: named[2]!.trim() } : { name: "Authorization", value: typed };
  if (!HEADER_NAME.test(auth.name)) {
    throw new WazapError("INVALID_ID", `The ${label} header has a name no HTTP header can have.`, fix);
  }
  if (RESERVED_HEADERS.has(auth.name.toLowerCase()) || reserved.includes(auth.name.toLowerCase())) {
    throw new WazapError("INVALID_ID", `The ${label} cannot set ${auth.name}: wazap sets it itself.`, fix);
  }
  if (auth.value === "") {
    throw new WazapError("INVALID_ID", `The ${label} names a header but gives it no value.`, fix);
  }
  // A line break would start a header of its own; no printable value needs a control character,
  // and fetch refuses a header value beyond Latin-1 at every request.
  if ([...auth.value].some((char) => (char < " " && char !== "\t") || char === "\u007f" || char > "\u00ff")) {
    throw new WazapError("INVALID_ID", `The ${label} value holds a line break, a control character or one HTTP cannot carry.`, fix);
  }
  return auth;
}
