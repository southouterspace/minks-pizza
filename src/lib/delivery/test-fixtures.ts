import type { DeliveryRequest } from "./types";

export const REQUEST: DeliveryRequest = {
  externalId: "6f1c2c1e-1f7a-4a39-9d43-2a6f3b8f9e10",
  pickup: {
    businessName: "Mink's Pizza",
    contactName: "Mink's Pizza",
    phone: "+15550100000",
    address: { street: ["100 Main St"], city: "Springfield", state: "IL", zip: "62701", country: "US" },
  },
  dropoff: {
    contactName: "Ada Lovelace",
    phone: "+15552223333",
    address: { street: ["12 Elm St", "Apt 4"], city: "Springfield", state: "IL", zip: "62704", country: "US" },
    instructions: "Ring twice",
  },
  orderValueCents: 3250,
  tipCents: 0,
  items: [{ name: "Large Pepperoni", quantity: 2 }],
};

export type Call = { url: string; method: string; headers: Headers; body: string };

/** A fetch stub that records each request and answers from a queue. */
export function stubFetch(responses: unknown[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchStub = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ""),
    });
    if (queue.length === 0) throw new Error(`Unexpected request to ${String(input)}`);
    return Response.json(queue.shift());
  };
  return { fetch: fetchStub as typeof fetch, calls };
}
