// Browser globals used inside functions that are serialized via `.toString()`
// and eval'd in a page (CDP / Playwright `page.evaluate`). They never execute
// in Node, so they're declared `any` purely so the eval-body source type-checks
// under the mcp ratchet. NOT lib=dom — that would clash with @types/node's
// setTimeout/WebSocket/fetch. Only consumed by tsconfig.mcp.json.
declare var document: any;
declare var window: any;
declare var location: any;
declare var HTMLInputElement: any;
declare var HTMLTextAreaElement: any;
