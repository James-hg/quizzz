import { ApiError } from "@/server/http/errors";

/** Normalized AI failures. Messages are safe to show to users and never contain keys. */
export class AiUnavailable extends ApiError {
  constructor(message = "AI help is not available right now.") {
    super(503, "ai_unavailable", message);
    this.name = "AiUnavailable";
  }
}

export class AiQuotaExceeded extends ApiError {
  constructor(message = "The AI service quota is used up. Try again later.") {
    super(429, "ai_quota_exceeded", message);
    this.name = "AiQuotaExceeded";
  }
}

export class AiTimeout extends ApiError {
  constructor(message = "The AI service took too long to answer.") {
    super(504, "ai_timeout", message);
    this.name = "AiTimeout";
  }
}

export class AiInvalidOutput extends ApiError {
  constructor(message = "The AI service returned an answer that could not be used.") {
    super(502, "ai_invalid_output", message);
    this.name = "AiInvalidOutput";
  }
}

export class AiRateLimited extends ApiError {
  constructor(message = "You have reached the AI limit. Try again later.", retryAt?: Date) {
    super(
      429,
      "ai_rate_limited",
      message,
      retryAt ? { retryAt: retryAt.toISOString() } : undefined,
    );
    this.name = "AiRateLimited";
  }
}

/** Too many AI operations are running at once across the whole app. */
export class AiBusy extends ApiError {
  constructor(message = "AI help is busy right now. Try again in a moment.") {
    super(429, "ai_busy", message);
    this.name = "AiBusy";
  }
}

/** AI is paused after the provider repeatedly ran out of quota. Practice is unaffected. */
export class AiPaused extends ApiError {
  constructor(retryAt: Date) {
    super(
      503,
      "ai_paused",
      "AI help is paused because the AI service is out of quota. Practice still works. Try again later.",
      { retryAt: retryAt.toISOString() },
    );
    this.name = "AiPaused";
  }
}

/** The request is larger than this server allows to send to the model. */
export class AiInputTooLarge extends ApiError {
  constructor() {
    super(422, "ai_input_too_large", "That request is too long for AI help. Shorten it and retry.");
    this.name = "AiInputTooLarge";
  }
}
