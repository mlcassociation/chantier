// Minimal MCP stdio server for tests: initialize + tools/list + tools/call.
// Speaks newline-delimited JSON-RPC over stdio; responds to anything else
// with method-not-found. The `probe` tool description carries the value of
// CUSTOM_PROBE from its environment so tests can assert env forwarding.
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index === -1) break;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim().length > 0) handle(JSON.parse(line));
  }
});

function handle(msg) {
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "0.0.0" },
      },
    });
    return;
  }
  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echoes the text back.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
            annotations: { readOnlyHint: true },
          },
          {
            name: "probe",
            description: `probe=${process.env.CUSTOM_PROBE ?? "unset"}`,
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "boom",
            description: "Always fails in-band.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
    return;
  }
  if (msg.method === "tools/call" && msg.params.name === "echo") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        content: [{ type: "text", text: `echo: ${msg.params.arguments?.text ?? ""}` }],
      },
    });
    return;
  }
  if (msg.method === "tools/call" && msg.params.name === "boom") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: "boom failed" }], isError: true },
    });
    return;
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
