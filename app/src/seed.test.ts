import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { DEFAULT_FACILITY_HOURS, DEFAULT_TEMPLATES } from "@pulse/shared";
import { seedDefaults } from "./seed";

const userId = "user-1";

type Row = Record<string, unknown>;

/** Small stateful fake of the supabase-js query builder used by seedDefaults. */
function fakeClient(initial: {
  day_templates?: Row[];
  template_blocks?: Row[];
  settings?: Row[];
}) {
  const tables: Record<string, Row[]> = {
    day_templates: [...(initial.day_templates ?? [])],
    template_blocks: [...(initial.template_blocks ?? [])],
    settings: [...(initial.settings ?? [])],
  };
  const log: Array<{ op: string; table: string; payload?: unknown }> = [];
  let seq = 0;

  function query(table: string) {
    let filters: Array<[string, unknown]> = [];
    let pending: (() => Row[]) | null = null;
    const rows = () =>
      tables[table]!.filter((r) => filters.every(([k, v]) => r[k] === v));
    const builder: Record<string, unknown> = {
      select: () => {
        pending ??= rows;
        return builder;
      },
      eq: (k: string, v: unknown) => {
        filters = [...filters, [k, v]];
        return builder;
      },
      limit: () => builder,
      single: async () => {
        const r = (pending ?? rows)();
        return r.length === 1
          ? { data: r[0], error: null }
          : { data: null, error: { message: "not single" } };
      },
      maybeSingle: async () => ({
        data: (pending ?? rows)()[0] ?? null,
        error: null,
      }),
      insert: (payload: Row | Row[]) => {
        log.push({ op: "insert", table, payload });
        for (const r of Array.isArray(payload) ? payload : [payload])
          tables[table]!.push({ id: `${table}-${++seq}`, ...r });
        return Promise.resolve({ data: null, error: null });
      },
      upsert: (payload: Row) => {
        log.push({ op: "upsert", table, payload });
        const exists = tables[table]!.some(
          (r) => r.user_id === payload.user_id && r.key === payload.key,
        );
        if (exists) pending = () => [];
        else {
          const row = { id: `${table}-${++seq}`, ...payload };
          tables[table]!.push(row);
          pending = () => [row];
        }
        return builder;
      },
      update: (payload: Row) => {
        log.push({ op: "update", table, payload });
        const apply = () => {
          for (const r of rows()) Object.assign(r, payload);
          return Promise.resolve({ error: null });
        };
        return {
          eq: (k: string, v: unknown) => ((filters = [[k, v]]), apply()),
        };
      },
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: (pending ?? rows)(), error: null }).then(
          resolve,
        ),
    };
    return builder;
  }

  const client = {
    from: (table: string) => query(table),
  } as unknown as SupabaseClient;
  return { client, tables, log };
}

describe("seedDefaults", () => {
  it("seeds templates, blocks and facility hours on empty state", async () => {
    const { client, tables } = fakeClient({});
    await seedDefaults(client, userId);

    expect(tables.day_templates!.map((t) => t.key)).toEqual([
      "weekday",
      "weekend",
    ]);
    const [weekday, weekend] = tables.day_templates!;
    const blocksFor = (id: unknown) =>
      tables.template_blocks!.filter((b) => b.template_id === id);
    expect(blocksFor(weekday!.id)).toHaveLength(
      DEFAULT_TEMPLATES[0]!.blocks.length,
    );
    expect(blocksFor(weekend!.id)).toHaveLength(
      DEFAULT_TEMPLATES[1]!.blocks.length,
    );
    expect(blocksFor(weekday!.id)[0]).toMatchObject({
      user_id: userId,
      sort_order: 1,
      title: "Wake up",
    });
    expect(tables.settings![0]).toMatchObject({
      user_id: userId,
      data: { facility_hours: DEFAULT_FACILITY_HOURS },
    });
  });

  it("is a no-op when run twice", async () => {
    const { client, tables, log } = fakeClient({});
    await seedDefaults(client, userId);
    const blocks = tables.template_blocks!.length;
    log.length = 0;
    await seedDefaults(client, userId);
    expect(log.filter((l) => l.op === "insert" || l.op === "update")).toEqual(
      [],
    );
    expect(tables.template_blocks).toHaveLength(blocks);
    expect(tables.day_templates).toHaveLength(2);
  });

  it("heals a partial failure: weekday row exists without blocks, weekend missing", async () => {
    const { client, tables } = fakeClient({
      day_templates: [
        { id: "wd", user_id: userId, key: "weekday", name: "Weekday" },
      ],
      settings: [
        { user_id: userId, data: { facility_hours: DEFAULT_FACILITY_HOURS } },
      ],
    });
    await seedDefaults(client, userId);

    expect(tables.day_templates!.map((t) => t.key).sort()).toEqual([
      "weekday",
      "weekend",
    ]);
    expect(
      tables.day_templates!.filter((t) => t.key === "weekday"),
    ).toHaveLength(1);
    const weekend = tables.day_templates!.find((t) => t.key === "weekend")!;
    expect(
      tables.template_blocks!.filter((b) => b.template_id === "wd"),
    ).toHaveLength(20);
    expect(
      tables.template_blocks!.filter((b) => b.template_id === weekend.id),
    ).toHaveLength(20);
  });

  it("does not re-insert blocks for a template that already has them", async () => {
    const { client, tables } = fakeClient({
      day_templates: [
        { id: "wd", user_id: userId, key: "weekday", name: "Weekday" },
      ],
      template_blocks: [{ id: "b1", template_id: "wd", sort_order: 1 }],
    });
    await seedDefaults(client, userId);
    expect(
      tables.template_blocks!.filter((b) => b.template_id === "wd"),
    ).toHaveLength(1);
  });

  it("updates existing settings with facility hours, preserving sibling keys", async () => {
    const { client, tables, log } = fakeClient({
      settings: [{ user_id: userId, data: { theme: "dark" } }],
    });
    await seedDefaults(client, userId);
    expect(tables.settings).toHaveLength(1);
    expect(tables.settings![0]!.data).toEqual({
      theme: "dark",
      facility_hours: DEFAULT_FACILITY_HOURS,
    });
    expect(log.some((l) => l.table === "settings" && l.op === "update")).toBe(
      true,
    );
    expect(log.some((l) => l.table === "settings" && l.op === "upsert")).toBe(
      false,
    );
  });

  it("does not overwrite existing facility hours or sibling keys", async () => {
    const custom = { mess: {}, gym: [] };
    const { client, tables, log } = fakeClient({
      settings: [
        { user_id: userId, data: { theme: "dark", facility_hours: custom } },
      ],
    });
    await seedDefaults(client, userId);
    expect(tables.settings![0]!.data).toEqual({
      theme: "dark",
      facility_hours: custom,
    });
    expect(log.filter((l) => l.table === "settings")).toEqual([]);
  });
});
