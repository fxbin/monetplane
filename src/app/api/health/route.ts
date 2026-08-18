import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db/client";

export const runtime = "nodejs";

export async function GET() {
  const startedAt = Date.now();

  try {
    await getDb().execute(sql`select 1`);

    return NextResponse.json({
      status: "ok",
      service: "monetplane",
      database: "ok",
      latencyMs: Date.now() - startedAt,
    });
  } catch {
    return NextResponse.json(
      {
        status: "degraded",
        service: "monetplane",
        database: "unavailable",
      },
      { status: 503 },
    );
  }
}
