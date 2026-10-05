/**
 * Smart Upload tempFiles bookkeeping — regression coverage for orphaned objects.
 *
 * A SmartUploadSession.tempFiles list is the ONLY way cleanup
 * (cleanupSmartUploadTempFiles) and commit can find a split part object; nothing
 * enumerates the `smart-upload/` storage prefix. If a re-split REPLACES that list
 * instead of accumulating into it, the first-pass objects become unreachable
 * garbage that is never deleted. If a re-split forgets to touch it at all,
 * parsedParts and tempFiles disagree and cleanup deletes the wrong objects.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

import {
  accumulateTempFiles,
  buildSmartUploadPartKey,
  parseSmartUploadJsonArray,
} from '@/lib/smart-upload/persistence';

// ---------------------------------------------------------------------------
// Pure-helper tests
// ---------------------------------------------------------------------------

const FIRST_PASS_KEY = 'smart-upload/s1/parts/American_Patrol_Flute_p0_pg0-1.pdf';
const SECOND_PASS_KEY = 'smart-upload/s1/parts/secondpass/Flute_p1_pg1-1.pdf';

describe('accumulateTempFiles', () => {
  it('retains first-pass keys when second-pass keys are added', () => {
    const result = accumulateTempFiles([FIRST_PASS_KEY], [SECOND_PASS_KEY]);

    expect(result).toContain(FIRST_PASS_KEY);
    expect(result).toContain(SECOND_PASS_KEY);
    expect(result).toHaveLength(2);
  });

  it('does not add duplicate keys twice', () => {
    const result = accumulateTempFiles(
      [FIRST_PASS_KEY, SECOND_PASS_KEY],
      [FIRST_PASS_KEY, SECOND_PASS_KEY],
    );

    expect(result).toEqual([FIRST_PASS_KEY, SECOND_PASS_KEY]);
  });

  it('treats an empty or null existing list as "no keys yet"', () => {
    expect(accumulateTempFiles(null, [SECOND_PASS_KEY])).toEqual([SECOND_PASS_KEY]);
    expect(accumulateTempFiles(undefined, [SECOND_PASS_KEY])).toEqual([SECOND_PASS_KEY]);
    expect(accumulateTempFiles([], [SECOND_PASS_KEY])).toEqual([SECOND_PASS_KEY]);
  });

  it('preserves order: existing keys first, then new keys in arrival order', () => {
    const a = 'smart-upload/s1/parts/a.pdf';
    const b = 'smart-upload/s1/parts/b.pdf';
    const c = 'smart-upload/s1/parts/c.pdf';

    expect(accumulateTempFiles([a, b], [b, c])).toEqual([a, b, c]);
  });

  it('accepts a persisted JSON string for the existing list (LongText column)', () => {
    const result = accumulateTempFiles(JSON.stringify([FIRST_PASS_KEY]), [SECOND_PASS_KEY]);

    expect(result).toEqual([FIRST_PASS_KEY, SECOND_PASS_KEY]);
  });

  it('produces a JSON-stringifiable list (tempFiles is persisted as JSON text)', () => {
    const result = accumulateTempFiles([FIRST_PASS_KEY], [SECOND_PASS_KEY]);

    const serialized = JSON.stringify(result);
    expect(serialized).toBe(`[${JSON.stringify(FIRST_PASS_KEY)},${JSON.stringify(SECOND_PASS_KEY)}]`);
    expect(parseSmartUploadJsonArray<string>(serialized)).toEqual(result);
  });

  it('drops blank and non-string entries rather than persisting junk keys', () => {
    const result = accumulateTempFiles(
      [FIRST_PASS_KEY, '   ', 42, null],
      [SECOND_PASS_KEY, ''],
    );

    expect(result).toEqual([FIRST_PASS_KEY, SECOND_PASS_KEY]);
  });
});

describe('buildSmartUploadPartKey', () => {
  it('builds an unvariant key when no variant is supplied', () => {
    expect(buildSmartUploadPartKey('s1', 'Flute_p1_pg1-1')).toBe(
      'smart-upload/s1/parts/Flute_p1_pg1-1.pdf',
    );
  });

  it('namespaces a variant into its own subdirectory, matching heal/ and resplit/', () => {
    expect(buildSmartUploadPartKey('s1', 'Flute_p1_pg1-1', 'resplit')).toBe(
      'smart-upload/s1/parts/resplit/Flute_p1_pg1-1.pdf',
    );
    expect(buildSmartUploadPartKey('s1', 'Flute_p1_pg1-1', 'heal')).toBe(
      'smart-upload/s1/parts/heal/Flute_p1_pg1-1.pdf',
    );
  });

  it('gives distinct keys to distinct variants of the same session+slug', () => {
    const first = buildSmartUploadPartKey('s1', 'Flute_p1_pg1-1');
    const second = buildSmartUploadPartKey('s1', 'Flute_p1_pg1-1', 'secondpass');
    const resplit = buildSmartUploadPartKey('s1', 'Flute_p1_pg1-1', 'resplit');

    expect(new Set([first, second, resplit]).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Worker-level tests: the split branches must ACCUMULATE tempFiles
// ---------------------------------------------------------------------------

vi.mock('pdf-lib', () => ({
  PDFDocument: {
    load: vi.fn().mockResolvedValue({ getPageCount: () => 3 }),
  },
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    smartUploadSession: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    musicFile: { findFirst: vi.fn().mockResolvedValue(null) },
    musicAssignment: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock('@/lib/services/storage', () => ({
  downloadFile: vi.fn(),
  uploadFile: vi.fn().mockResolvedValue('mock-etag'),
  getSignedDownloadUrl: vi.fn(),
}));

vi.mock('@/lib/llm', () => ({ callVisionModel: vi.fn() }));

vi.mock('@/lib/smart-upload/runtime-config', () => ({
  loadSmartUploadRuntimeConfig: vi.fn(),
  runtimeToAdapterConfig: vi.fn().mockReturnValue({}),
  buildAdapterConfigForStep: vi.fn().mockResolvedValue({
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: 'test-key',
    endpointUrl: 'https://api.openai.com/v1',
    temperature: 0.1,
    maxTokens: 4096,
  }),
  loadSmartUploadSettingsSnapshot: vi.fn().mockResolvedValue({
    source: 'SystemSetting',
    schema: 'smart-upload-runtime-config/v1',
    keys: {},
    hash: 'test-settings-hash',
    capturedAt: '2026-01-01T00:00:00.000Z',
  }),
  buildSmartUploadSettingsSnapshotSummary: vi.fn().mockReturnValue({
    source: 'SystemSetting',
    schema: 'smart-upload-runtime-config/v1',
    hash: 'test-settings-hash',
    capturedAt: '2026-01-01T00:00:00.000Z',
  }),
}));

vi.mock('@/lib/services/pdf-renderer', () => ({
  renderPdfPageBatch: vi.fn().mockResolvedValue(['b64p1', 'b64p2', 'b64p3']),
  renderPdfHeaderCropBatch: vi.fn().mockResolvedValue([]),
  clearRenderCache: vi.fn(),
}));

vi.mock('@/lib/services/pdf-splitter', () => ({
  splitPdfByCuttingInstructions: vi.fn().mockResolvedValue([
    {
      instruction: {
        partName: 'Flute',
        instrument: 'Flute',
        section: 'Woodwinds',
        transposition: 'C',
        partNumber: 1,
        pageRange: [1, 1],
      },
      buffer: Buffer.from('part1'),
      fileName: 'Flute.pdf',
      pageCount: 1,
    },
    {
      instruction: {
        partName: 'Clarinet',
        instrument: 'Clarinet',
        section: 'Woodwinds',
        transposition: 'Bb',
        partNumber: 2,
        pageRange: [2, 3],
      },
      buffer: Buffer.from('part2'),
      fileName: 'Clarinet.pdf',
      pageCount: 2,
    },
  ]),
}));

vi.mock('@/lib/smart-upload/prompts', () => ({
  buildVerificationPrompt: vi.fn().mockReturnValue('verification-prompt'),
  buildAdjudicatorPrompt: vi.fn().mockReturnValue('adjudicator-prompt'),
  DEFAULT_VERIFICATION_SYSTEM_PROMPT: 'default-system',
  DEFAULT_ADJUDICATOR_SYSTEM_PROMPT: 'default-adj-system',
}));

vi.mock('@/lib/jobs/smart-upload', () => ({
  queueSmartUploadSecondPass: vi.fn().mockResolvedValue({ id: 'sp' }),
  queueSmartUploadAutoCommit: vi.fn().mockResolvedValue({ id: 'ac' }),
  SmartUploadJobProgress: {},
  SMART_UPLOAD_JOB_NAMES: {
    PROCESS: 'smartupload.process',
    SECOND_PASS: 'smartupload.secondPass',
    AUTO_COMMIT: 'smartupload.autoCommit',
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { prisma } from '@/lib/db';
import { downloadFile } from '@/lib/services/storage';
import { callVisionModel } from '@/lib/llm';
import { loadSmartUploadRuntimeConfig } from '@/lib/smart-upload/runtime-config';

const { processSecondPass } = await import('@/workers/smart-upload-worker');

const SESSION_ID = 'temp-files-accumulation-session';
const FAKE_PDF = Buffer.from('%PDF-1.4 fake-test-content');

/** First-pass part objects, exactly as the processor would have written them */
const FIRST_PASS_KEYS = [
  'smart-upload/tmp-files-session/parts/American_Patrol_Flute_p0_pg0-0.pdf',
  'smart-upload/tmp-files-session/parts/American_Patrol_Clarinet_p0_pg1-2.pdf',
];

const CUTS = [
  {
    partName: 'Flute',
    instrument: 'Flute',
    section: 'Woodwinds',
    transposition: 'C',
    partNumber: 1,
    pageRange: [1, 1],
  },
  {
    partName: 'Clarinet',
    instrument: 'Clarinet',
    section: 'Woodwinds',
    transposition: 'Bb',
    partNumber: 2,
    pageRange: [2, 3],
  },
];

const EXTRACTION = {
  title: 'American Patrol',
  composer: 'F.W. Meacham',
  confidenceScore: 55,
  fileType: 'FULL_SCORE',
  isMultiPart: true,
  parts: CUTS.map(({ partName, instrument, section, transposition, partNumber }) => ({
    instrument,
    partName,
    section,
    transposition,
    partNumber,
  })),
  cuttingInstructions: CUTS,
};

const VERIFICATION_RESPONSE = JSON.stringify({
  ...EXTRACTION,
  confidenceScore: 92,
  verificationConfidence: 92,
  corrections: null,
});

function makeJob() {
  return {
    id: 'sp-job-temp-files',
    data: { sessionId: SESSION_ID },
    updateProgress: vi.fn().mockResolvedValue(undefined),
  } as never;
}

function makeLlmConfig() {
  return {
    provider: 'openrouter',
    endpointUrl: 'https://openrouter.ai/api/v1',
    visionModel: 'test-vision',
    verificationModel: 'test-verify',
    adjudicatorModel: 'test-adj',
    openaiApiKey: 'test-key',
    anthropicApiKey: 'test-key',
    openrouterApiKey: 'test-key',
    geminiApiKey: 'test-key',
    ollamaCloudApiKey: 'test-key',
    mistralApiKey: 'test-key',
    groqApiKey: 'test-key',
    customApiKey: 'test-key',
    confidenceThreshold: 60,
    twoPassEnabled: true,
    visionSystemPrompt: '',
    verificationSystemPrompt: '',
    headerLabelPrompt: '',
    adjudicatorPrompt: '',
    rateLimit: 10,
    autoApproveThreshold: 95,
    skipParseThreshold: 55,
    maxPages: 200,
    maxFileSizeMb: 100,
    maxConcurrent: 2,
    allowedMimeTypes: ['application/pdf'],
    enableFullyAutonomousMode: false,
    autonomousApprovalThreshold: 90,
    visionModelParams: {},
    verificationModelParams: {},
    promptVersion: '1.0',
    enableOcrFirst: true,
    enforceOcrSplitting: false,
  };
}

/** The tempFiles value the session was finally persisted with. */
function persistedTempFiles(): string[] {
  const calls = vi.mocked(prisma.smartUploadSession.update).mock.calls;
  const final = [...calls]
    .reverse()
    .find((call) => (call[0] as { data?: { tempFiles?: unknown } }).data?.tempFiles !== undefined);
  expect(final, 'expected a session update carrying tempFiles').toBeDefined();
  return parseSmartUploadJsonArray<string>(
    (final as [{ data: { tempFiles: unknown } }])[0].data.tempFiles,
  );
}

describe('second-pass split tempFiles bookkeeping', () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    vi.mocked(prisma.smartUploadSession.update).mockResolvedValue({} as never);

    vi.mocked(downloadFile).mockImplementation(() =>
      Promise.resolve({
        stream: new Readable({
          read() {
            this.push(FAKE_PDF);
            this.push(null);
          },
        }) as unknown as NodeJS.ReadableStream,
        metadata: { contentType: 'application/pdf', size: FAKE_PDF.length },
      }),
    );

    vi.mocked(loadSmartUploadRuntimeConfig).mockResolvedValue(makeLlmConfig() as never);
    vi.mocked(callVisionModel).mockResolvedValue({
      content: VERIFICATION_RESPONSE,
      usage: { promptTokens: 500, completionTokens: 300 },
    });
  });

  it('keeps first-pass temp objects when the session is split for the first time (line-755 branch)', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue({
      uploadSessionId: SESSION_ID,
      storageKey: `smart-upload/${SESSION_ID}/original.pdf`,
      uploadedBy: 'user-1',
      fileName: 'american-patrol.pdf',
      routingDecision: 'auto_parse_second_pass',
      // Already split once by the first pass, yet parseStatus has not been
      // promoted — the exact state in which plain assignment orphans the
      // first-pass objects.
      parseStatus: 'NOT_PARSED',
      secondPassStatus: 'QUEUED',
      extractedMetadata: EXTRACTION,
      parsedParts: null,
      cuttingInstructions: CUTS,
      tempFiles: JSON.stringify(FIRST_PASS_KEYS),
      confidenceScore: 55,
    } as never);

    await processSecondPass(makeJob());

    const persisted = persistedTempFiles();
    for (const key of FIRST_PASS_KEYS) {
      expect(persisted, 'first-pass object was orphaned by tempFiles assignment').toContain(key);
    }
    expect(persisted.length).toBe(FIRST_PASS_KEYS.length + 2);
  });

  it('keeps first-pass temp objects when an already-PARSED session is re-split (line-836 branch)', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue({
      uploadSessionId: SESSION_ID,
      storageKey: `smart-upload/${SESSION_ID}/original.pdf`,
      uploadedBy: 'user-1',
      fileName: 'american-patrol.pdf',
      routingDecision: 'auto_parse_second_pass',
      parseStatus: 'PARSED',
      secondPassStatus: 'QUEUED',
      extractedMetadata: EXTRACTION,
      parsedParts: [
        {
          partName: 'Flute',
          instrument: 'Flute',
          section: 'Woodwinds',
          pageRange: [1, 1],
          storageKey: FIRST_PASS_KEYS[0],
        },
        {
          partName: 'Clarinet',
          instrument: 'Clarinet',
          section: 'Woodwinds',
          pageRange: [2, 3],
          storageKey: FIRST_PASS_KEYS[1],
        },
      ],
      cuttingInstructions: CUTS,
      tempFiles: JSON.stringify(FIRST_PASS_KEYS),
      confidenceScore: 55,
    } as never);

    await processSecondPass(makeJob());

    const persisted = persistedTempFiles();
    for (const key of FIRST_PASS_KEYS) {
      expect(persisted, 're-split orphaned the first-pass objects').toContain(key);
    }
    expect(persisted.length).toBe(FIRST_PASS_KEYS.length + 2);
  });

  it('records tempFiles that cover every storageKey in the new parsedParts', async () => {
    vi.mocked(prisma.smartUploadSession.findUnique).mockResolvedValue({
      uploadSessionId: SESSION_ID,
      storageKey: `smart-upload/${SESSION_ID}/original.pdf`,
      uploadedBy: 'user-1',
      fileName: 'american-patrol.pdf',
      routingDecision: 'auto_parse_second_pass',
      parseStatus: 'NOT_PARSED',
      secondPassStatus: 'QUEUED',
      extractedMetadata: EXTRACTION,
      parsedParts: null,
      cuttingInstructions: CUTS,
      tempFiles: JSON.stringify(FIRST_PASS_KEYS),
      confidenceScore: 55,
    } as never);

    await processSecondPass(makeJob());

    const calls = vi.mocked(prisma.smartUploadSession.update).mock.calls;
    const final = [...calls]
      .reverse()
      .find((call) => (call[0] as { data?: { parsedParts?: unknown } }).data?.parsedParts !== undefined);
    const newParts = parseSmartUploadJsonArray<{ storageKey: string }>(
      (final as [{ data: { parsedParts: unknown } }])[0].data.parsedParts,
    );
    const persisted = persistedTempFiles();

    expect(newParts).toHaveLength(2);
    for (const part of newParts) {
      expect(persisted).toContain(part.storageKey);
    }
  });
});