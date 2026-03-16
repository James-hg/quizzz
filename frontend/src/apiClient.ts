const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

export const TOKEN_STORAGE_KEY = "quizzz_access_token";

export class ApiError extends Error {
    status: number;
    body: unknown;

    constructor(message: string, status: number, body: unknown) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.body = body;
    }
}

export class UnauthorizedError extends ApiError {
    constructor(message: string, body: unknown) {
        super(message, 401, body);
        this.name = "UnauthorizedError";
    }
}

type ApiRequestOptions = RequestInit & {
    token?: string | null;
};

export async function apiRequest<T = any>(
    path: string,
    options: ApiRequestOptions = {},
): Promise<T> {
    const { token, headers, body, ...rest } = options;

    const requestHeaders = new Headers(headers ?? {});
    if (token) {
        requestHeaders.set("Authorization", `Bearer ${token}`);
    }

    const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
    if (body && !isFormData && !requestHeaders.has("Content-Type")) {
        requestHeaders.set("Content-Type", "application/json");
    }

    const response = await fetch(`${API_BASE}${path}`, {
        ...rest,
        headers: requestHeaders,
        body,
    });

    const text = await response.text();
    const payload = text ? safeJson(text) : null;

    if (!response.ok) {
        const detail =
            payload && typeof payload === "object" && payload !== null
                ? (payload as { detail?: string }).detail
                : null;
        const message = detail || `Request failed with status ${response.status}`;
        if (response.status === 401) {
            throw new UnauthorizedError(message, payload);
        }
        throw new ApiError(message, response.status, payload);
    }

    return payload as T;
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}
