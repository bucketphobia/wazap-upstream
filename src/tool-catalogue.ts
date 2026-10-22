/** Advertise current tools only; the SDK still validates hidden compatibility calls. */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDef } from "./tool-runtime.js";

export function publishToolCatalogue(server: McpServer, defs: readonly ToolDef[], allowLocalFiles: boolean): void {
  // Small test doubles only collect handlers; a real MCP server always has this public API.
  if (server.server === undefined) return;
  const tools: Tool[] = defs.filter((def) => !def.legacyRead).map((def) => ({
    name: def.name, title: def.title,
    description: def.description + (allowLocalFiles === false && (def.schema.file_path || def.schema.save_to)
      ? "\nThis remote session cannot use file_path or save_to. Use public HTTP(S) URLs, forward existing messages, or get_media without save_to." : ""),
    inputSchema: toJsonSchemaCompat(z.object(def.schema), { strictUnions: true, pipeStrategy: "input" }) as Tool["inputSchema"],
    ...(def.outputSchema === undefined ? {} : { outputSchema: toJsonSchemaCompat(
      def.outputSchema instanceof z.ZodType ? def.outputSchema : z.object(def.outputSchema),
      { strictUnions: true, pipeStrategy: "output" }) as Tool["outputSchema"] }),
    annotations: def.hints,
  }));
  // Replace only tools/list after registration. tools/call stays SDK-owned: parsing,
  // output validation, permissions and limits also apply to unlisted legacy names.
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
}
