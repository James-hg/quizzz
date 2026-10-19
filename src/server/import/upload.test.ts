import { describe, expect, it } from "vitest";
import { TooLarge } from "@/server/extract/errors";
import { readUpload, sanitizeFilename } from "./upload";

function multipart(file: File) {
  const form = new FormData();
  form.set("file", file);
  return new Request("http://localhost/upload", { method: "POST", body: form });
}

describe("sanitizeFilename", () => {
  it("drops directories and control characters and caps length", () => {
    expect(sanitizeFilename("../../etc/passwd.docx")).toBe("passwd.docx");
    expect(sanitizeFilename("C:\\Users\\me\\notes.docx")).toBe("notes.docx");
    expect(sanitizeFilename("a\u0000b\nc.docx")).toBe("abc.docx");
    expect(sanitizeFilename("")).toBe("upload");
    expect(sanitizeFilename("x".repeat(400)).length).toBe(255);
  });
});

describe("readUpload", () => {
  it("returns the file bytes and a sanitized name", async () => {
    const upload = await readUpload(multipart(new File(["hello"], "dir/notes.docx")), 1000);
    expect(upload.filename).toBe("notes.docx");
    expect(upload.bytes.toString()).toBe("hello");
  });

  it("rejects a body over the cap while streaming", async () => {
    const big = multipart(new File([Buffer.alloc(200_000)], "big.docx"));
    await expect(readUpload(big, 1000)).rejects.toBeInstanceOf(TooLarge);
  });

  it("rejects an oversize Content-Length before reading", async () => {
    const request = new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x", "content-length": "999999999" },
      body: "--x--",
    });
    await expect(readUpload(request, 1000)).rejects.toBeInstanceOf(TooLarge);
  });

  it("rejects non-multipart requests and missing files", async () => {
    const json = new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await expect(readUpload(json, 1000)).rejects.toMatchObject({ status: 400 });
    const form = new FormData();
    form.set("other", "x");
    await expect(
      readUpload(new Request("http://localhost/u", { method: "POST", body: form }), 1000),
    ).rejects.toMatchObject({ status: 400 });
  });
});
