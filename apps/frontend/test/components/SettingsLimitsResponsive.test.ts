import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

describe('Settings and Limits responsive CSS', () => {
  it('stacks settings rows at the narrow breakpoint without changing desktop columns', () => {
    const settings = source('app/pages/settings.vue');

    expect(settings).toContain('grid-template-columns: 200px 1fr;');
    expect(settings).toContain('@media (max-width: 560px)');
    expect(settings).toMatch(/\.row \{\r?\n\s+grid-template-columns: 1fr;\r?\n\s+gap: 4px;\r?\n\s+\}/);
  });

  it('keeps limits narrow overflow inside responsive sections', () => {
    const limits = source('app/components/limits/LimitsView.vue');

    expect(limits).toContain('grid-template-columns: repeat(4, minmax(0, 1fr));');
    expect(limits).toContain('min-width: 760px;');
    expect(limits).toMatch(/@media \(max-width: 920px\) \{[\s\S]*?\.provider-grid,[\s\S]*?\.gate-panel \{[\s\S]*?grid-template-columns: 1fr;/);
    expect(limits).toMatch(/@media \(max-width: 920px\) \{[\s\S]*?\.rule-row \{[\s\S]*?grid-template-columns: 1fr 1fr;/);
    expect(limits).toMatch(/@media \(max-width: 920px\) \{[\s\S]*?\.history-table \{[\s\S]*?overflow-x: auto;/);
    expect(limits).toMatch(/@media \(max-width: 560px\) \{[\s\S]*?\.rule-row,[\s\S]*?\.snapshot-meta,[\s\S]*?\.gate-meta \{[\s\S]*?grid-template-columns: 1fr;/);
  });
});
