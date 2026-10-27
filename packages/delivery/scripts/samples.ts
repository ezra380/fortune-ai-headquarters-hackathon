// Writes the sample report PDFs in docs/samples from the synthetic fixtures, so a person can open them.
// Usage: npx tsx packages/delivery/scripts/samples.ts
import fs from 'node:fs';
import path from 'node:path';
import { MANAGERS, type ManagedDivision } from '@fahq/contracts';
import { renderWeeklyPacketPdf } from '../src/index.ts';
import { weeklyReport, workerReportsOf } from '../test/report-fixtures.ts';

const out = path.resolve(import.meta.dirname, '../../../docs/samples');
fs.mkdirSync(out, { recursive: true });

for (const division of ['finance', 'online'] as ManagedDivision[]) {
  const { manager, head, title } = MANAGERS[division];
  const pdf = await renderWeeklyPacketPdf(weeklyReport(division), workerReportsOf(division), { manager, head, divisionTitle: title });
  const file = path.join(out, `${division}-weekly-packet.pdf`);
  fs.writeFileSync(file, pdf);
  console.log(`${path.relative(process.cwd(), file)}  ${pdf.length} bytes`);
}
