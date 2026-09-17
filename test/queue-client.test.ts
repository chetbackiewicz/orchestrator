import { describe, expect, it, vi } from "vitest";
import {
  HttpIncidentQueueClient,
  QueueClientError,
} from "../src/queue/client.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("HttpIncidentQueueClient", () => {
  it("claims and validates an Emerald incident", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        incident: {
          id: "incident-season",
          idempotencyKey: "ui:season",
          summary: "Incorrect season recommendation",
          payload: {
            trigger: "manual",
            report: "season boundary is wrong",
          },
          status: "processing",
          attemptCount: 2,
          createdAt: "2026-09-16T17:20:00.000Z",
          updatedAt: "2026-09-16T17:20:01.000Z",
        },
        claim: {
          token: "claim-token",
          expiresAt: "2026-09-16T17:22:00.000Z",
        },
      }),
    ) as unknown as typeof fetch;
    const client = new HttpIncidentQueueClient({
      baseUrl: "http://localhost:3000/",
      fetch: fetchImpl,
    });

    await expect(
      client.claim({ workerId: "worker-1", leaseSeconds: 120 }),
    ).resolves.toMatchObject({
      incident: {
        id: "incident-season",
        attemptCount: 2,
        payload: { trigger: "manual" },
      },
      claim: { token: "claim-token" },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:3000/api/incidents/claim",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          workerId: "worker-1",
          leaseSeconds: 120,
        }),
      }),
    );
  });

  it("uses 204 to represent an empty queue", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 204 }),
    ) as unknown as typeof fetch;
    const client = new HttpIncidentQueueClient({
      baseUrl: "http://localhost:3000",
      fetch: fetchImpl,
    });

    await expect(
      client.claim({ workerId: "worker-1", leaseSeconds: 120 }),
    ).resolves.toBeUndefined();
  });

  it("accepts empty successful terminal callback responses", async () => {
    const fetchImpl = (vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(null, { status: 204 }),
      ) as unknown) as typeof fetch;
    const client = new HttpIncidentQueueClient({
      baseUrl: "http://localhost:3000",
      fetch: fetchImpl,
    });

    await expect(
      client.complete("incident-season", {
        workerId: "worker-1",
        claimToken: "token",
        callbackId: "incident-season:1:complete",
        outcome: "resolved",
        result: {
          state: "failed",
          totalTokens: 0,
          requestIds: [],
          events: [],
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      client.fail("incident-season", {
        workerId: "worker-1",
        claimToken: "token",
        callbackId: "incident-season:1:fail",
        retryable: false,
        error: "invalid",
      }),
    ).resolves.toBeUndefined();
  });

  it("renews leases and validates terminal callback responses", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ expiresAt: "2026-09-16T17:23:00.000Z" }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: "resolved" }))
      .mockResolvedValueOnce(
        jsonResponse({
          status: "queued",
          availableAt: "2026-09-16T17:24:00.000Z",
        }),
      ) as unknown as typeof fetch;
    const client = new HttpIncidentQueueClient({
      baseUrl: "http://localhost:3000",
      fetch: fetchImpl,
    });

    await expect(
      client.renewLease("incident/season", {
        workerId: "worker-1",
        claimToken: "token",
        leaseSeconds: 120,
        status: {
          state: "investigating",
          updatedAt: "2026-09-16T17:21:00.000Z",
          totalTokens: 10,
          summary: "investigating",
        },
      }),
    ).resolves.toEqual({
      expiresAt: "2026-09-16T17:23:00.000Z",
    });
    await expect(
      client.complete("incident-season", {
        workerId: "worker-1",
        claimToken: "token",
        callbackId: "incident-season:1:complete",
        outcome: "resolved",
        result: {
          state: "escalated",
          totalTokens: 10,
          requestIds: [],
          events: [],
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      client.fail("incident-season", {
        workerId: "worker-1",
        claimToken: "token",
        callbackId: "incident-season:1:fail",
        retryable: true,
        retryAfterSeconds: 30,
        error: "temporary",
      }),
    ).resolves.toEqual({
      status: "queued",
      availableAt: "2026-09-16T17:24:00.000Z",
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://localhost:3000/api/incidents/incident%2Fseason/lease",
      expect.any(Object),
    );
  });

  it("classifies stale claims and transient response failures", async () => {
    const fetchImpl = (vi
      .fn()
      .mockResolvedValueOnce(new Response("stale", { status: 409 }))
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(
        new Response("{", { status: 200 }),
      ) as unknown) as typeof fetch;
    const client = new HttpIncidentQueueClient({
      baseUrl: "http://localhost:3000",
      fetch: fetchImpl,
    });

    const stale = await client
      .complete("incident-season", {
        workerId: "worker-1",
        claimToken: "token",
        callbackId: "incident-season:1:complete",
        outcome: "resolved",
        result: {
          state: "failed",
          totalTokens: 0,
          requestIds: [],
          events: [],
        },
      })
      .catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(QueueClientError);
    expect(stale).toMatchObject({
      status: 409,
      staleClaim: true,
      retryable: false,
    });

    const transient = await client
      .claim({ workerId: "worker-1", leaseSeconds: 120 })
      .catch((error: unknown) => error);
    expect(transient).toMatchObject({
      status: 503,
      retryable: true,
    });

    const malformed = await client
      .claim({ workerId: "worker-1", leaseSeconds: 120 })
      .catch((error: unknown) => error);
    expect(malformed).toMatchObject({
      retryable: true,
    });
  });
});
