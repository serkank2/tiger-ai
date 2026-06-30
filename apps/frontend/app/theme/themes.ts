import type { ITheme } from '@xterm/xterm';

/**
 * A Kaplan theme = a set of CSS custom-property values (applied to <html>) plus a
 * derived xterm.js color theme. `dark` drives the terminal ANSI palette + color-scheme.
 */
export interface KaplanTheme {
  id: string;
  label: string;
  dark: boolean;
  vars: Record<string, string>;
}

const ANSI_DARK = {
  black: '#3b3b3b',
  red: '#e5564b',
  green: '#6cc56c',
  yellow: '#e0b03a',
  blue: '#5aa9e6',
  magenta: '#c08cd6',
  cyan: '#5bc2b8',
  white: '#cfc7b8',
  brightBlack: '#6f6557',
  brightRed: '#ff6f63',
  brightGreen: '#84d784',
  brightYellow: '#f0c34e',
  brightBlue: '#74bdf5',
  brightMagenta: '#d6a6e8',
  brightCyan: '#74d8cd',
  brightWhite: '#f4efe6',
};

const ANSI_LIGHT = {
  black: '#2a2620',
  red: '#c0392b',
  green: '#2e8b3d',
  yellow: '#9a7d0a',
  blue: '#2f6fb0',
  magenta: '#8e44ad',
  cyan: '#1f8a8a',
  white: '#d8d2c4',
  brightBlack: '#6b6354',
  brightRed: '#d23b35',
  brightGreen: '#3aa856',
  brightYellow: '#b8860b',
  brightBlue: '#3a7fd0',
  brightMagenta: '#9b59b6',
  brightCyan: '#2aa6a6',
  brightWhite: '#3a352c',
};

// id, label, dark, [bg, bgElev, bgElev2, bgTerm, border, borderStrong, text, dim, faint,
//                    accent, accentStrong, accentSoft, green, amber, red, slate, blue]
type Row = [string, string, boolean, string[]];

const ROWS: Row[] = [
  [
    'kaplan-dark',
    'Kaplan Dark',
    true,
    [
      '#131110',
      '#1b1815',
      '#241f1a',
      '#0f0d0a',
      '#322b22',
      '#4a3e30',
      '#ece6db',
      '#a59a89',
      '#6f6557',
      '#f59e42',
      '#fb923c',
      'rgba(245,158,66,0.14)',
      '#6cc56c',
      '#e0b03a',
      '#e5564b',
      '#7c8390',
      '#5aa9e6',
    ],
  ],
  [
    'midnight',
    'Midnight',
    true,
    [
      '#0e1116',
      '#161b22',
      '#1c232c',
      '#0a0d12',
      '#232a33',
      '#38424f',
      '#e6edf3',
      '#9aa7b4',
      '#636e7b',
      '#58a6ff',
      '#79c0ff',
      'rgba(88,166,255,0.14)',
      '#56d364',
      '#e3b341',
      '#f85149',
      '#6e7681',
      '#58a6ff',
    ],
  ],
  [
    'dim',
    'Dim (medium)',
    true,
    [
      '#1c2128',
      '#22272e',
      '#2d333b',
      '#171b21',
      '#373e47',
      '#4a525c',
      '#cdd9e5',
      '#909dab',
      '#697483',
      '#6cb6ff',
      '#96d0ff',
      'rgba(108,182,255,0.14)',
      '#6bc46d',
      '#daaa3f',
      '#e5534b',
      '#768390',
      '#6cb6ff',
    ],
  ],
  [
    'nord',
    'Nord',
    true,
    [
      '#2e3440',
      '#343b49',
      '#3b4252',
      '#272c36',
      '#434c5e',
      '#4c566a',
      '#eceff4',
      '#d8dee9',
      '#7b8494',
      '#88c0d0',
      '#8fbcbb',
      'rgba(136,192,208,0.16)',
      '#a3be8c',
      '#ebcb8b',
      '#bf616a',
      '#6f7787',
      '#81a1c1',
    ],
  ],
  [
    'dracula',
    'Dracula',
    true,
    [
      '#282a36',
      '#2f3240',
      '#383b4a',
      '#21222c',
      '#3a3d4d',
      '#4d5066',
      '#f8f8f2',
      '#c2c5da',
      '#6272a4',
      '#bd93f9',
      '#d6acff',
      'rgba(189,147,249,0.18)',
      '#50fa7b',
      '#f1fa8c',
      '#ff5555',
      '#6272a4',
      '#8be9fd',
    ],
  ],
  [
    'solarized-dark',
    'Solarized Dark',
    true,
    [
      '#002b36',
      '#073642',
      '#0a4250',
      '#00252e',
      '#0f4b58',
      '#2a6471',
      '#cad4d4',
      '#93a1a1',
      '#657b83',
      '#b58900',
      '#cb9a14',
      'rgba(181,137,0,0.18)',
      '#859900',
      '#b58900',
      '#dc322f',
      '#586e75',
      '#268bd2',
    ],
  ],
  [
    'forest',
    'Forest',
    true,
    [
      '#0f1a14',
      '#16241c',
      '#1d2f24',
      '#0a140f',
      '#25382c',
      '#38503f',
      '#e3ece5',
      '#9db3a4',
      '#647568',
      '#5fce8f',
      '#74e0a3',
      'rgba(95,206,143,0.14)',
      '#6cc56c',
      '#d8b34a',
      '#e5564b',
      '#7c8c82',
      '#5aa9c9',
    ],
  ],
  [
    'light',
    'Light',
    false,
    [
      '#f6f7f9',
      '#ffffff',
      '#eef0f3',
      '#ffffff',
      '#e2e5ea',
      '#cfd4dc',
      '#1c2330',
      '#5b6472',
      '#687282',
      '#a95705',
      '#944b04',
      'rgba(217,118,15,0.12)',
      '#2e9e4f',
      '#b07d12',
      '#d23b35',
      '#6b7484',
      '#2f72d6',
    ],
  ],
  [
    'paper',
    'Paper (warm light)',
    false,
    [
      '#f5f1e8',
      '#fffdf7',
      '#ece6d8',
      '#fffdf7',
      '#e0d8c8',
      '#cabfa9',
      '#2a2620',
      '#6b6354',
      '#766d5d',
      '#98510e',
      '#844407',
      'rgba(181,101,29,0.12)',
      '#4f8a3f',
      '#a8780f',
      '#c0392b',
      '#7a7363',
      '#2f6fb0',
    ],
  ],
  [
    'solarized-light',
    'Solarized Light',
    false,
    [
      '#fdf6e3',
      '#fbf3df',
      '#eee8d5',
      '#fdf6e3',
      '#e6dfc8',
      '#d3cbb0',
      '#586e75',
      '#5f747b',
      '#5f747b',
      '#896a00',
      '#7c6000',
      'rgba(181,137,0,0.14)',
      '#7f9400',
      '#896a00',
      '#dc322f',
      '#5f747b',
      '#268bd2',
    ],
  ],
];

const VAR_KEYS = [
  '--bg',
  '--bg-elev',
  '--bg-elev-2',
  '--bg-term',
  '--border',
  '--border-strong',
  '--text',
  '--text-dim',
  '--text-faint',
  '--accent',
  '--accent-strong',
  '--accent-soft',
  '--green',
  '--amber',
  '--red',
  '--slate',
  '--blue',
];

export const THEMES: KaplanTheme[] = ROWS.map(([id, label, dark, values]) => ({
  id,
  label,
  dark,
  vars: Object.fromEntries(VAR_KEYS.map((k, i) => [k, values[i]!])),
}));

export const DEFAULT_THEME_ID = 'kaplan-dark';

export function findTheme(id: string | undefined | null): KaplanTheme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}

/** Derive an xterm.js theme from a Kaplan theme. */
export function xtermTheme(t: KaplanTheme): ITheme {
  return {
    background: t.vars['--bg-term'],
    foreground: t.vars['--text'],
    cursor: t.vars['--accent'],
    cursorAccent: t.vars['--bg-term'],
    selectionBackground: t.dark ? 'rgba(245,200,120,0.28)' : 'rgba(80,60,20,0.18)',
    ...(t.dark ? ANSI_DARK : ANSI_LIGHT),
  };
}

/** Apply a theme's CSS variables + color-scheme to the document root. */
export function applyTheme(t: KaplanTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
  root.dataset.theme = t.id;
  root.style.colorScheme = t.dark ? 'dark' : 'light';
}
