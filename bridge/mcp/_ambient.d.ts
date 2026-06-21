// Ambient decls for runtime deps that bun resolves but that ship no types in
// bridge/node_modules. Shorthand ambient modules => their exports are `any`.
// This is an honest untyped boundary, not an attempt to model these libraries.
// Only consumed by tsconfig.mcp.json (the gating tsconfig excludes mcp).
declare module "bun:sqlite";
declare module "papaparse";
declare module "exceljs";
declare module "jmespath";
