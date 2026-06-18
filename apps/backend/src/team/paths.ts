import path from 'node:path';
import { TigerPaths } from '../orchestrator/paths.js';

/** Directory under the .tiger root that holds every team run. */
export const TEAM_DIR = 'team';

/**
 * Resolve every on-disk path of a single AI-team workspace. A thin wrapper around
 * {@link TigerPaths} that maps `.tiger/team/<runId>/…`:
 *
 *   .tiger/team/<runId>/team.json            — the persisted run record
 *   .tiger/team/<runId>/conversation.jsonl   — the append-only conversation log
 *   .tiger/team/<runId>/.runtime/<turnId>.prompt.md|.output.md|.done — per-turn files
 *
 * Relative paths are produced through {@link TigerPaths.rel}, so they stay
 * forward-slashed and rooted at `.tiger`, matching the rest of the pipeline.
 */
export class TeamPaths {
  readonly tiger: TigerPaths;

  constructor(tiger: TigerPaths) {
    this.tiger = tiger;
  }

  /** Build directly from the workspace directory the user picked. */
  static fromWorkspace(workspace: string): TeamPaths {
    return new TeamPaths(new TigerPaths(workspace));
  }

  /** Directory that holds every team run, `.tiger/team`. */
  get teamsDir(): string {
    return path.join(this.tiger.root, TEAM_DIR);
  }

  /** A single run's directory, `.tiger/team/<runId>`. */
  runDir(runId: string): string {
    return path.join(this.teamsDir, runId);
  }

  /** Persisted run record, `.tiger/team/<runId>/team.json`. */
  teamFile(runId: string): string {
    return path.join(this.runDir(runId), 'team.json');
  }

  /** Append-only conversation log, `.tiger/team/<runId>/conversation.jsonl`. */
  conversationFile(runId: string): string {
    return path.join(this.runDir(runId), 'conversation.jsonl');
  }

  /** Per-turn scratch directory, `.tiger/team/<runId>/.runtime`. */
  runtimeDir(runId: string): string {
    return path.join(this.runDir(runId), '.runtime');
  }

  /** Composed prompt handed to a role for one turn, `<turnId>.prompt.md`. */
  turnPromptFile(runId: string, turnId: string): string {
    return path.join(this.runtimeDir(runId), `${turnId}.prompt.md`);
  }

  /** Deliverable a role writes for one turn, `<turnId>.output.md`. */
  turnOutputFile(runId: string, turnId: string): string {
    return path.join(this.runtimeDir(runId), `${turnId}.output.md`);
  }

  /** Completion marker a role creates when a turn is finished, `<turnId>.done`. */
  turnMarkerFile(runId: string, turnId: string): string {
    return path.join(this.runtimeDir(runId), `${turnId}.done`);
  }

  /** Path relative to the .tiger root (forward-slashed) for display. */
  rel(abs: string): string {
    return this.tiger.rel(abs);
  }
}
