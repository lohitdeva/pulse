// @ts-expect-error -- Node types are not part of the Supabase function TypeScript environment.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { TimetableBridgePayload } from "../../../shared/timetable/parser";
import { createIngestTimetableHandler } from "./handler";

interface Fixture extends TimetableBridgePayload {
  expected_section_C: unknown[];
}

interface LiveFixture extends TimetableBridgePayload {
  expected_section_C_summary: {
    item_count: number;
    distinct_dates: number;
    by_kind: Record<string, number>;
    duplicate_base_keys: number;
    repeated_base_keys_across_dates: number;
    overlapping_pairs: number;
  };
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../docs/reference/timetable-fixture.json", import.meta.url),
    "utf8",
  ),
) as Fixture;
const liveFixture = JSON.parse(
  readFileSync(
    new URL("../../../docs/reference/timetable-live-fixture.json", import.meta.url),
    "utf8",
  ),
) as LiveFixture;
const secret = "college-sync-secret-0123456789abcdef";
const ownerId = "00000000-0000-4000-8000-000000000001";
const serviceRoleKey = "service-role-key-for-test-only";

function makeRequest(
  body: unknown,
  authorization = `Bearer ${secret}`,
): Request {
  return new Request("https://pulse.example/functions/v1/ingest-timetable", {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function makeHandler(
  fetcher: typeof fetch = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ ok: true })),
  overrides: Record<string, string | undefined> = {},
) {
  const values: Record<string, string | undefined> = {
    COLLEGE_INGEST_TIMETABLE_BEARER_SECRET: secret,
    COLLEGE_TIMETABLE_OWNER_ID: ownerId,
    SUPABASE_URL: "https://pulse-project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    ...overrides,
  };

  return createIngestTimetableHandler({
    readEnv: (name) => values[name],
    fetcher,
  });
}

function fixtureWithHeaderChanges(changes: Record<number, string>) {
  const values = fixture.values.map((row) => [...row]);
  const header = values.find(
    (row) =>
      row[0]?.trim().toLowerCase() === "date" &&
      row[2]?.trim().toLowerCase() === "sections",
  );
  if (!header) throw new Error("Fixture header not found");
  for (const [column, value] of Object.entries(changes)) {
    header[Number(column)] = value;
  }
  return { values, merges: fixture.merges };
}

function summarizeSectionC(items: Array<Record<string, unknown>>) {
  const byKind: Record<string, number> = {};
  const dates = new Set<string>();
  const baseKeyCounts = new Map<string, number>();
  const baseKeyDates = new Map<string, Set<string>>();
  let overlappingPairs = 0;

  for (const item of items) {
    const date = String(item.date);
    const kind = String(item.kind);
    dates.add(date);
    byKind[kind] = (byKind[kind] ?? 0) + 1;

    const normalizedTitle = String(item.title)
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
    const baseKey =
      kind === "class"
        ? `class|${String(item.course).trim().toUpperCase()}|${String(item.session)}`
        : kind === "exam"
          ? `exam|${String(item.course ?? "").trim().toLowerCase()}|${normalizedTitle}`
          : `event|${normalizedTitle}`;
    const dailyBaseKey = `${date}|${baseKey}`;
    baseKeyCounts.set(dailyBaseKey, (baseKeyCounts.get(dailyBaseKey) ?? 0) + 1);
    const keyDates = baseKeyDates.get(baseKey) ?? new Set<string>();
    keyDates.add(date);
    baseKeyDates.set(baseKey, keyDates);
  }

  for (let left = 0; left < items.length; left += 1) {
    const leftItem = items[left]!;
    for (let right = left + 1; right < items.length; right += 1) {
      const rightItem = items[right]!;
      if (
        leftItem.date === rightItem.date &&
        String(leftItem.startsAt) < String(rightItem.endsAt) &&
        String(rightItem.startsAt) < String(leftItem.endsAt)
      ) {
        overlappingPairs += 1;
      }
    }
  }

  return {
    item_count: items.length,
    distinct_dates: dates.size,
    by_kind: byKind,
    duplicate_base_keys: [...baseKeyCounts.values()].reduce(
      (sum, count) => sum + Math.max(0, count - 1),
      0,
    ),
    repeated_base_keys_across_dates: [...baseKeyDates.values()].reduce(
      (sum, keyDates) => sum + Math.max(0, keyDates.size - 1),
      0,
    ),
    overlapping_pairs: overlappingPairs,
  };
}

describe("ingest timetable endpoint", () => {
  it("rejects an unauthorized request before making an RPC call", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await makeHandler(fetcher)(
      makeRequest(fixture, "Bearer wrong-secret"),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed when required server configuration is missing", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await makeHandler(fetcher, {
      COLLEGE_TIMETABLE_OWNER_ID: undefined,
    })(makeRequest(fixture));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Server configuration error",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong payload shape", { values: [], merges: [], userId: ownerId }],
    ["non-string cell", { values: [["Date", "Sections", 42]], merges: [] }],
    ["unreadable layout", { values: [["Day", "Class"]], merges: [] }],
    [
      "unknown section layout",
      {
        values: [
          [
            "Date",
            "Day",
            "Sections",
            "09:30 AM",
            "11:15 AM",
            "Lunch",
            "02:00 PM",
            "03:45 PM",
          ],
          ["28-Sep", "Monday", "X", "", "", "", "", ""],
        ],
        merges: [],
      },
    ],
    [
      "partial slot header drift",
      fixtureWithHeaderChanges({ 6: "02:15 PM 03:45 PM" }),
    ],
    [
      "missing slot end time in a populated grid",
      fixtureWithHeaderChanges({ 3: "09:30 AM" }),
    ],
    [
      "reordered slot headers",
      fixtureWithHeaderChanges({
        3: "11:15 AM 12:45 PM",
        4: "09:30 AM 11:00 AM",
      }),
    ],
    [
      "changed lunch time",
      fixtureWithHeaderChanges({ 5: "LUNCH 12:45 PM - 01:30 PM" }),
    ],
    [
      "missing lunch times in a populated grid",
      fixtureWithHeaderChanges({ 5: "LUNCH" }),
    ],
    [
      "out-of-bounds merge",
      {
        values: [["Date", "Day", "Sections", "09:30"]],
        merges: ["A1:ZZ999999999"],
      },
    ],
    [
      "merge extending more than one trailing column",
      {
        values: [
          [
            "Date",
            "Day",
            "Sections",
            "09:30 AM 11:00 AM",
            "11:15 AM 12:45 PM",
            "LUNCH 12:45 PM - 02:00 PM",
            "02:00 PM 03:30 PM",
            "03:45 PM 05:15 PM",
          ],
        ],
        merges: ["A1:J1"],
      },
    ],
    [
      "non-date marker on a section row",
      {
        values: [
          [
            "Date",
            "Day",
            "Sections",
            "09:30 AM 11:00 AM",
            "11:15 AM 12:45 PM",
            "LUNCH 12:45 PM - 02:00 PM",
            "02:00 PM 03:30 PM",
            "03:45 PM 05:15 PM",
          ],
          ["S.No.", "Monday", "C", "MM-II-1", "", "", "", ""],
        ],
        merges: [],
      },
    ],
  ])("does not reconcile %s", async (_label, body) => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await makeHandler(fetcher)(makeRequest(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid timetable payload",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("parses the fixture and calls the service-only reconciliation RPC for the configured owner", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true }));
    const response = await makeHandler(fetcher)(
      makeRequest({
        values: fixture.values,
        merges: fixture.merges,
        userId: "caller-id",
      }),
    );

    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();

    const validResponse = await makeHandler(fetcher)(
      makeRequest({ values: fixture.values, merges: fixture.merges }),
    );

    expect(validResponse.status).toBe(200);
    expect(await validResponse.json()).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://pulse-project.supabase.co/rest/v1/rpc/reconcile_timetable_snapshot",
    );
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("apikey")).toBe(serviceRoleKey);
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${serviceRoleKey}`,
    );
    const rpcPayload = JSON.parse(String(init?.body)) as Record<
      string,
      unknown
    >;
    expect(rpcPayload.p_user_id).toBe(ownerId);
    expect(rpcPayload.p_raw_payload).toEqual({
      version: 1,
      values: fixture.values,
      merges: fixture.merges,
    });
    expect(rpcPayload.p_parsed_items).toHaveLength(
      fixture.expected_section_C.length,
    );
  });

  it("reconciles the full privacy-safe downloaded grid through the mocked RPC", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true }));
    const response = await makeHandler(fetcher)(
      makeRequest({ values: liveFixture.values, merges: liveFixture.merges }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(1);

    const rpcPayload = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      p_raw_payload: { values: string[][]; merges: string[] };
      p_parsed_items: Array<Record<string, unknown>>;
    };
    expect(rpcPayload.p_raw_payload).toEqual({
      version: 1,
      values: liveFixture.values,
      merges: liveFixture.merges,
    });
    expect(summarizeSectionC(rpcPayload.p_parsed_items)).toEqual(
      liveFixture.expected_section_C_summary,
    );
  });

  it("accepts a readable header-only empty grid and reconciles an empty item list", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true }));
    const response = await makeHandler(fetcher)(
      makeRequest({
        values: [
          [
            "Date",
            "Day",
            "Sections",
            "09:30 AM",
            "11:15 AM",
            "Lunch",
            "02:00 PM",
            "03:45 PM",
          ],
        ],
        merges: [],
      }),
    );

    expect(response.status).toBe(200);
    const rpcPayload = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      p_parsed_items: unknown[];
    };
    expect(rpcPayload.p_parsed_items).toEqual([]);
  });

  it("accepts equivalent punctuation, spacing, and time presentation in fixture headers", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true }));
    const response = await makeHandler(fetcher)(
      makeRequest(
        fixtureWithHeaderChanges({
          3: " 9.30 a.m. / 11:00 AM ",
          4: "11:15AM; 12:45p.m.",
          5: "Lunch — 12.45 pm to 2:00 p.m.",
          6: "2:00PM | 3.30 PM",
          7: "3:45 PM / 5:15 pm",
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries repeated sync payloads through the idempotent RPC and hides RPC errors", async () => {
    let calls = 0;
    const fetcher = vi.fn<typeof fetch>(async () => {
      calls += 1;
      return calls === 1
        ? Response.json({ idempotent: false })
        : Response.json({ idempotent: true });
    });
    const handler = makeHandler(fetcher);
    const body = { values: fixture.values, merges: fixture.merges };

    expect((await handler(makeRequest(body))).status).toBe(200);
    expect((await handler(makeRequest(body))).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(
      fetcher.mock.calls[1]?.[1]?.body,
    );

    const failingFetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("private database detail", { status: 500 }),
      );
    const failed = await makeHandler(failingFetcher)(makeRequest(body));
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "Timetable sync failed" });
  });
});
