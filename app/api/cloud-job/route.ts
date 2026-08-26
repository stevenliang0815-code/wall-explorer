export const dynamic = "force-dynamic";

const workflowUrl = "https://github.com/stevenliang0815-code/wall-explorer/actions/workflows/historical-backfill.yml";

async function configuredStatusUrl() {
  const { env } = await import("cloudflare:workers");
  const value = (env as Record<string, unknown>).HISTORICAL_JOB_STATUS_URL;
  return typeof value === "string" && value.startsWith("https://") ? value : null;
}

export async function GET() {
  const statusUrl = await configuredStatusUrl();
  if (!statusUrl) {
    return Response.json({ configured: false, status: "awaiting_r2_configuration", startUrl: workflowUrl, retryUrl: workflowUrl }, { headers: { "Cache-Control": "no-store" } });
  }
  try {
    const response = await fetch(statusUrl, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`R2 status returned ${response.status}`);
    const body = await response.json() as Record<string, unknown>;
    return Response.json({ configured: true, ...body, startUrl: workflowUrl, retryUrl: workflowUrl }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ configured: true, status: "unavailable", error: error instanceof Error ? error.message : "Unknown R2 status error", startUrl: workflowUrl, retryUrl: workflowUrl }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
