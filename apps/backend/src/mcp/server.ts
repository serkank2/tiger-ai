import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AppCtx } from '../context.js';
import { logger } from '../obs/logger.js';
import { buildTools } from './tools.js';

/**
 * Kaplan's MCP (Model Context Protocol) server. Exposes the task/run board to
 * coding agents as MCP tools so an external agent (Claude Code, etc.) can read the
 * queue / Tiger / Team state and perform a small set of SAFE writes (enqueue a
 * prompt, steer a team run). This is the bidirectional-MCP capability that
 * vibe-kanban, agtx, and cli-agent-orchestrator ship.
 *
 * Startup is config-gated and OFF by default (see {@link isMcpEnabled}) so normal
 * backend boots are unchanged; index.ts only needs a one-line conditional start.
 */

const log = logger.child({ mod: 'mcp' });

/** Whether the MCP server should start. Read directly from env to avoid editing config.ts. */
export function isMcpEnabled(): boolean {
  const raw = process.env.KAPLAN_MCP_ENABLED;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

const SERVER_NAME = 'kaplan-board';
const SERVER_VERSION = '0.1.0';

/**
 * Build the MCP server and register every board tool against the given ctx. Does
 * NOT connect a transport — call {@link startMcpServer} for the wired, listening
 * variant, or connect your own transport for tests.
 */
export function createMcpServer(ctx: AppCtx): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'Kaplan board tools: inspect the autonomous prompt queue, the Tiger orchestrator, and the active AI-team run, plus safely enqueue prompts and steer the team run.',
    },
  );

  for (const tool of buildTools()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputShape,
        annotations: { readOnlyHint: tool.readOnly },
      },
      // The SDK validates args against inputShape before invoking this callback.
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.run(ctx, args as never);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn('tool failed', { tool: tool.name, err: message });
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Error: ${message}` }],
          };
        }
      },
    );
  }

  return server;
}

/** Handle returned by {@link startMcpServer} so the host can shut it down cleanly. */
export interface RunningMcpServer {
  server: McpServer;
  close(): Promise<void>;
}

/**
 * Start the MCP server over stdio. Intended for an `mcp-serve`-style invocation
 * where an MCP client launches the backend and speaks JSON-RPC over stdin/stdout.
 * Returns a handle with a clean `close()` for the host's shutdown hook.
 */
export async function startMcpServer(ctx: AppCtx): Promise<RunningMcpServer> {
  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('MCP server started (stdio transport)', { name: SERVER_NAME, version: SERVER_VERSION });
  return {
    server,
    async close() {
      await server.close().catch((err) => log.warn('MCP close failed', { err }));
      log.info('MCP server stopped');
    },
  };
}
