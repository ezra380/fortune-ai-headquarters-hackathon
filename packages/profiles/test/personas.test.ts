import { describe, expect, it } from 'vitest';
import { MANAGERS, WORKER_IDS, workerDivision, type ManagedDivision, type WorkerId } from '@fahq/contracts';
import { loadProfiles } from '../src/index.ts';

// Wave 2 (docs/wave2.md): each department skill opens with its named manager, whom the manager reports to, what the
// daily workers cover and what the weekly report holds. The worker puts the skill first in the system words of every
// brief, worker report and weekly report, so this is who the model is when it writes them.

const profiles = loadProfiles({});
const DIVISIONS = ['finance', 'online', 'salon'] as const satisfies readonly ManagedDivision[];
const section = (text: string, heading: string) => new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(text)?.[1]?.trim() ?? '';

/** The words that name each worker's segment in its manager's Job section. */
const SEGMENT: Record<WorkerId, RegExp> = {
  'finance.email': /\bemail\b/, 'finance.google_ads': /Google Ads/, 'finance.meta': /\bMeta\b/, 'finance.amazon': /Amazon/, 'finance.walmart': /Walmart/,
  'finance.online_money': /the online store's money/, 'finance.salon_money': /the salon's money/,
  'online.messages': /messages/, 'online.journey': /store journey/, 'online.inventory': /stock/, 'online.returns_reviews': /returns and reviews/,
  'online.site_content': /site speed/,
  'salon.clients': /clients and their segments/, 'salon.turnaround': /turnaround/, 'salon.appointments': /appointments/,
};

describe('the managers in the department skills', () => {
  it.each(DIVISIONS)('%s opens with its manager, whom the manager reports to, and serves that head alone', (d) => {
    const { manager, head, title } = MANAGERS[d];
    const job = section(profiles[d].skill, 'Job');
    expect(job.split('\n')[0]).toMatch(new RegExp(`^You are ${manager}, the ${title.toLowerCase()} manager\\. You report to ${head}, `));
    expect(job.split('\n')[0]).toMatch(new RegExp(`you serve ${head} alone\\.`));
  });

  it.each(DIVISIONS)('%s names the segment of every one of its daily workers, and no other division\'s', (d) => {
    const job = section(profiles[d].skill, 'Job');
    const workers = section(profiles[d].skill, 'Job').split('\n').find((l) => l.startsWith('Your daily workers'));
    expect(workers, d).toBeDefined();
    for (const id of WORKER_IDS.filter((w) => workerDivision(w) === d)) expect(workers!, id).toMatch(SEGMENT[id]);
    expect(job).toMatch(/report to you every morning/);
  });

  it.each(DIVISIONS)('%s says what its weekly report holds, who asks whom, and that the head decides by one-time code', (d) => {
    const { head } = MANAGERS[d];
    const weekly = section(profiles[d].skill, 'Your weekly report');
    expect(weekly).toMatch(/^Every Monday you write /);
    expect(weekly).toMatch(/one section per worker, citing only that worker's metric ids/);
    expect(weekly).toMatch(/what you asked the other managers and what they answered/);
    expect(weekly).toMatch(/one plain sentence for the CEO/);
    expect(weekly).toMatch(new RegExp(`${head} approves (a path|an action) by one-time code`));
    if (d === 'finance') {
      expect(weekly).toMatch(/profit goal of the week/);
      expect(weekly).toMatch(/three profit paths/);
    } else {
      expect(weekly).toMatch(/up to three ranked actions/);
      expect(weekly).not.toMatch(/goal/);
    }
  });

  it('puts the weekly report after the daily brief, so the brief rules stay as they were', () => {
    for (const d of DIVISIONS) {
      const headings = [...profiles[d].skill.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
      expect(headings.slice(-2), d).toEqual(['Your brief', 'Your weekly report']);
    }
  });

  it('names the asks between the managers on both sides (docs/wave2.md)', () => {
    const weekly = (d: ManagedDivision) => section(profiles[d].skill, 'Your weekly report');
    expect(weekly('finance')).toMatch(/You ask Cindy \(salon\) for client segments/);
    expect(weekly('finance')).toMatch(/Georgette \(online\) for product performance, returns and their reasons/);
    expect(weekly('online')).toMatch(/You ask George \(finance\) for Amazon and Walmart stock/);
    expect(weekly('online')).toMatch(/Cindy \(salon\) how long repairs and personalization take/);
    expect(weekly('salon')).toMatch(/George \(finance\) asks you for client segments/);
    expect(weekly('salon')).toMatch(/Georgette \(online\) asks you how long repairs and personalization take/);
    for (const d of DIVISIONS) expect(weekly(d), d).toMatch(/answer only from your own tools/i);
  });

  it('gives George the duty to know both businesses\' money and keep it apart', () => {
    const job = section(profiles.finance.skill, 'Job');
    expect(job).toMatch(/You know the salon's money and the online store's money, and you keep them apart/);
    expect(job).toMatch(/never added together and never in one sentence/);
  });

  it('keeps Online and the Salon each to their own business in the persona', () => {
    expect(section(profiles.online.skill, 'Job')).not.toMatch(/salon's money|salon numbers/);
    expect(section(profiles.salon.skill, 'Job')).not.toMatch(/online store's money|online numbers/);
  });
});
