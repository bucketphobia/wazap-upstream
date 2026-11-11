import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { WazapError } from "./errors.js";
import { withCode } from "./error-code.js";

const MEDIA_MAX = 100 * 1024 * 1024;

/**
 * The URL guard's fix. It holds in every session: a local one lists file_path
 * among the tool's other ways, a remote one does not, and neither is told it
 * cannot use host files, which is MEDIA_ACCESS_DENIED's other cause.
 */
const URL_DENIED_FIX = "Pass a public http(s) URL without credentials, or the file another way the tool lists (send_message's data_base64, up to 5 MB)";

function denied(message: string): never {
  throw new WazapError("MEDIA_ACCESS_DENIED", message, URL_DENIED_FIX);
}

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const p = address.split(".").map(Number);
    const a = p[0]!,
      b = p[1]!;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    );
  }
  if (isIP(address) === 6) {
    const a = address.toLowerCase();
    return /^2[0-9a-f]{3}:/.test(a) && !a.startsWith("2001:") && !a.startsWith("2002:");
  }
  return false;
}

export interface MediaNetwork {
  resolve: typeof lookup;
  request: typeof httpRequest;
  requestTls: typeof httpsRequest;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  allowHttpsDowngrade: boolean;
}

const network: MediaNetwork = {
  resolve: lookup,
  request: httpRequest,
  requestTls: httpsRequest,
  timeoutMs: 30_000,
  maxBytes: MEDIA_MAX,
  maxRedirects: 5,
  allowHttpsDowngrade: true,
};

function tooLarge(size: number, maxBytes: number): WazapError {
  return new WazapError(
    "FILE_TOO_LARGE",
    `The file is ${Math.round(size / 1_048_576)} MB; the limit is ${Math.round(maxBytes / 1_048_576)} MB.`
  );
}

/** The name a Content-Disposition header gives the file (filename*, then filename), or null. */
export function dispositionFilename(header: string | undefined): string | null {
  if (header === undefined) return null;
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (extended !== null) {
    try {
      return decodeURIComponent(extended[1]!.trim());
    } catch {
      // A malformed escape: the plain filename below, if any.
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/.exec(header);
  const name = (plain?.[1] ?? plain?.[2] ?? "").trim();
  return name === "" ? null : name;
}

/** Dependency injection is only a test seam; callers cannot set it through an MCP tool. */
export async function publicMedia(
  urlText: string,
  io: Partial<MediaNetwork> = {}
): Promise<{ buffer: Buffer; mime: string | null; url: string; filename: string | null }> {
  const net: MediaNetwork = { ...network, ...io };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), net.timeoutMs);
  try {
    let url = new URL(urlText);
    for (let redirects = 0; redirects <= net.maxRedirects; redirects++) {
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        denied("Use a public HTTP(S) URL without credentials.");
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = isIP(host)
        ? [{ address: host, family: isIP(host) }]
        : await Promise.race([
            net.resolve(host, { all: true }),
            new Promise<never>((_, reject) => {
              if (controller.signal.aborted) reject(Error("Media download timed out"));
              else
                controller.signal.addEventListener("abort", () => reject(Error("Media download timed out")), {
                  once: true,
                });
            }),
          ]);
      if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
        denied("Media URL resolves to a non-public address.");
      const chosen = addresses[0]!;
      // Every answer was checked, so the socket must not resolve again: pin the
      // first address and a DNS rebinding between the check and the connect is moot.
      const pinned: LookupFunction = (_hostname, options, callback) => {
        if ("all" in options && options.all) callback(null, [chosen]);
        else callback(null, chosen.address, chosen.family);
      };
      const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
        const req = (url.protocol === "https:" ? net.requestTls : net.request)(
          url,
          {
            signal: controller.signal,
            lookup: pinned,
          },
          resolve
        );
        req.on("error", reject);
        req.end();
      });
      if (!publicAddress(response.socket.remoteAddress ?? "")) {
        response.destroy();
        denied("Connected to a non-public address.");
      }
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
        response.destroy();
        const next = new URL(response.headers.location, url);
        if (!net.allowHttpsDowngrade && url.protocol === "https:" && next.protocol !== "https:") {
          denied("HTTPS downgrade redirects are not allowed.");
        }
        url = next;
        continue;
      }
      if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
        response.destroy();
        throw new WazapError("URL_FETCH_FAILED", `Media server returned HTTP ${response.statusCode}.`);
      }
      const declared = Number(response.headers["content-length"]);
      if (declared > net.maxBytes) {
        response.destroy();
        throw tooLarge(declared, net.maxBytes);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > net.maxBytes) {
          response.destroy();
          throw tooLarge(size, net.maxBytes);
        }
        chunks.push(chunk);
      }
      return {
        buffer: Buffer.concat(chunks),
        mime: response.headers["content-type"]?.split(";")[0] ?? null,
        url: url.href,
        filename: dispositionFilename(response.headers["content-disposition"]),
      };
    }
    throw new WazapError("URL_FETCH_FAILED", `Media URL exceeded ${net.maxRedirects} redirects.`);
  } catch (e) {
    if (e instanceof WazapError) throw e;
    // Resolver/HTTP errors may embed signed URLs, credentials or internal paths.
    throw new WazapError(
      "URL_FETCH_FAILED",
      controller.signal.aborted ? "Media download timed out." : `Media download failed${withCode(e)}.`
    );
  } finally {
    clearTimeout(timer);
  }
}
