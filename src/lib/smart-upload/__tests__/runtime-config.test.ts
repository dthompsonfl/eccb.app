import { describe, expect, it, vi, beforeEach } from "vitest";
import { loadSmartUploadSettingsSnapshot } from "../runtime-config";
import { prisma } from "@/lib/db";

vi.mock("@/lib/db", () => ({
  prisma: {
    systemSetting: {
      findMany: vi.fn(),
    },
  },
}));

describe("Smart Upload runtime config facade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures SystemSetting as the canonical settings source with a stable hash", async () => {
    vi.mocked(prisma.systemSetting.findMany).mockResolvedValue([
      { key: "smart_upload_ocr_engine", value: "tesseract" },
      { key: "smart_upload_enable_ocr_first", value: "true" },
    ] as never);

    const first = await loadSmartUploadSettingsSnapshot();
    const second = await loadSmartUploadSettingsSnapshot();

    expect(first.source).toBe("SystemSetting");
    expect(first.schema).toBe("smart-upload-runtime-config/v1");
    expect(first.hash).toBe(second.hash);
    expect(first.keys.smart_upload_ocr_engine).toBe("tesseract");
  });
});
