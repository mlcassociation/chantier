import type { ToolDefinition } from "@chantier/core";
import { truncateOutput } from "./common.ts";

const TIMEOUT_MS = 15_000;
const BODY_CAP_BYTES = 1_000_000;
const TEXT_RETURN_CHARS = 20_000;

export const webfetchTool: ToolDefinition = {
  name: "webfetch",
  description:
    "Fetch a URL over HTTP(S) and return its content as plain text (HTML tags stripped, no JavaScript " +
    "rendering). 15 s timeout, 1 MB body cap, first 20 000 chars returned.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL to fetch" },
    },
    required: ["url"],
  },
  readOnly: true,
  specifier: (input) => (typeof input.url === "string" ? input.url : undefined),
  handler: async (input) => {
    const url = typeof input.url === "string" ? input.url : undefined;
    if (url === undefined || !URL.canParse(url)) {
      return "Error: the `url` argument is required and must be an absolute http(s) URL.";
    }

    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
    } catch (error) {
      return `Error: fetch failed for ${url}: ${(error as Error).message}`;
    }
    if (!response.ok) {
      return `Error: ${url} responded with HTTP ${response.status} ${response.statusText}.`;
    }

    const reader = response.body?.getReader();
    if (reader === undefined) {
      return `Error: ${url} returned an empty body.`;
    }
    const decoder = new TextDecoder("utf8", { fatal: false });
    let text = "";
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (bytes >= BODY_CAP_BYTES) {
        await reader.cancel();
        text += "\n[body truncated at 1 MB]";
        break;
      }
    }
    text += decoder.decode();

    const contentType = response.headers.get("content-type") ?? "";
    const plain = contentType.includes("html") ? htmlToText(text) : text;
    return truncateOutput(plain.slice(0, TEXT_RETURN_CHARS), TEXT_RETURN_CHARS);
  },
};

/** Naive HTML → text: drop script/style blocks, strip tags, decode common entities. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
