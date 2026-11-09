// A connector for C5 tests: "ping" answers, "crash" kills the process mid-call,
// "env" shows what it inherited, "file" returns a file under a hostile name.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "flaky", version: "0.0.0" });
server.registerTool("ping", { description: "Answers pong." }, () => ({
  content: [{ type: "text", text: "pong" }],
}));
server.registerTool("crash", { description: "Dies." }, () => process.exit(1));
server.registerTool("env", { description: "Lists its environment." }, () => ({
  content: [{ type: "text", text: JSON.stringify(process.env) }],
}));
server.registerTool("file", { description: "Returns a file." }, () => ({
  content: [
    { type: "text", text: "Here is the file." },
    {
      type: "resource",
      resource: { uri: "file:///../../etc/Weird name;rm -rf.csv", text: "a,b\n1,2\n" },
    },
  ],
}));
await server.connect(new StdioServerTransport());
