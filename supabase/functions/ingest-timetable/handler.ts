import {
  parseSectionCTimetable,
  type TimetableBridgePayload,
} from "../../../shared/timetable/parser.ts";

const MAX_BODY_BYTES = 1_000_000;
const MAX_ROWS = 500;
const MAX_COLUMNS = 40;
const MAX_CELLS = 20_000;
const MAX_CELL_CHARACTERS = 2_000;
const MAX_MERGES = 1_000;
const MAX_MERGE_AREA = 2_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEXT_ENCODER = new TextEncoder();
const EXPECTED_SLOT_HEADER_TIMES: Readonly<Record<number, readonly number[]>> =
  {
    3: [9 * 60 + 30, 11 * 60],
    4: [11 * 60 + 15, 12 * 60 + 45],
    6: [14 * 60, 15 * 60 + 30],
    7: [15 * 60 + 45, 17 * 60 + 15],
  };
const EXPECTED_LUNCH_TIMES = [12 * 60 + 45, 14 * 60];

interface IngestTimetableDependencies {
  readEnv: (name: string) => string | undefined;
  fetcher?: typeof fetch;
}

interface IngestConfig {
  bearerSecret: string;
  ownerId: string;
  supabaseUrl: URL;
  serviceRoleKey: string;
}

interface CellRange {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}

class InvalidPayloadError extends Error {}

function json(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function readConfig(
  readEnv: IngestTimetableDependencies["readEnv"],
): IngestConfig | undefined {
  try {
    const bearerSecret = readEnv("COLLEGE_INGEST_TIMETABLE_BEARER_SECRET");
    const ownerId = readEnv("COLLEGE_TIMETABLE_OWNER_ID");
    const supabaseUrlValue = readEnv("SUPABASE_URL");
    const serviceRoleKey = readEnv("SUPABASE_SERVICE_ROLE_KEY");
    if (
      !bearerSecret ||
      bearerSecret.length < 32 ||
      bearerSecret.length > 256 ||
      !ownerId ||
      !UUID_PATTERN.test(ownerId) ||
      !supabaseUrlValue ||
      !serviceRoleKey
    ) {
      return undefined;
    }

    const supabaseUrl = new URL(supabaseUrlValue);
    const isLocalHttp =
      supabaseUrl.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(supabaseUrl.hostname);
    if (
      (supabaseUrl.protocol !== "https:" && !isLocalHttp) ||
      supabaseUrl.username ||
      supabaseUrl.password ||
      supabaseUrl.search ||
      supabaseUrl.hash
    ) {
      return undefined;
    }

    return { bearerSecret, ownerId, supabaseUrl, serviceRoleKey };
  } catch {
    return undefined;
  }
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = TEXT_ENCODER.encode(left);
  const rightBytes = TEXT_ENCODER.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function authorized(request: Request, secret: string): boolean {
  const match = /^Bearer ([^\s]{32,256})$/i.exec(
    request.headers.get("Authorization") ?? "",
  );
  return match !== null && constantTimeEquals(match[1]!, secret);
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    if (
      !/^\d+$/.test(contentLength) ||
      Number(contentLength) > MAX_BODY_BYTES
    ) {
      throw new InvalidPayloadError();
    }
  }

  const reader = request.body?.getReader();
  if (!reader) throw new InvalidPayloadError();

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new InvalidPayloadError();
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch (error) {
    if (error instanceof InvalidPayloadError) throw error;
    throw new InvalidPayloadError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function columnIndex(letters: string): number {
  let column = 0;
  for (const letter of letters.toUpperCase()) {
    column = column * 26 + letter.charCodeAt(0) - 64;
  }
  return column - 1;
}

function parseMerge(
  value: string,
  rowCount: number,
  columnCount: number,
): CellRange {
  if (value.length > 24) throw new InvalidPayloadError();
  const match =
    /^\$?([A-Z]{1,2})\$?([1-9]\d*)(?::\$?([A-Z]{1,2})\$?([1-9]\d*))?$/i.exec(
      value,
    );
  if (!match) throw new InvalidPayloadError();

  const startColumn = columnIndex(match[1]!);
  const startRow = Number(match[2]) - 1;
  const endColumn = columnIndex(match[3] ?? match[1]!);
  const endRow = Number(match[4] ?? match[2]) - 1;
  if (
    !Number.isSafeInteger(startRow) ||
    !Number.isSafeInteger(endRow) ||
    startRow < 0 ||
    endRow < startRow ||
    endRow >= rowCount ||
    startColumn < 0 ||
    endColumn < startColumn ||
    endColumn >= columnCount ||
    (endRow - startRow + 1) * (endColumn - startColumn + 1) > MAX_MERGE_AREA
  ) {
    throw new InvalidPayloadError();
  }

  return { startRow, endRow, startColumn, endColumn };
}

function parseHeaderTimes(value: string): number[] | undefined {
  const times: number[] = [];
  const pattern =
    /\b(\d{1,2})(?:\s*[:.]\s*(\d{2}))?(?:\s*([ap])\.?\s*m\.?)?(?=$|[^a-z0-9])/gi;

  for (const match of value.matchAll(pattern)) {
    const hour = Number(match[1]);
    const minute = match[2] === undefined ? 0 : Number(match[2]);
    const meridiem = match[3]?.toLowerCase();
    if (minute > 59) return undefined;

    if (meridiem) {
      if (hour < 1 || hour > 12) return undefined;
      times.push((hour % 12) * 60 + minute + (meridiem === "p" ? 12 * 60 : 0));
    } else {
      if (hour > 23) return undefined;
      times.push(hour * 60 + minute);
    }
  }

  return times;
}

function hasExpectedSlotHeader(
  value: string,
  expected: readonly number[],
  allowStartOnly: boolean,
): boolean {
  const times = parseHeaderTimes(value);
  return (
    times !== undefined &&
    ((allowStartOnly && times.length === 1 && times[0] === expected[0]) ||
      (times.length === 2 &&
        times[0] === expected[0] &&
        times[1] === expected[1]))
  );
}

function hasExpectedLunchHeader(value: string, allowNoTimes: boolean): boolean {
  if (!/\blunch\b/i.test(value)) return false;
  const times = parseHeaderTimes(value);
  return (
    times !== undefined &&
    ((allowNoTimes && times.length === 0) ||
      (times.length === 2 &&
        times[0] === EXPECTED_LUNCH_TIMES[0] &&
        times[1] === EXPECTED_LUNCH_TIMES[1]))
  );
}

function validatePayload(value: unknown): TimetableBridgePayload {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    !("values" in value) ||
    !("merges" in value)
  ) {
    throw new InvalidPayloadError();
  }

  const rawValues = value.values;
  const rawMerges = value.merges;
  if (
    !Array.isArray(rawValues) ||
    rawValues.length < 1 ||
    rawValues.length > MAX_ROWS ||
    !Array.isArray(rawMerges) ||
    rawMerges.length > MAX_MERGES ||
    !Array.isArray(rawValues[0])
  ) {
    throw new InvalidPayloadError();
  }

  const values = rawValues as unknown[][];
  const merges = rawMerges as unknown[];
  const columnCount = values[0]!.length;
  if (
    columnCount < 8 ||
    columnCount > MAX_COLUMNS ||
    values.length * columnCount > MAX_CELLS
  ) {
    throw new InvalidPayloadError();
  }
  for (const row of values) {
    if (!Array.isArray(row) || row.length !== columnCount)
      throw new InvalidPayloadError();
    for (const cell of row) {
      if (typeof cell !== "string" || cell.length > MAX_CELL_CHARACTERS) {
        throw new InvalidPayloadError();
      }
    }
  }

  for (const merge of merges) {
    if (typeof merge !== "string") throw new InvalidPayloadError();
    parseMerge(merge, values.length, columnCount);
  }

  const headerRows = values.filter((row) => {
    const headers = row.map((cell) => (cell as string).trim().toLowerCase());
    return headers.includes("date") && headers.includes("sections");
  });
  if (headerRows.length !== 1) throw new InvalidPayloadError();
  const header = headerRows[0]!;
  const dateColumns = header.filter(
    (cell) => (cell as string).trim().toLowerCase() === "date",
  ).length;
  const sectionColumns = header.filter(
    (cell) => (cell as string).trim().toLowerCase() === "sections",
  ).length;
  const headerIndex = values.indexOf(header);
  const slotColumns = Object.keys(EXPECTED_SLOT_HEADER_TIMES).map(Number);
  const allowStartOnly = values
    .slice(headerIndex + 1)
    .every((row) =>
      slotColumns.every((column) => !(row[column] as string).trim()),
    );
  if (
    dateColumns !== 1 ||
    sectionColumns !== 1 ||
    Object.entries(EXPECTED_SLOT_HEADER_TIMES).some(
      ([column, expected]) =>
        !hasExpectedSlotHeader(
          header[Number(column)] as string,
          expected,
          allowStartOnly,
        ),
    ) ||
    !hasExpectedLunchHeader(header[5] as string, allowStartOnly)
  ) {
    throw new InvalidPayloadError();
  }

  const sectionColumn = header.findIndex(
    (cell) => (cell as string).trim().toLowerCase() === "sections",
  );
  for (const row of values.slice(headerIndex + 1)) {
    const section = (row[sectionColumn] as string).trim().toUpperCase();
    if (section && !/^(?:SECTION\s+)?[A-D]$/.test(section))
      throw new InvalidPayloadError();
  }

  return { values: values as string[][], merges: merges as string[] };
}

function rpcUrl(baseUrl: URL): URL {
  const base = new URL(baseUrl.href);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/rest/v1/rpc/reconcile_timetable_snapshot`;
  return base;
}

export function createIngestTimetableHandler({
  readEnv,
  fetcher = fetch,
}: IngestTimetableDependencies): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "POST")
      return json({ error: "Method not allowed" }, 405);

    const config = readConfig(readEnv);
    if (!config) return json({ error: "Server configuration error" }, 500);
    if (!authorized(request, config.bearerSecret)) {
      return json({ error: "Authentication required" }, 401);
    }

    const contentType = request.headers
      .get("Content-Type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      return json({ error: "Invalid timetable payload" }, 400);
    }

    let payload: TimetableBridgePayload;
    let parsedItems;
    try {
      payload = validatePayload(await readJsonBody(request));
      parsedItems = parseSectionCTimetable(payload);
    } catch {
      return json({ error: "Invalid timetable payload" }, 400);
    }

    const rawPayload = {
      version: 1,
      values: payload.values,
      merges: payload.merges,
    };
    try {
      const response = await fetcher(rpcUrl(config.supabaseUrl), {
        method: "POST",
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: `Bearer ${config.serviceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          p_user_id: config.ownerId,
          p_raw_payload: rawPayload,
          p_parsed_items: parsedItems,
        }),
        redirect: "error",
      });
      if (!response.ok) return json({ error: "Timetable sync failed" }, 502);
    } catch {
      return json({ error: "Timetable sync failed" }, 502);
    }

    return json({ ok: true }, 200);
  };
}
