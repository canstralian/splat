import { ToolRegistry } from "../registry";
import { addCommentTool } from "./add-comment";
import { bugStatsTool } from "./bug-stats";
import { createBugTool } from "./create-bug";
import { getBugTool } from "./get-bug";
import { listProjectsTool } from "./list-projects";
import { searchBugsTool } from "./search-bugs";
import { listTeamMembersTool } from "./team-members";
import { updateBugStatusTool } from "./update-bug-status";
import type { ToolDefinition } from "../types";

export const splatTools: ToolDefinition[] = [
  // Read tools — always exposed to the model.
  searchBugsTool as ToolDefinition,
  getBugTool as ToolDefinition,
  bugStatsTool as ToolDefinition,
  listProjectsTool as ToolDefinition,
  listTeamMembersTool as ToolDefinition,
  // Write tools — only exposed when the request carries the runtime
  // `allowWrites` capability (set by the user in the UI, never by the model).
  createBugTool as ToolDefinition,
  updateBugStatusTool as ToolDefinition,
  addCommentTool as ToolDefinition,
];

export function createSplatToolRegistry(): ToolRegistry {
  return new ToolRegistry(splatTools);
}
