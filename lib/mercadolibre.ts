import axios from "axios";

const ML_BASE_URL = "https://api.mercadolibre.com";

const mlClient = axios.create({
  baseURL: ML_BASE_URL,
  headers: {
    Authorization: `Bearer ${process.env.ML_ACCESS_TOKEN}`,
  },
});

export async function getMyListings() {
  const { data } = await mlClient.get("/users/me");
  const userId = data.id;

  const { data: listings } = await mlClient.get(
    `/users/${userId}/items/search?limit=100`
  );
  return listings;
}

export async function getItemDetails(itemId: string) {
  const { data } = await mlClient.get(`/items/${itemId}`);
  return data;
}

export async function getMyOrders() {
  const { data: user } = await mlClient.get("/users/me");
  const userId = user.id;

  const { data: orders } = await mlClient.get(
    `/orders/search?seller=${userId}&sort=date_desc&limit=50`
  );
  return orders;
}
