import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), 'app/components', relativePath), 'utf8');
}

describe('workbench responsive CSS', () => {
  it('keeps terminal, tiger, and cue grids shrinkable at narrow widths', () => {
    expect(source('TerminalGrid.vue')).toContain(
      'grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr));',
    );
    expect(source('tiger/TigerView.vue')).toContain(
      'grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr));',
    );
    expect(source('cue/CueView.vue')).toContain(
      'grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));',
    );
  });

  it('stacks the Tiger new-project workspace picker on narrow screens', () => {
    const tigerView = source('tiger/TigerView.vue');

    expect(tigerView).toContain('grid-template-columns: minmax(0, 1fr) auto;');
    expect(tigerView).toContain('@media (max-width: 520px)');
    expect(tigerView).toMatch(/\.wsrow \{\r?\n\s+grid-template-columns: 1fr;\r?\n\s+\}/);
  });
});
