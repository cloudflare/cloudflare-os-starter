import { WorkerEntrypoint } from "cloudflare:workers";
import type { ErrorEventV1, ErrorReporterProps } from "@gadgets/error-reporting";
import { formatErrorLog } from "./format.js";

export class ErrorReporter extends WorkerEntrypoint<unknown, ErrorReporterProps> {
  async report(event: ErrorEventV1): Promise<void> {
    console.error(formatErrorLog(this.ctx.props, event));
  }
}

/**
 * Keeps the ES Module worker format; this worker is used over RPC, not HTTP. An empty default
 * export deploys as a script with no registered event handlers and the API rejects it.
 */
export default {
  async fetch(): Promise<Response> {
    return new Response("Error Reporter worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
