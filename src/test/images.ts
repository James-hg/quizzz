/** Smallest byte strings that are recognisably each image type (the content is not rendered). */
const b64 = (value: string) => new Uint8Array(Buffer.from(value, "base64"));

export const PNG_BYTES = b64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
);

export const JPEG_BYTES = b64(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
);

/** "RIFF" + length + "WEBP" + a VP8 chunk header: enough for type detection. */
export const WEBP_BYTES = new Uint8Array([
  ...Buffer.from("RIFF"),
  0x1a,
  0x00,
  0x00,
  0x00,
  ...Buffer.from("WEBP"),
  ...Buffer.from("VP8 "),
  0x0e,
  0x00,
  0x00,
  0x00,
  0x30,
  0x01,
  0x00,
  0x9d,
  0x01,
  0x2a,
  0x01,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
]);

export const GIF_BYTES = new Uint8Array([...Buffer.from("GIF89a"), 1, 0, 1, 0, 0, 0, 0, 0x3b]);

export const SVG_BYTES = new Uint8Array(
  Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
);

export const PDF_BYTES = new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n"));
