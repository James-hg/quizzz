import { describe, expect, it } from "vitest";
import { fileProblem, imageChangeOf, imageProblem, initialImageValue } from "./image";

const saved = { id: "i1", url: "/api/images/i1", alt: "A cat" };
const file = (type: string, size = 100) => new File([new Uint8Array(size)], "x", { type });

describe("imageChangeOf", () => {
  it("keeps the image when nothing changed, and does nothing for a question with none", () => {
    expect(imageChangeOf(saved, initialImageValue(saved))).toEqual({ type: "keep" });
    expect(imageChangeOf(null, null)).toEqual({ type: "keep" });
  });

  it("removes a saved image when the field is cleared", () => {
    expect(imageChangeOf(saved, null)).toEqual({ type: "remove" });
  });

  it("sends only the alt text when the description changed", () => {
    expect(imageChangeOf(saved, { kind: "existing", ...saved, alt: "  A black cat " })).toEqual({
      type: "alt",
      imageId: "i1",
      alt: "A black cat",
    });
  });

  it("uploads a newly chosen file with its trimmed alt text", () => {
    const f = file("image/png");
    expect(
      imageChangeOf(saved, { kind: "new", file: f, previewUrl: "blob:x", alt: " Dog " }),
    ).toEqual({
      type: "upload",
      file: f,
      alt: "Dog",
    });
  });
});

describe("imageProblem", () => {
  it("requires a description whenever an image is attached", () => {
    expect(imageProblem(null)).toBeNull();
    expect(imageProblem({ kind: "existing", ...saved })).toBeNull();
    expect(imageProblem({ kind: "existing", ...saved, alt: "   " })).toMatch(/Describe the image/);
    expect(imageProblem({ kind: "existing", ...saved, alt: "x".repeat(301) })).toMatch(/under 300/);
  });
});

describe("fileProblem", () => {
  it("accepts PNG, JPEG and WebP within the limit", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
      expect(fileProblem(file(type), 1000)).toBeNull();
    }
  });

  it("refuses other types and oversized files with a clear message", () => {
    expect(fileProblem(file("image/svg+xml"), 1000)).toBe(
      "Only PNG, JPEG or WebP images are supported.",
    );
    expect(fileProblem(file("image/gif"), 1000)).toMatch(/Only PNG/);
    expect(fileProblem(file("image/png", 3 * 1024 * 1024), 2 * 1024 * 1024)).toBe(
      "This image is too large. The maximum size is 2 MB.",
    );
  });
});
