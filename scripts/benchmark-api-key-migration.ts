import { migrateSystemSettingKeysToApiKeyTable } from '../src/lib/llm/api-key-service';
import { prisma } from '../src/lib/db';

async function main() {
  // Setup: make sure some settings exist
  await prisma.systemSetting.createMany({
    data: [
      { key: 'llm_openai_api_key', value: 'sk-1234' },
      { key: 'llm_anthropic_api_key', value: 'sk-ant-1234' },
      { key: 'enable_api_key_migration', value: 'true' }
    ],
    skipDuplicates: true
  });

  // enable migration flag for testing
  process.env.ENABLE_API_KEY_MIGRATION = 'true';

  const start = performance.now();
  await migrateSystemSettingKeysToApiKeyTable();
  const end = performance.now();

  console.log(`Migration took ${end - start} ms`);

  // cleanup
  await prisma.systemSetting.deleteMany({
    where: { key: { in: ['llm_openai_api_key', 'llm_anthropic_api_key', 'enable_api_key_migration'] } }
  });
  await prisma.aPIKey.deleteMany({
    where: { label: 'Primary (migrated)' }
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());
