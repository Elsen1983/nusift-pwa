import { describe, expect, it } from "vitest";
import {
  CHARSET_SNIFF_MAX_BYTES,
  decodeResponseText,
  ResponseBodyTooLargeError,
  UnsupportedResponseCharsetError,
} from "./response-text-decoder";

const response = (bytes: number[], contentType?: string) => new Response(Uint8Array.from(bytes), {
  headers: contentType ? { "content-type": contentType } : undefined,
});

describe("decodeResponseText", () => {
  it("decodes UTF-8 with and without BOM and normalizes to NFC", async () => {
    const plain = new TextEncoder().encode("a\u0301rvíz");
    expect((await decodeResponseText(new Response(plain))).text).toBe("árvíz");
    expect((await decodeResponseText(response([0xef, 0xbb, 0xbf, ...plain]))).charsetSource).toBe("bom");
  });

  it("uses a UTF-16 BOM before a conflicting HTTP charset", async () => {
    const decoded = await decodeResponseText(response([0xff, 0xfe, 0x41, 0x00], "text/xml; charset=utf-8"), { kind: "xml" });
    expect(decoded).toMatchObject({ text: "A", charset: "utf-16le", charsetSource: "bom", declarationConflict: true });
  });

  it("does not let an unsupported lower-priority declaration override a BOM", async () => {
    const decoded = await decodeResponseText(response([0xef, 0xbb, 0xbf, 0x41], "text/html; charset=x-unknown"), { kind: "html" });
    expect(decoded).toMatchObject({ text: "A", charset: "utf-8", charsetSource: "bom", declarationConflict: true });
  });

  it("supports Windows-1252, ISO-8859-1, Windows-1250, and ISO-8859-2", async () => {
    expect((await decodeResponseText(response([0x80], "text/html; charset=windows-1252"))).text).toBe("€");
    expect((await decodeResponseText(response([0xe9], "text/html; charset=iso-8859-1"))).text).toBe("é");
    expect((await decodeResponseText(response([0x8a], "text/html; charset=windows-1250"))).text).toBe("Š");
    expect((await decodeResponseText(response([0xa1], "text/xml; charset=iso-8859-2"))).text).toBe("Ą");
  });

  it("recovers valid UTF-8 Atom content from a false legacy charset declaration", async () => {
    const atom = `<?xml version="1.0" encoding="windows-1252"?><feed><title>Let\u00f6lthet\u0151 v\u00e1ltozat</title></feed>`;
    const decoded = await decodeResponseText(
      new Response(new TextEncoder().encode(atom), {
        headers: { "content-type": "application/atom+xml; charset=windows-1252" },
      }),
      { kind: "xml" },
    );

    expect(decoded).toMatchObject({
      text: atom,
      charset: "utf-8",
      charsetSource: "utf8_recovery",
      declarationConflict: true,
    });
  });

  it("does not override a correctly declared legacy single-byte document", async () => {
    const decoded = await decodeResponseText(response([0x8a], "text/html; charset=windows-1250"));
    expect(decoded).toMatchObject({ charset: "windows-1250", charsetSource: "http" });
  });

  it("prefers HTTP over an early HTML declaration", async () => {
    const bytes = new TextEncoder().encode('<meta charset="windows-1252">hello');
    const decoded = await decodeResponseText(new Response(bytes, { headers: { "content-type": "text/html; charset=utf-8" } }), { kind: "html" });
    expect(decoded).toMatchObject({ charset: "utf-8", charsetSource: "http", declarationConflict: true });
  });

  it("uses bounded XML and HTML declarations", async () => {
    const xml = new TextEncoder().encode('<?xml version="1.0" encoding="iso-8859-2"?><rss/>');
    expect((await decodeResponseText(new Response(xml), { kind: "xml" })).charset).toBe("iso-8859-2");
    const late = new TextEncoder().encode(`${" ".repeat(CHARSET_SNIFF_MAX_BYTES)}<meta charset="windows-1252">`);
    expect((await decodeResponseText(new Response(late), { kind: "html" })).charsetSource).toBe("default");
  });

  it("rejects unsupported labels without guessing", async () => {
    await expect(decodeResponseText(response([65], "text/html; charset=x-user-defined"), { kind: "html" }))
      .rejects.toBeInstanceOf(UnsupportedResponseCharsetError);
  });

  it("reports invalid byte replacement without exposing content", async () => {
    const decoded = await decodeResponseText(response([0xc3, 0x28], "text/plain; charset=utf-8"));
    expect(decoded.hadReplacement).toBe(true);
    expect(JSON.stringify({ ...decoded, text: undefined })).not.toContain("�");
  });

  it("enforces exact body limits and supports explicit truncation", async () => {
    await expect(decodeResponseText(response([1, 2, 3]), { maxBytes: 2 })).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
    expect(await decodeResponseText(response([65, 66, 67]), { maxBytes: 2, overflow: "truncate" }))
      .toMatchObject({ text: "AB", byteLength: 2, truncated: true });
  });
});
