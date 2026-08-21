import { NextResponse } from "next/server";
import axios from "axios";
import { getValidAccessToken } from "@/lib/ml-token";

// Endpoint temporal de investigación para la Fase 1 de "Competencia" — se
// revierte apenas se obtienen los resultados, no es código definitivo.
export async function GET() {
  const result: Record<string, unknown> = {};

  // Sin auth (endpoints públicos según doc de ML)
  for (const id of ["MLC1737030581", "MLC1442349853"]) {
    try {
      const { data } = await axios.get(`https://api.mercadolibre.com/items/${id}`, { timeout: 8000 });
      result[`noauth_${id}`] = data;
    } catch (err) {
      result[`noauth_${id}`] = { error: axios.isAxiosError(err) ? { status: err.response?.status, data: err.response?.data } : String(err) };
    }
  }
  try {
    const { data } = await axios.get("https://api.mercadolibre.com/sites/MLC/search", {
      params: { q: "detergente omo liquido" },
      timeout: 8000,
    });
    result["noauth_search"] = data;
  } catch (err) {
    result["noauth_search"] = { error: axios.isAxiosError(err) ? { status: err.response?.status, data: err.response?.data } : String(err) };
  }

  // Con token propio de La Mundial
  try {
    const token = await getValidAccessToken();
    const client = axios.create({
      baseURL: "https://api.mercadolibre.com",
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8000,
    });
    for (const id of ["MLC1737030581", "MLC1442349853"]) {
      try {
        const { data } = await client.get(`/items/${id}`);
        result[`auth_${id}`] = data;
      } catch (err) {
        result[`auth_${id}`] = { error: axios.isAxiosError(err) ? { status: err.response?.status, data: err.response?.data } : String(err) };
      }
    }
    try {
      const { data } = await client.get("/sites/MLC/search", { params: { q: "detergente omo liquido" } });
      result["auth_search"] = data;
    } catch (err) {
      result["auth_search"] = { error: axios.isAxiosError(err) ? { status: err.response?.status, data: err.response?.data } : String(err) };
    }
  } catch (err) {
    result["auth_setup_error"] = String(err);
  }

  return NextResponse.json(result);
}
