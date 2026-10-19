import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { Corrupt, ExtractError, TooLarge, UnsupportedFormat, ZipBomb } from "./errors";
import { DEFAULT_LIMITS, validateUpload } from "./limits";
import { inspectZip, isUnsafeEntryName, readZipEntries } from "./zip";

const small = {
  ...DEFAULT_LIMITS,
  maxZipEntryBytes: 1024 * 1024,
  maxZipTotalBytes: 2 * 1024 * 1024,
};

function docx(extra: Record<string, Uint8Array> = {}) {
  return Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types/>'),
      "word/document.xml": strToU8("<w:document/>"),
      ...extra,
    }),
  );
}

describe("validateUpload", () => {
  it("accepts a ZIP container named .docx", async () => {
    const result = await validateUpload(docx(), { filename: "notes.docx", mimeType: "" }, small);
    expect(result.detectedMime).toMatch(/zip|openxml/);
  });

  it("rejects a .docx that is not a ZIP as corrupt", async () => {
    const fake = Buffer.from("this is plain text, not a zip");
    await expect(
      validateUpload(fake, { filename: "notes.docx", mimeType: "" }, small),
    ).rejects.toBeInstanceOf(Corrupt);
  });

  it("rejects an executable renamed to .docx", async () => {
    const exe = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(200)]);
    await expect(
      validateUpload(exe, { filename: "notes.docx", mimeType: "" }, small),
    ).rejects.toBeInstanceOf(Error);
  });

  it("rejects oversize files", async () => {
    const big = Buffer.alloc(small.maxUploadBytes + 1, 1);
    await expect(
      validateUpload(big, { filename: "a.txt", mimeType: "" }, small),
    ).rejects.toBeInstanceOf(TooLarge);
  });

  it("rejects unknown extensions and binary data posing as text", async () => {
    await expect(
      validateUpload(Buffer.from("x"), { filename: "a.exe", mimeType: "" }, small),
    ).rejects.toBeInstanceOf(UnsupportedFormat);
    await expect(
      validateUpload(Buffer.from([0, 1, 2, 3]), { filename: "a.txt", mimeType: "" }, small),
    ).rejects.toBeInstanceOf(UnsupportedFormat);
  });

  it("accepts plain UTF-8 text and rejects an empty file", async () => {
    await expect(
      validateUpload(Buffer.from("héllo\nworld"), { filename: "a.md", mimeType: "" }, small),
    ).resolves.toMatchObject({ detectedMime: "text/plain" });
    await expect(
      validateUpload(Buffer.alloc(0), { filename: "a.txt", mimeType: "" }, small),
    ).rejects.toBeInstanceOf(Corrupt);
  });

  it("rejects a PDF that is not a PDF", async () => {
    await expect(
      validateUpload(Buffer.from("not a pdf at all"), { filename: "a.pdf", mimeType: "" }, small),
    ).rejects.toBeInstanceOf(Corrupt);
  });
});

describe("isUnsafeEntryName", () => {
  it.each(["../evil.xml", "word/../../evil", "/etc/passwd", "C:/x", "a\\b", ""])(
    "flags %j",
    (name) => expect(isUnsafeEntryName(name)).toBe(true),
  );
  it.each(["word/document.xml", "[Content_Types].xml", "ppt/slides/slide1.xml"])(
    "allows %j",
    (name) => expect(isUnsafeEntryName(name)).toBe(false),
  );
});

describe("inspectZip", () => {
  it("rejects a ZIP bomb from its declared sizes without inflating it", () => {
    const bomb = zipSync({ "word/document.xml": new Uint8Array(8 * 1024 * 1024) }, { level: 9 });
    expect(bomb.length).toBeLessThan(100 * 1024);
    const started = Date.now();
    expect(() => inspectZip(bomb, small)).toThrow(ZipBomb);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("rejects too many entries", () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 20; i++) files[`f${i}.xml`] = strToU8("x");
    expect(() => inspectZip(zipSync(files), { ...small, maxZipEntries: 10 })).toThrow(ZipBomb);
  });

  it("rejects path traversal entries", () => {
    const evil = zipSync({ "../evil.xml": strToU8("x") });
    expect(() => inspectZip(evil, small)).toThrow(ZipBomb);
  });

  it("rejects bytes that are not a ZIP as corrupt", () => {
    expect(() => inspectZip(strToU8("not a zip file at all, just text"), small)).toThrow(Corrupt);
  });

  it("lists entries of a normal document", () => {
    const names = inspectZip(docx(), small).map((e) => e.name);
    expect(names).toContain("word/document.xml");
  });
});

describe("readZipEntries", () => {
  it("reads only the selected entries", () => {
    const entries = readZipEntries(docx(), small, (n) => n === "word/document.xml");
    expect([...entries.keys()]).toEqual(["word/document.xml"]);
    expect(new TextDecoder().decode(entries.get("word/document.xml"))).toBe("<w:document/>");
  });

  it("stops a ZIP that lies about its sizes", () => {
    const zip = Buffer.from(
      zipSync({ "word/document.xml": new Uint8Array(8 * 1024 * 1024) }, { level: 9 }),
    );
    // Patch the declared uncompressed size to 10 bytes in the local and central headers.
    for (let i = 0; i < zip.length - 4; i++) {
      if (zip.readUInt32LE(i) === 0x04034b50) zip.writeUInt32LE(10, i + 22);
      if (zip.readUInt32LE(i) === 0x02014b50) zip.writeUInt32LE(10, i + 24);
    }
    expect(() => readZipEntries(zip, small, () => true)).toThrow(ExtractError);
  });
});
