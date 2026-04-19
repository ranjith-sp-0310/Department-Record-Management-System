// Loaded via --import before any app modules so instrumentation patches take effect.
// Auto-instruments Express, pg, HTTP in/out, and DNS.
// Sends traces to any OTel-compatible backend (Jaeger, Grafana Tempo, Datadog, etc.)
// via OTLP/HTTP. Configure via environment variables — no code changes needed.

import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME ?? "drms-backend",
  traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-fs": { enabled: false },
    }),
  ],
});

sdk.start();

process.on("SIGTERM", () => sdk.shutdown().catch(console.error));
process.on("SIGINT", () => sdk.shutdown().catch(console.error));
