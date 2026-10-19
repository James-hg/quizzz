import { ApiError } from "@/server/http/errors";

export type ExtractErrorCode =
  "unsupported_format" | "too_large" | "zip_bomb" | "timeout" | "corrupt";

/** Base for upload/extraction failures. `message` is safe to show to the user. */
export class ExtractError extends ApiError {
  constructor(
    public readonly extractCode: ExtractErrorCode,
    status: number,
    message: string,
  ) {
    super(status, extractCode, message);
    this.name = "ExtractError";
  }
}

export class UnsupportedFormat extends ExtractError {
  constructor(message = "This file type is not supported. Upload a .docx file.") {
    super("unsupported_format", 415, message);
    this.name = "UnsupportedFormat";
  }
}

export class TooLarge extends ExtractError {
  constructor(maxBytes: number) {
    super(
      "too_large",
      413,
      `This file is too large. The maximum size is ${Math.floor(maxBytes / (1024 * 1024))} MB.`,
    );
    this.name = "TooLarge";
  }
}

export class ZipBomb extends ExtractError {
  constructor(message = "This file expands to an unsafe size and was rejected.") {
    super("zip_bomb", 422, message);
    this.name = "ZipBomb";
  }
}

export class Timeout extends ExtractError {
  constructor(message = "Reading this file took too long and was stopped.") {
    super("timeout", 408, message);
    this.name = "Timeout";
  }
}

export class Corrupt extends ExtractError {
  constructor(message = "This file looks damaged or is not a valid document.") {
    super("corrupt", 422, message);
    this.name = "Corrupt";
  }
}
