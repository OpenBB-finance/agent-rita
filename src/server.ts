import "./lib/logger";
import { honoLogger, getLogger } from "./lib/logger";
import { initTelemetry, shutdownTelemetry } from "./lib/telemetry";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { agentsRouter } from "./routes/agents";
import { statusRouter } from "./routes/status";
import { queryRouter } from "./routes/query";
import { generateRouter } from "./routes/generate";

const logger = getLogger(["app", "server"]);

// Must run before any span is created. No-op unless an OTLP endpoint is set.
initTelemetry();

const app = new Hono();

app.use("*", cors());
app.use("*", honoLogger);

app.use("*", async (c, next) => {
  const traceId = c.req.header("x-trace-id") ?? crypto.randomUUID();
  const completionId = crypto.randomUUID();
  c.header("X-Trace-Id", traceId);
  c.header("X-Completion-Id", completionId);
  await next();
});

app.route("/", agentsRouter);
app.route("/", statusRouter);
app.route("/", queryRouter);
app.route("/", generateRouter);

const PORT = Number(process.env.PORT ?? 7777);

// Without an explicit flush the batch processor drops whatever it is holding,
// so the last trace before every deploy would vanish.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    await shutdownTelemetry();
    process.exit(0);
  });
}

logger.info("Server starting", { port: PORT });

export default {
  port: PORT,
  fetch: app.fetch,
  idleTimeout: 255,
};
