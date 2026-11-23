import "reflect-metadata";
import { DatabaseService } from "../apps/api/src/database.service";
import { BackupService } from "../apps/api/src/backups";
async function main() {
  const db = new DatabaseService();
  const backups = new BackupService(db);
  try {
    await backups.onModuleInit();
    await backups.run(true);
    console.log(
      "Encrypted local backup completed. Drive upload runs when Google Drive is connected.",
    );
  } finally {
    backups.onModuleDestroy();
    await db.$disconnect();
  }
}
main().catch(() => {
  console.error(
    "Backup failed; check PostgreSQL tools, backup configuration and available disk space.",
  );
  process.exitCode = 1;
});
