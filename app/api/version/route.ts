import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? "desconocido (no es Vercel)",
    commitMessage: process.env.VERCEL_GIT_COMMIT_MESSAGE ?? "",
    deployedAt: process.env.VERCEL_GIT_COMMIT_REF ?? "",
  });
}
