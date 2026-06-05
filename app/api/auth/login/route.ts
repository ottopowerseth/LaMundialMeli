import { redirect } from "next/navigation";

export async function GET() {
  const url = new URL("https://auth.mercadolibre.cl/authorization");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", process.env.ML_CLIENT_ID!);
  url.searchParams.set("redirect_uri", process.env.ML_REDIRECT_URI!);

  redirect(url.toString());
}
