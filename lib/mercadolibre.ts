import axios from "axios";

const mlClient = axios.create({
  baseURL: "https://api.mercadolibre.com",
  headers: {
    Authorization: `Bearer ${process.env.ML_ACCESS_TOKEN}`,
  },
});

export async function getMyUserId(): Promise<string> {
  const { data } = await mlClient.get("/users/me");
  return String(data.id);
}

export async function getAllItemIds(userId: string): Promise<string[]> {
  const ids: string[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const { data } = await mlClient.get(
      `/users/${userId}/items/search?limit=${limit}&offset=${offset}`
    );
    const results: string[] = data.results ?? [];
    ids.push(...results);

    if (ids.length >= data.paging.total || results.length === 0) break;
    offset += limit;
  }

  return ids;
}

export async function getItemsBatch(ids: string[]): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  const chunkSize = 20;

  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const { data } = await mlClient.get(`/items?ids=${chunk.join(",")}`);
    const items = data
      .filter((r: { code: number }) => r.code === 200)
      .map((r: { body: Record<string, unknown> }) => r.body);
    results.push(...items);
  }

  return results;
}

export async function getMyOrders(userId: string): Promise<Record<string, unknown>[]> {
  const orders: Record<string, unknown>[] = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const { data } = await mlClient.get(
      `/orders/search?seller=${userId}&sort=date_desc&limit=${limit}&offset=${offset}`
    );
    const results = data.results ?? [];
    orders.push(...results);

    if (orders.length >= data.paging.total || results.length === 0 || offset >= 500) break;
    offset += limit;
  }

  return orders;
}
