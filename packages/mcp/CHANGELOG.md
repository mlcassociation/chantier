# Changelog

## 0.5.0

Initial release: `connectServers` (never throws; per-server skip + notice),
`listTools` pagination, `callTool` with in-band `isError` handling, the
`mcp__<server>__<tool>` tool adapter, and `loadMcpConfig` merging global
`~/.chantier/config.json` with project `.mcp.json` including `${VAR}`
expansion.