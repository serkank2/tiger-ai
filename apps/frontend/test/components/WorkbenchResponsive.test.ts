import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), 'app/components', relativePath), 'utf8');
}

describe('workbench responsive CSS', () => {
  it('keeps terminal and cue grids shrinkable at narrow widths', () => {
    expect(source('TerminalGrid.vue')).toContain(
      'grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr));',
    );
    expect(source('cue/CueView.vue')).toContain(
      'grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));',
    );
  });

  it('stacks the Runs layout to one column on narrow screens', () => {
    const runView = source('runs/RunView.vue');
    expect(runView).toContain('@media (max-width: 1000px)');
    expect(runView).toMatch(/grid-template-columns: 1fr;/);
  });
});
