// tools/index.ts · single export surface for the 7 MCP tools.
// Each tool exports a `*Definition` (name + description + JSON schema)
// and a handler function. server.ts wires them into the MCP SDK.

export { eventAppendDefinition, eventAppend } from './event-append.js';
export { eventListDefinition, eventList } from './event-list.js';
export { projectListDefinition, projectList } from './project-list.js';
export { projectGetDefinition, projectGet } from './project-get.js';
export { projectSetScopeDefinition, projectSetScope } from './project-set-scope.js';
export { boardReadDefinition, boardRead } from './board-read.js';
export { workspaceContextDefinition, workspaceContext } from './workspace-context.js';
export { signoffCreateDefinition, signoffCreate } from './signoff-create.js';
export { signoffAwaitDefinition, signoffAwait } from './signoff-await.js';
