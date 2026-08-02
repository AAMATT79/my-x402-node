import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

const app = express();

// Your receiving wallet
const PAY_TO = "0x0c82a9cf758f5a32C60d34b7dA5df25134F4c3F0";

// Mainnet facilitator that supports Base (eip155:8453)
const facilitatorClient = new HTTPFacilitatorClient({
  url: "https://facilitator.payai.network",
});

const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:8453", new ExactEvmScheme()) // Base Mainnet
  .onAfterSettle(async (ctx) => {
    console.log("✅ Real payment settled:", ctx.result?.transaction);
  });

function isPreview(req) {
  return req.query.preview === "1" || req.query.preview === "true";
}

async function geocode(city) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.results?.[0]) throw new Error(`City not found: ${city}`);
  const { latitude, longitude, name, country } = data.results[0];
  return { lat: latitude, lon: longitude, name, country };
}

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: [
          {
            scheme: "exact",
            price: (ctx) =>
              ctx.adapter.getQueryParam?.("tier") === "premium" ? "$0.005" : "$0.001",
            network: "eip155:8453",
            payTo: PAY_TO,
          },
        ],
        description: "Real-time weather for any city (Open-Meteo)",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { city: "Tokyo", tier: "standard" },
            inputSchema: {
              properties: {
                city: { type: "string" },
                tier: { type: "string", enum: ["standard", "premium"] },
                preview: { type: "string" },
              },
              required: ["city"],
            },
          }),
        },
      },

      "GET /forecast": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.008",
            network: "eip155:8453",
            payTo: PAY_TO,
          },
        ],
        description: "7-day weather forecast",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { city: "London", days: 7 },
            inputSchema: {
              properties: {
                city: { type: "string" },
                days: { type: "integer", minimum: 1, maximum: 16 },
              },
              required: ["city"],
            },
          }),
        },
      },

      "GET /crypto": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.002",
            network: "eip155:8453",
            payTo: PAY_TO,
          },
        ],
        description: "Live crypto prices (CoinGecko)",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { ids: "bitcoin,ethereum,solana" },
            inputSchema: {
              properties: {
                ids: { type: "string", description: "Comma-separated CoinGecko IDs" },
              },
              required: ["ids"],
            },
          }),
        },
      },

      "GET /news": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.003",
            network: "eip155:8453",
            payTo: PAY_TO,
          },
        ],
        description: "Top tech news (Hacker News)",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { limit: 10 },
            inputSchema: {
              properties: {
                limit: { type: "integer", minimum: 1, maximum: 30 },
              },
            },
          }),
        },
      },
    },
    resourceServer
  )
);

// ── Routes ──────────────────────────────────────

app.get("/weather", async (req, res) => {
  try {
    const city = req.query.city || "San Francisco";
    const tier = req.query.tier || "standard";

    if (isPreview(req)) {
      return res.json({
        city,
        note: "Free preview – remove ?preview=1 and pay for live data",
        temperature: 72,
        weather: "sample",
        paid: false,
      });
    }

    const { lat, lon, name, country } = await geocode(city);

    const weatherUrl =
      `https://api.open-meteo.com/v1/forecast?latitude=\( {lat}&longitude= \){lon}` +
      `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m` +
      (tier === "premium"
        ? `&hourly=temperature_2m,precipitation_probability&forecast_days=1`
        : "");

    const data = await (await fetch(weatherUrl)).json();
    const current = data.current;

    const result = {
      city: name,
      country,
      temperature: current.temperature_2m,
      humidity: current.relative_humidity_2m,
      windspeed: current.wind_speed_10m,
      winddirection: current.wind_direction_10m,
      weather_code: current.weather_code,
      paid: true,
      source: "Open-Meteo",
      timestamp: current.time,
    };

    if (tier === "premium" && data.hourly) {
      result.hourly = data.hourly.time.slice(0, 12).map((t, i) => ({
        time: t,
        temperature: data.hourly.temperature_2m[i],
        precipitation_probability: data.hourly.precipitation_probability[i],
      }));
    }

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/forecast", async (req, res) => {
  try {
    const city = req.query.city || "London";
    const days = Math.min(Number(req.query.days) || 7, 16);

    const { lat, lon, name, country } = await geocode(city);

    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=\( {lat}&longitude= \){lon}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code` +
      `&forecast_days=${days}&timezone=auto`;

    const data = await (await fetch(url)).json();

    res.json({
      city: name,
      country,
      days: data.daily.time.map((date, i) => ({
        date,
        high: data.daily.temperature_2m_max[i],
        low: data.daily.temperature_2m_min[i],
        precipitation: data.daily.precipitation_sum[i],
        weather_code: data.daily.weather_code[i],
      })),
      paid: true,
      source: "Open-Meteo",
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/crypto", async (req, res) => {
  try {
    const ids = req.query.ids || "bitcoin,ethereum,solana";

    if (isPreview(req)) {
      return res.json({ note: "Free preview", bitcoin: { usd: 68000 }, paid: false });
    }

    const url =
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}` +
      `&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`;

    const data = await (await fetch(url)).json();

    res.json({
      ...data,
      paid: true,
      source: "CoinGecko",
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/news", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 30);

    const topRes = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json");
    const ids = await topRes.json();

    const stories = await Promise.all(
      ids.slice(0, limit).map(async (id) => {
        const item = await (
          await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)
        ).json();
        return {
          id: item.id,
          title: item.title,
          url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
          score: item.score,
          by: item.by,
          time: new Date(item.time * 1000).toISOString(),
        };
      })
    );

    res.json({
      source: "Hacker News",
      count: stories.length,
      stories,
      paid: true,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    payTo: PAY_TO,
    network: "Base Mainnet (eip155:8453)",
    facilitator: "https://facilitator.payai.network",
  });
});

const PORT = process.env.PORT || 4021;
app.listen(PORT, () => {
  console.log(`🚀 REAL MONEY x402 node live → http://localhost:${PORT}`);
  console.log(`Receiving USDC on Base Mainnet → ${PAY_TO}`);
});