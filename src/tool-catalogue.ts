/** Advertise current tools only; the SDK still validates hidden compatibility calls. */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AnswerFormat } from "./client-name.js";
import type { ToolDef } from "./tool-runtime.js";

/**
 * Arguments that name a file on wazap's machine. A remote session is refused
 * them (MEDIA_ACCESS_DENIED), so its catalogue does not advertise them at all:
 * the zod shape keeps them, so a call that passes one anyway still gets that
 * refusal and its fix rather than an unknown-argument error.
 */
export const HOST_FILE_ARGS: readonly string[] = ["file_path", "save_to"];

type JsonSchema = Record<string, unknown> & { properties?: Record<string, unknown>; required?: string[] };

/**
 * One tool's JSON Schema as a client is shown it: no `$schema` (every client
 * knows the dialect; it was 53 bytes on each of 23 tools), and in a remote
 * session no argument it may not pass.
 */
function advertised(schema: JsonSchema, allowLocalFiles: boolean): JsonSchema {
  const { $schema: _dialect, ...rest } = schema;
  if (allowLocalFiles || rest.properties === undefined) return rest;
  const hidden = HOST_FILE_ARGS.filter((name) => name in rest.properties!);
  if (hidden.length === 0) return rest;
  const properties = { ...rest.properties };
  for (const name of hidden) delete properties[name];
  // A property the others point to (a shared instance becomes a $ref) stays rather than dangle.
  const kept = JSON.stringify(properties);
  for (const name of hidden) if (kept.includes(`#/properties/${name}`)) properties[name] = rest.properties[name];
  const required = rest.required?.filter((name) => name in properties);
  return { ...rest, properties, ...(required === undefined ? {} : { required }) };
}

/**
 * What tools/list answers for these definitions: the zod schemas turned into
 * JSON Schema, legacy names left out. A session whose answers are text alone
 * (client-name.ts's AnswerFormat) is listed no outputSchema: it gets no
 * structured content to hold to one. Pure, so one answer serves every session
 * with the same tools (tool-runtime.ts keeps it per permission key).
 */
export function buildToolCatalogue(defs: readonly ToolDef[], allowLocalFiles: boolean, format: AnswerFormat = "full"): readonly Tool[] {
  return defs.filter((def) => !def.legacyRead).map((def) => ({
    name: def.name,
    title: def.title,
    description: def.description,
    // Strict, so the list says a tool takes these arguments and no others (zod 4 leaves that out for a plain object's input).
    inputSchema: advertised(toJsonSchemaCompat(z.strictObject(def.schema), { strictUnions: true, pipeStrategy: "input" }) as JsonSchema, allowLocalFiles) as Tool["inputSchema"],
    ...(def.outputSchema === undefined || format === "text"
      ? {}
      : {
          outputSchema: advertised(
            toJsonSchemaCompat(def.outputSchema instanceof z.ZodType ? def.outputSchema : z.object(def.outputSchema), { strictUnions: true, pipeStrategy: "output" }) as JsonSchema,
            true
          ) as Tool["outputSchema"],
        }),
    annotations: def.hints,
  }));
}

export function publishToolCatalogue(server: McpServer, tools: readonly Tool[]): void {
  // Small test doubles only collect handlers; a real MCP server always has this public API.
  if (server.server === undefined) return;
  // Replace only tools/list after registration. tools/call stays SDK-owned: parsing,
  // output validation, permissions and limits also apply to unlisted legacy names.
  // The array is shared between sessions and only ever serialized, never changed.
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: tools as Tool[] }));
}
