import { describe, expect, it } from "vitest";
import { GIF_BYTES, JPEG_BYTES, PDF_BYTES, PNG_BYTES, SVG_BYTES, WEBP_BYTES } from "@/test/images";
import { detectImage, formatBytes } from "./validate";

const MAX = 2 * 1024 * 1024;

describe("detectImage", () => {
  it.each([
    ["PNG", PNG_BYTES, "image/png"],
    ["JPEG", JPEG_BYTES, "image/jpeg"],
    ["WebP", WEBP_BYTES, "image/webp"],
  ])("accepts %s by its bytes", async (_name, bytes, mime) => {
    expect(await detectImage(bytes, MAX)).toEqual({ mime });
  });

  it.each([
    ["SVG", SVG_BYTES],
    ["GIF", GIF_BYTES],
    ["PDF", PDF_BYTES],
    ["plain text", new Uint8Array(Buffer.from("not an image at all"))],
  ])("rejects %s with a clear message", async (_name, bytes) => {
    await expect(detectImage(bytes, MAX)).rejects.toMatchObject({
      status: 415,
      code: "unsupported_image",
      message: "Only PNG, JPEG or WebP images are supported.",
    });
  });

  it("rejects an empty file", async () => {
    await expect(detectImage(new Uint8Array(), MAX)).rejects.toMatchObject({
      status: 422,
      code: "empty_image",
    });
  });

  it("rejects an oversized file before looking at its type, and says the limit", async () => {
    await expect(detectImage(PNG_BYTES, PNG_BYTES.length - 1)).rejects.toMatchObject({
      status: 413,
      code: "image_too_large",
    });
    await expect(detectImage(new Uint8Array(3 * 1024 * 1024), MAX)).rejects.toMatchObject({
      message: "This image is too large. The maximum size is 2 MB.",
    });
  });

  it("accepts a file exactly at the limit", async () => {
    await expect(detectImage(PNG_BYTES, PNG_BYTES.length)).resolves.toEqual({ mime: "image/png" });
  });
});

describe("formatBytes", () => {
  it("uses MB for large limits and KB for small ones", () => {
    expect(formatBytes(2 * 1024 * 1024)).toBe("2 MB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatBytes(300 * 1024)).toBe("300 KB");
    expect(formatBytes(10)).toBe("1 KB");
  });
});
