import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { loadMedia, mediaFilename } from "../dist/outgoing-media.js";
import { publicAddress, publicMedia } from "../dist/safe-media.js";
import { toolError } from "../dist/tool-runtime.js";

const PRIVATE_V4 = [
  "0.0.0.0",
  "10.0.0.1",
  "127.0.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "172.31.255.1",
  "192.0.2.1",
  "192.168.1.1",
  "100.64.0.1",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
];

const PRIVATE_V6 = ["::1", "fe80::1", "fd00::1", "2001:db8::1", "2002::1"];
const PUBLIC = ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"];

for (const address of PRIVATE_V4) {
  test(`publicAddress refuses ${address}`, () => {
    assert.equal(publicAddress(address), false);
  });
}
for (const address of PRIVATE_V6) {
  test(`publicAddress refuses ${address}`, () => {
    assert.equal(publicAddress(address), false);
  });
}
for (const address of PUBLIC) {
  test(`publicAddress allows ${address}`, () => {
    assert.equal(publicAddress(address), true);
  });
}
test("publicAddress refuses something that is not an IP at all", () => {
  assert.equal(publicAddress("metadata.google.internal"), false);
});

/** An http(s).request stand-in: records the URL, answers with a Readable shaped like IncomingMessage. */
function fakeHttp({ status = 200, headers = {}, body = "", remote = "93.184.216.34" } = {}) {
  const calls = [];
  const request = (url, _options, cb) => {
    const res = Readable.from(body === "" ? [] : [Buffer.from(body)]);
    res.statusCode = status;
    res.headers = headers;
    res.socket = { remoteAddress: remote };
    calls.push(String(url));
    queueMicrotask(() => cb(res));
    return {
      on() {
        return this;
      },
      end() {},
    };
  };
  return { request, requestTls: request, calls };
}

const resolving = (addresses) => async () => addresses;
const publicDns = resolving([{ address: "93.184.216.34", family: 4 }]);

test("loadMedia refuses the cloud metadata address before any packet leaves", async () => {
  await assert.rejects(loadMedia({ url: "http://169.254.169.254/latest/meta-data/" }), {
    code: "MEDIA_ACCESS_DENIED",
  });
});

test("loadMedia refuses a loopback URL", async () => {
  await assert.rejects(loadMedia({ url: "http://127.0.0.1:8766/healthz" }), { code: "MEDIA_ACCESS_DENIED" });
});

test("loadMedia refuses a non-http(s) scheme", async () => {
  await assert.rejects(loadMedia({ url: "file:///etc/passwd" }), { code: "MEDIA_ACCESS_DENIED" });
});

test("loadMedia refuses a URL with credentials in it", async () => {
  await assert.rejects(loadMedia({ url: "http://user:secret@93.184.216.34/x" }), {
    code: "MEDIA_ACCESS_DENIED",
  });
});

test("a hostname that resolves to a private address is refused (DNS rebinding)", async () => {
  const http = fakeHttp();
  await assert.rejects(
    publicMedia("http://attacker.example/pic.jpg", {
      ...http,
      resolve: resolving([{ address: "10.1.2.3", family: 4 }]),
    }),
    { code: "MEDIA_ACCESS_DENIED" }
  );
  assert.equal(http.calls.length, 0, "nothing was fetched once the answer was private");
});

test("a public URL that redirects to a private one is refused on the second hop", async () => {
  const http = fakeHttp({ status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
  await assert.rejects(publicMedia("http://example.com/redirect", { ...http, resolve: publicDns }), {
    code: "MEDIA_ACCESS_DENIED",
  });
  assert.equal(http.calls.length, 1, "the redirect target is never requested");
});

test("a response that arrives from a private address is refused even when DNS looked clean", async () => {
  const http = fakeHttp({ remote: "10.0.0.1" });
  await assert.rejects(publicMedia("http://example.com/x", { ...http, resolve: publicDns }), {
    code: "MEDIA_ACCESS_DENIED",
  });
});

test("a hostname resolving to a public address fetches and reports the real URL", async () => {
  const http = fakeHttp({ body: "payload", headers: { "content-type": "image/png; charset=binary" } });
  const media = await publicMedia("http://example.com/pic", { ...http, resolve: publicDns });
  assert.equal(media.buffer.toString(), "payload");
  assert.equal(media.mime, "image/png");
  assert.equal(media.url, "http://example.com/pic");
});

test("a redirect to another public URL is followed and the final URL is reported", async () => {
  const first = fakeHttp({ status: 302, headers: { location: "https://cdn.example/final.jpg" } });
  const second = fakeHttp({ body: "img" });
  let hop = 0;
  const request = (url, options, cb) => (hop++ === 0 ? first : second).request(url, options, cb);
  const media = await publicMedia("http://example.com/start", {
    request,
    requestTls: request,
    resolve: publicDns,
  });
  assert.equal(media.buffer.toString(), "img");
  assert.equal(media.url, "https://cdn.example/final.jpg");
});

test("untrusted MIME subtypes never become filename path separators", () => {
  for (const mime of ["image/..\\..\\private", "image/../../private", "image/" + "x".repeat(1000)]) {
    const filename = mediaFilename({ mime });
    assert.ok(!/[\\/\\\\]/.test(filename));
    assert.ok(filename.length < 100);
  }
});

for (const url of [
  "http://2130706433/x",
  "http://0x7f000001/x",
  "http://[::ffff:127.0.0.1]/x",
  "http://[::ffff:7f00:1]/x",
]) {
  test(`alternate loopback representation is blocked: ${url}`, async () => {
    const http = fakeHttp();
    await assert.rejects(publicMedia(url, http), { code: "MEDIA_ACCESS_DENIED" });
    assert.equal(http.calls.length, 0);
  });
}

test("mixed public/private DNS answers are refused before connecting", async () => {
  const http = fakeHttp();
  await assert.rejects(
    publicMedia("https://example.com/pic", {
      ...http,
      resolve: resolving([
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ]),
    }),
    { code: "MEDIA_ACCESS_DENIED" }
  );
  assert.equal(http.calls.length, 0);
});

test("the socket lookup is pinned to the validated DNS answer", async () => {
  const http = fakeHttp({ body: "test" });
  let resolved = 0;
  let pinned = false;
  await publicMedia("https://example.com/pic", {
    resolve: async () => {
      resolved++;
      return [{ address: "93.184.216.34", family: 4 }];
    },
    requestTls: (url, options, callback) => {
      options.lookup("example.com", {}, (err, address, family) => {
        assert.equal(err, null);
        assert.equal(address, "93.184.216.34");
        assert.equal(family, 4);
        pinned = true;
      });
      options.lookup("example.com", { all: true }, (err, addresses) => {
        assert.equal(err, null);
        assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
      });
      return http.requestTls(url, options, callback);
    },
  });
  assert.equal(resolved, 1);
  assert.equal(pinned, true);
});

test("chunked bodies cannot bypass the size cap", async () => {
  const http = fakeHttp({ body: "12345" });
  await assert.rejects(publicMedia("https://example.com/pic", { ...http, resolve: publicDns, maxBytes: 4 }), {
    code: "FILE_TOO_LARGE",
  });
});

test("media errors never echo signed URL paths/queries or resolver details", async () => {
  const http = fakeHttp({ status: 403 });
  await assert.rejects(
    publicMedia("https://example.com/PATH_SECRET?token=QUERY_SECRET", { ...http, resolve: publicDns }),
    (err) => {
      assert.equal(err.code, "URL_FETCH_FAILED");
      assert.match(err.message, /HTTP 403/);
      assert.doesNotMatch(err.message, /SECRET/);
      return true;
    }
  );
  await assert.rejects(
    publicMedia("https://example.com/pic", {
      resolve: async () => {
        throw Error("RESOLVER_SECRET");
      },
    }),
    (err) => {
      assert.equal(err.code, "URL_FETCH_FAILED");
      assert.doesNotMatch(err.message, /SECRET/);
      return true;
    }
  );
});

test("a URL refused or not fetched says what to do in any session: never file_path, never that host files are off", async () => {
  const fixes = [];
  const collect = (promise, code) =>
    assert.rejects(promise, (err) => {
      assert.equal(err.code, code);
      fixes.push([`${code}: ${err.message}`, toolError(err).structuredContent.fix]);
      return true;
    });
  // The guard: a local dev server, credentials in the URL, a non-public answer, an HTTPS downgrade.
  await collect(publicMedia("http://127.0.0.1:9/chart.png"), "MEDIA_ACCESS_DENIED");
  await collect(publicMedia("https://user:secret@example.com/a.jpg"), "MEDIA_ACCESS_DENIED");
  await collect(publicMedia("https://example.com/a.jpg", { ...fakeHttp({ remote: "10.0.0.5" }), resolve: publicDns }), "MEDIA_ACCESS_DENIED");
  await collect(
    publicMedia("https://example.com/a.jpg", {
      ...fakeHttp({ status: 302, headers: { location: "http://example.com/a.jpg" } }),
      resolve: publicDns,
      allowHttpsDowngrade: false,
    }),
    "MEDIA_ACCESS_DENIED"
  );
  // The fetch: a 404, a name that does not resolve, a redirect loop.
  await collect(publicMedia("https://example.com/missing.jpg", { ...fakeHttp({ status: 404 }), resolve: publicDns }), "URL_FETCH_FAILED");
  await collect(
    publicMedia("https://nonexistent-host.invalid/poza.jpg", {
      resolve: async () => {
        throw Object.assign(Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
      },
    }),
    "URL_FETCH_FAILED"
  );
  await collect(
    publicMedia("https://example.com/loop", {
      ...fakeHttp({ status: 302, headers: { location: "/loop" } }),
      resolve: publicDns,
      maxRedirects: 1,
    }),
    "URL_FETCH_FAILED"
  );
  assert.equal(fixes.length, 7);
  for (const [what, fix] of fixes) {
    // A remote session is never shown file_path, and a local one may use host files.
    assert.doesNotMatch(fix, /file_path|host files|route around/, what);
    assert.match(fix, /another way the tool lists \(send_message's data_base64, up to 5 MB\)/, what);
  }
});

test("a media source given no way or two ways says to give it one of those the tool lists", async () => {
  for (const source of [{}, { url: "https://example.com/a.jpg", file_path: "/tmp/a.jpg" }]) {
    await assert.rejects(loadMedia(source), (err) => {
      assert.equal(err.code, "FILE_NOT_FOUND");
      // Not FILE_NOT_FOUND's "check the path": there may be no path, and a remote session has none to give.
      assert.equal(toolError(err).structuredContent.fix, "Give the file exactly one way, of those the tool lists");
      return true;
    });
  }
});

test("a content-length over the cap fails before the body is read", async () => {
  const http = fakeHttp({ headers: { "content-length": String(200 * 1024 * 1024) } });
  await assert.rejects(publicMedia("http://example.com/big", { ...http, resolve: publicDns }), {
    code: "FILE_TOO_LARGE",
  });
});
