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
  constructor(message = "You have reached the hourly AI limit. Try again later.") {
    super(429, "ai_rate_limited", message);
    this.name = "AiRateLimited";
  }
}
