import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_FACILITY_HOURS, DEFAULT_TEMPLATES } from "@pulse/shared";

/**
 * Seeds the per-user default day templates and facility hours.
 * Idempotent: safe to call on every sign-in. Existing data is never overwritten.
 */
export async function seedDefaults(
  client: SupabaseClient,
  userId: string,
): Promise<void> {
  await seedTemplates(client, userId);
  await seedFacilityHours(client, userId);
}

async function seedTemplates(client: SupabaseClient, userId: string) {
  for (const template of DEFAULT_TEMPLATES) {
    const { data: row, error: templateError } = await client
      .from("day_templates")
      .upsert(
        { user_id: userId, key: template.key, name: template.name },
        { onConflict: "user_id,key", ignoreDuplicates: true },
      )
      .select("id")
      .maybeSingle();
    if (templateError) throw templateError;

    let templateId = (row as { id: string } | null)?.id;
    if (!templateId) {
      // Row already existed (ignoreDuplicates returns nothing): look it up.
      const { data: found, error: findError } = await client
        .from("day_templates")
        .select("id")
        .eq("user_id", userId)
        .eq("key", template.key)
        .single();
      if (findError) throw findError;
      templateId = (found as { id: string }).id;
    }

    const { data: existingBlocks, error: existingError } = await client
      .from("template_blocks")
      .select("id")
      .eq("template_id", templateId)
      .limit(1);
    if (existingError) throw existingError;
    if (existingBlocks && existingBlocks.length > 0) continue;

    const { error: blocksError } = await client.from("template_blocks").insert(
      template.blocks.map((block) => ({
        user_id: userId,
        template_id: templateId,
        sort_order: block.sortOrder,
        start_hhmm: block.startHHMM,
        end_hhmm: block.endHHMM,
        block_type: block.blockType,
        title: block.title,
        note: block.note ?? null,
        meta: block.meta ?? {},
      })),
    );
    if (blocksError) throw blocksError;
  }
}

async function seedFacilityHours(client: SupabaseClient, userId: string) {
  const { data: row, error } = await client
    .from("settings")
    .select("data")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;

  if (!row) {
    const { error: insertError } = await client.from("settings").insert({
      user_id: userId,
      data: { facility_hours: DEFAULT_FACILITY_HOURS },
    });
    if (insertError) throw insertError;
    return;
  }

  const current = (row as { data?: Record<string, unknown> }).data ?? {};
  if (current.facility_hours !== undefined) return;

  const { error: updateError } = await client
    .from("settings")
    .update({ data: { ...current, facility_hours: DEFAULT_FACILITY_HOURS } })
    .eq("user_id", userId);
  if (updateError) throw updateError;
}
