/**
 * Canonical Smart Upload runtime settings facade.
 *
 * Smart Upload behavior must be loaded through this module, not by reading
 * SystemSetting, SmartUploadSetting, process.env, or provider defaults directly.
 *
 * Storage decision: SystemSetting remains the canonical persistence table for
 * Smart Upload settings in this codebase because the existing admin settings UI,
 * bootstrapper, tests, and config migration paths already use it. The Prisma
 * SmartUploadSetting model is treated as legacy/deprecated until it is removed
 * by a dedicated migration.
 */

import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import {
  buildAdapterConfigForStep,
  loadSmartUploadRuntimeConfig as loadCanonicalSmartUploadRuntimeConfig,
  runtimeToAdapterConfig,
  type LLMRuntimeConfig,
  type LLMStepName,
} from "@/lib/llm/config-loader";
import { SMART_UPLOAD_SETTING_KEYS } from "@/lib/smart-upload/schema";

export type { LLMRuntimeConfig, LLMStepName };
export { buildAdapterConfigForStep, runtimeToAdapterConfig };

export interface SmartUploadSettingsSnapshot {
  source: "SystemSetting";
  schema: "smart-upload-runtime-config/v1";
  keys: Record<string, string>;
  hash: string;
  capturedAt: string;
}

export async function loadSmartUploadRuntimeConfig(): Promise<LLMRuntimeConfig> {
  return loadCanonicalSmartUploadRuntimeConfig();
}

export async function loadSmartUploadSettingsSnapshot(): Promise<SmartUploadSettingsSnapshot> {
  const rows: Array<{ key: string; value: string }> = await prisma.systemSetting.findMany({
    where: { key: { in: [...SMART_UPLOAD_SETTING_KEYS] } },
    select: { key: true, value: true },
    orderBy: { key: "asc" },
  });

  const keys = rows.reduce<Record<string, string>>((acc, row) => {
    acc[row.key] = row.value;
    return acc;
  }, {});

  const canonicalJson = JSON.stringify(keys, Object.keys(keys).sort());
  const hash = createHash("sha256").update(canonicalJson).digest("hex");

  return {
    source: "SystemSetting",
    schema: "smart-upload-runtime-config/v1",
    keys,
    hash,
    capturedAt: new Date().toISOString(),
  };
}

export function buildSmartUploadSettingsSnapshotSummary(
  snapshot: SmartUploadSettingsSnapshot,
) {
  return {
    source: snapshot.source,
    schema: snapshot.schema,
    hash: snapshot.hash,
    capturedAt: snapshot.capturedAt,
    keys: Object.keys(snapshot.keys).sort(),
  };
}
