import {
  IncidentRecord,
  IncidentState,
} from "../pipeline/types.js";

export interface QueueIncident {
  id: string;
  idempotencyKey: string;
  summary: string;
  payload: Record<string, unknown>;
  status: "processing";
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface QueueClaim {
  token: string;
  expiresAt: string;
}

export interface ClaimedIncident {
  incident: QueueIncident;
  claim: QueueClaim;
}

export interface IncidentProgress {
  state: IncidentState;
  updatedAt: string;
  totalTokens: number;
  summary: string;
}

export type IncidentCompletionResult = Omit<IncidentRecord, "input">;

export interface ClaimRequest {
  workerId: string;
  leaseSeconds: number;
}

export interface LeaseRequest extends ClaimRequest {
  claimToken: string;
  status: IncidentProgress;
}

export interface CompleteRequest {
  workerId: string;
  claimToken: string;
  callbackId: string;
  outcome: "resolved";
  result: IncidentCompletionResult;
}

export interface FailRequest {
  workerId: string;
  claimToken: string;
  callbackId: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  error: string;
}

export interface LeaseResponse {
  expiresAt: string;
}

export type FailResponse =
  | { status: "queued"; availableAt: string }
  | { status: "failed" };

export interface IncidentQueueClient {
  claim(request: ClaimRequest): Promise<ClaimedIncident | undefined>;
  renewLease(
    incidentId: string,
    request: LeaseRequest,
  ): Promise<LeaseResponse>;
  complete(incidentId: string, request: CompleteRequest): Promise<void>;
  fail(
    incidentId: string,
    request: FailRequest,
  ): Promise<FailResponse | undefined>;
}

export interface HttpIncidentQueueClientOptions {
  baseUrl: string;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
}

export class QueueClientError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly staleClaim: boolean;

  constructor(
    message: string,
    options: {
      status?: number;
      retryable?: boolean;
      staleClaim?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "QueueClientError";
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.staleClaim = options.staleClaim ?? false;
  }
}

export class HttpIncidentQueueClient implements IncidentQueueClient {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpIncidentQueueClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async claim(request: ClaimRequest): Promise<ClaimedIncident | undefined> {
    const response = await this.post("/api/incidents/claim", request);
    if (response.status === 204) return undefined;
    return parseClaimedIncident(await readJson(response));
  }

  async renewLease(
    incidentId: string,
    request: LeaseRequest,
  ): Promise<LeaseResponse> {
    const response = await this.post(
      `/api/incidents/${encodeURIComponent(incidentId)}/lease`,
      request,
    );
    const value = asObject(await readJson(response), "lease response");
    return {
      expiresAt: requiredTimestamp(value, "expiresAt"),
    };
  }

  async complete(
    incidentId: string,
    request: CompleteRequest,
  ): Promise<void> {
    const response = await this.post(
      `/api/incidents/${encodeURIComponent(incidentId)}/complete`,
      request,
    );
    const responseBody = await readOptionalJson(response);
    if (responseBody === undefined) return;
    const value = asObject(responseBody, "completion response");
    requiredEnum(value, "status", ["resolved"]);
  }

  async fail(
    incidentId: string,
    request: FailRequest,
  ): Promise<FailResponse | undefined> {
    const response = await this.post(
      `/api/incidents/${encodeURIComponent(incidentId)}/fail`,
      request,
    );
    const responseBody = await readOptionalJson(response);
    if (responseBody === undefined) return undefined;
    const value = asObject(responseBody, "failure response");
    const status = requiredEnum(value, "status", ["queued", "failed"]);
    if (status === "failed") return { status };
    return {
      status,
      availableAt: requiredTimestamp(value, "availableAt"),
    };
  }

  private async post(path: string, body: object): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      throw new QueueClientError(
        `Incident queue request failed: ${formatError(error)}`,
        { retryable: true },
      );
    }

    if (response.ok) return response;
    const detail = (await response.text()).trim();
    const suffix = detail ? `: ${detail}` : "";
    throw new QueueClientError(
      `Incident queue returned ${response.status}${suffix}`,
      {
        status: response.status,
        retryable:
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500,
        staleClaim: response.status === 409,
      },
    );
  }
}

function parseClaimedIncident(value: unknown): ClaimedIncident {
  const envelope = asObject(value, "claim response");
  const incident = asObject(envelope.incident, "claim response incident");
  const claim = asObject(envelope.claim, "claim response claim");
  return {
    incident: {
      id: requiredString(incident, "id"),
      idempotencyKey: requiredString(incident, "idempotencyKey"),
      summary: requiredString(incident, "summary"),
      payload: asObject(incident.payload, "incident payload"),
      status: requiredEnum(incident, "status", ["processing"]),
      attemptCount: requiredPositiveInteger(incident, "attemptCount"),
      createdAt: requiredTimestamp(incident, "createdAt"),
      updatedAt: requiredTimestamp(incident, "updatedAt"),
    },
    claim: {
      token: requiredString(claim, "token"),
      expiresAt: requiredTimestamp(claim, "expiresAt"),
    },
  };
}

async function readJson(response: Response): Promise<unknown> {
  const value = await readOptionalJson(response);
  if (value === undefined) {
    throw new QueueClientError("Incident queue returned an empty JSON body");
  }
  return value;
}

async function readOptionalJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new QueueClientError(
      `Incident queue returned invalid JSON: ${formatError(error)}`,
      { retryable: true },
    );
  }
}

function asObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new QueueClientError(`Expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
): string {
  const field = value[key];
  if (typeof field !== "string" || !field.trim()) {
    throw new QueueClientError(`Expected non-empty string at ${key}`);
  }
  return field;
}

function requiredPositiveInteger(
  value: Record<string, unknown>,
  key: string,
): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isInteger(field) || field <= 0) {
    throw new QueueClientError(`Expected positive integer at ${key}`);
  }
  return field;
}

function requiredTimestamp(
  value: Record<string, unknown>,
  key: string,
): string {
  const field = requiredString(value, key);
  if (!Number.isFinite(Date.parse(field))) {
    throw new QueueClientError(`Expected RFC 3339 timestamp at ${key}`);
  }
  return field;
}

function requiredEnum<const T extends readonly string[]>(
  value: Record<string, unknown>,
  key: string,
  allowed: T,
): T[number] {
  const field = value[key];
  if (typeof field !== "string" || !allowed.includes(field)) {
    throw new QueueClientError(
      `Expected ${key} to be one of: ${allowed.join(", ")}`,
    );
  }
  return field as T[number];
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
