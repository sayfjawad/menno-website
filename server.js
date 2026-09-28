// Zero-dependency web server for the menno drink-ordering app.
// Serves the static site on 0.0.0.0:3000 (live at https://menno.sdai.nl)
// and exposes a small JSON API so visitors can order a drink.
//
//   GET    /api/orders        -> { orders: [...] }
//   POST   /api/orders        -> create an order  { name, drink, detail }
//   DELETE /api/orders/:id     -> remove one order
//   DELETE /api/orders        -> clear all orders
//
// Orders are stored in data/orders.json (created automatically).
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

// Load .env (e.g. QWEN_API_KEY) without any external dependency.
(function loadEnv() {
  const envFile = path.join(__dirname, ".env");
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
})();

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// ---------------------------------------------------------------- storage ---
function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, "[]");
}

function readOrders() {
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function writeOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

// ------------------------------------------------------------- http helpers ---
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1e6) {
        reject(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// Allow all drink options, with optional detail text.
const DRINKS = ["koffie", "thee", "frisdrank"];

function sanitize(str, max = 80) {
  return String(str == null ? "" : str).trim().slice(0, max);
}

// ----------------------------------------------------------------- chat proxy ---
const QWEN_URL = "https://q38-27b.sdai.nl/v1/chat/completions";
const QWEN_MODEL = "qwen3.8-27b";

// Forwards the full conversation to the Qwen API and resolves with the reply.
function proxyChat(messages) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.QWEN_API_KEY;
    if (!apiKey) return reject(new Error("QWEN_API_KEY ontbreekt in .env"));

    const payload = JSON.stringify({ model: QWEN_MODEL, messages });
    const req = https.request(
      QWEN_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (resp) => {
        let raw = "";
        resp.on("data", (c) => (raw += c));
        resp.on("end", () => {
          let data;
          try {
            data = JSON.parse(raw);
          } catch {
            return reject(new Error("Ongeldig antwoord van de AI."));
          }
          if (resp.statusCode >= 200 && resp.statusCode < 300) {
            const text =
              data.choices &&
              data.choices[0] &&
              data.choices[0].message &&
              data.choices[0].message.content;
            return text ? resolve(text) : reject(new Error("Leeg antwoord van de AI."));
          }
          const errMsg =
            data.error && data.error.message
              ? data.error.message
              : "AI-fout (" + resp.statusCode + ")";
          return reject(new Error(errMsg));
        });
      }
    );
    req.on("error", (e) => reject(new Error("Kan de AI niet bereiken: " + e.message)));
    req.setTimeout(60000, () => req.destroy(new Error("De AI deed er te lang over.")));
    req.write(payload);
    req.end();
  });
}

async function handleChat(req, res) {
  if (req.method.toUpperCase() !== "POST") {
    return sendJson(res, 405, { error: "method not allowed" });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return sendJson(res, 400, { error: "Geen gesprek verstuurd." });

  const reply = await proxyChat(messages);
  return sendJson(res, 200, { reply });
}

// ---------------------------------------------------------------- API router ---
async function handleApi(req, res, pathname) {
  const method = req.method.toUpperCase();

  if (pathname === "/api/orders" && method === "GET") {
    return sendJson(res, 200, { orders: readOrders() });
  }

  if (pathname === "/api/orders" && method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    const name = sanitize(body.name, 60);
    const drink = sanitize(body.drink, 20).toLowerCase();
    const detail = sanitize(body.detail, 80);

    if (!name) return sendJson(res, 400, { error: "Vul je naam in." });
    if (!DRINKS.includes(drink))
      return sendJson(res, 400, { error: "Kies een geldig drankje." });

    const order = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name,
      drink,
      detail,
      createdAt: new Date().toISOString(),
    };
    const orders = readOrders();
    orders.push(order);
    writeOrders(orders);
    return sendJson(res, 201, { order });
  }

  if (pathname === "/api/orders" && method === "DELETE") {
    writeOrders([]);
    return sendJson(res, 200, { ok: true });
  }

  const m = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (m && method === "DELETE") {
    const id = decodeURIComponent(m[1]);
    const orders = readOrders().filter((o) => o.id !== id);
    writeOrders(orders);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: "not found" });
}

// ------------------------------------------------------------------- server ---
ensureStore();

http
  .createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split("?")[0]);

    if (rel === "/api/chat") {
      return handleChat(req, res).catch((e) =>
        sendJson(res, 500, { error: e.message })
      );
    }

    if (rel === "/api/orders" || rel.startsWith("/api/orders/")) {
      return handleApi(req, res, rel).catch((e) =>
        sendJson(res, 500, { error: e.message })
      );
    }

    if (rel === "/") rel = "/index.html";
    const file = path.join(ROOT, path.normalize(rel));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        return res.end("<h1>404 — Not Found</h1>");
      }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      });
      res.end(data);
    });
  })
  .listen(PORT, "0.0.0.0", () =>
    console.log(`menno-website serving ${ROOT} on http://0.0.0.0:${PORT}`)
  );