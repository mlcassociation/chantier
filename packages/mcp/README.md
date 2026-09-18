# @chantier/mcp

MCP client for the chantier coding agent: connects Model Context Protocol
servers (stdio and Streamable HTTP), adapts their tools to chantier's
`ToolDefinition`, and loads server config from `~/.chantier/config.json`
(`mcpServers`, `servers`, or a bare name→server record) merged with the
project `.mcp.json` (Claude Code shape) — with `${VAR}` / `${VAR:-default}`
expansion.

Connecting never throws: a failed server is skipped with a one-line notice.
Tools surface as `mcp__<server>__<tool>`; `readOnlyHint` annotations map to
read-only tools; output truncates at 25k chars.

```jsonc
// .mcp.json (project) or ~/.chantier/config.json
{
  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "remote": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${MCP_TOKEN}" } }
  }
}
```