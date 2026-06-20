import express from "express";
import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(express.json());

// ── CORS ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const CONFIG = {
  FEED_URL: "https://feeds.datafeedwatch.com/73484/2796c588a919a06bb42a884950221484637dff3a.xml",
  FEED_REFRESH_MS: 60 * 60 * 1000,
  FRESHCHAT_TOKEN: process.env.FRESHCHAT_TOKEN,
  FRESHCHAT_DOMAIN: process.env.FRESHCHAT_DOMAIN,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  PORT: process.env.PORT || 3000,
  MAX_PRODUCTS_IN_PROMPT: 8,
  CONVERSATION_HISTORY: 6,
  RATE_LIMIT_MAX: 40,
  RATE_LIMIT_WINDOW_MS: 60 * 60 * 1000,
  MAX_QUERY_LENGTH: 300,
  // ── Tracking a Google Sheets (pestaña Freshchat) ──
  TRACK_URL: process.env.TRACK_URL || "https://script.google.com/macros/s/AKfycbxp-9dO08nvUk0SRuSYh6Bx86hPS1mZ3iCdBM5trcVAX7YvlKwDtwO7WrUgmXjaqJOT_A/exec",
  TRACK_TAB: "Freshchat",
};

let catalog = [];
const conversations = {};
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Memoria por sesion para Magento (GET /anastasia) ─────────────────
const magentoSessions = {};
const MAGENTO_HISTORY_TURNS = 6;
const MAGENTO_SESSION_TTL_MS = 60 * 60 * 1000;

function getSession(id) {
  if (!id) return null;
  const now = Date.now();
  let s = magentoSessions[id];
  if (!s || (now - s.lastSeen) > MAGENTO_SESSION_TTL_MS) {
    s = { history: [], shownProducts: [], profile: { uses: [], budget: null }, lastSeen: now };
    magentoSessions[id] = s;
  }
  if (!s.profile) s.profile = { uses: [], budget: null };
  s.lastSeen = now;
  return s;
}

const USE_PATTERNS = {
  gaming:      /(gaming|gamer|jugar|juego|juegos|fortnite|valorant|\blol\b|gta|warzone|cod|videojuego)/i,
  universidad: /(universidad|\bla u\b|estudiar|estudio|estudiante|carrera|tesis|programar|programacion|programación)/i,
  trabajo:     /(trabajo|trabajar|oficina|ofimatica|ofimática|curro|pega|negocio|empresa)/i,
  diseño:      /(diseño|diseno|autocad|render|3d|edicion|edición|edita|photoshop|illustrator|premiere|arquitectura)/i,
  portatil:    /(liviana|ligera|portatil|portátil|llevar|viaje|delgada|ultraligera)/i,
};

function updateProfile(session, query) {
  if (!session) return;
  const q = query.toLowerCase();
  const p = session.profile;
  const exclusive = /\b(solo|solamente|unicamente|únicamente|nada mas|nada más|nomas|nomás|ahora si|ahora sí|mejor solo|en realidad)\b/i.test(q);
  const dropGaming = /(ya no.*(gaming|juego|jugar)|no.*(para )?(gaming|juegos|jugar)|sin juegos|nada de juego)/i.test(q);
  const mentioned = [];
  for (const [use, re] of Object.entries(USE_PATTERNS)) {
    if (re.test(q)) mentioned.push(use);
  }
  if (dropGaming) p.uses = p.uses.filter(u => u !== "gaming");
  if (mentioned.length) {
    if (exclusive) {
      p.uses = mentioned;
    } else {
      mentioned.forEach(u => { if (!p.uses.includes(u)) p.uses.push(u); });
    }
  }
  const b = extractBudget(q);
  if (b) p.budget = b;
}

setInterval(() => {
  const now = Date.now();
  for (const id in magentoSessions) {
    if ((now - magentoSessions[id].lastSeen) > MAGENTO_SESSION_TTL_MS) delete magentoSessions[id];
  }
}, 10 * 60 * 1000);

const rateLimitStore = {};
function isRateLimited(ip) {
  const now = Date.now();
  if (!rateLimitStore[ip]) { rateLimitStore[ip] = { count: 1, firstRequest: now }; return false; }
  const record = rateLimitStore[ip];
  if (now - record.firstRequest > CONFIG.RATE_LIMIT_WINDOW_MS) { rateLimitStore[ip] = { count: 1, firstRequest: now }; return false; }
  if (record.count >= CONFIG.RATE_LIMIT_MAX) return true;
  record.count++;
  return false;
}

const spamStore = {};
function isSpam(ip, query) {
  const key = `${ip}:${query.trim().toLowerCase()}`;
  const now = Date.now();
  if (!spamStore[key]) { spamStore[key] = { count: 1, firstSeen: now }; return false; }
  const record = spamStore[key];
  if (now - record.firstSeen > 5 * 60 * 1000) { spamStore[key] = { count: 1, firstSeen: now }; return false; }
  if (record.count >= 3) return true;
  record.count++;
  return false;
}

const offTopicWords = [
  "política","gobierno","presidente","elecciones","congreso",
  "religion","religión","dios","iglesia",
  "sexo","pornografía","pornografia","xxx",
  "drogas","cocaína","cocaina","marihuana",
  "hack","hackear","piratear","crackear",
  "receta","comida","cocinar","ingredientes",
  "futbol","fútbol","deporte","partido de",
  "pelicula","película","serie",
  "música","canción","cancion","letra de",
  "chiste","broma","un cuento","cuentame un cuento",
  "noticias","periodico","periódico","novedades del mundo",
];
function hasWord(text, words) {
  const q = ` ${text.toLowerCase()} `;
  return words.some(w => {
    w = w.toLowerCase();
    if (w.includes(" ")) return q.includes(w);
    return new RegExp(`(^|[^a-záéíóúñ0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-záéíóúñ0-9]|$)`, "i").test(q);
  });
}

function isOffTopic(query) {
  return hasWord(query, offTopicWords);
}

function isFollowUp(q) {
  const followUpWords = [
    "cuanto tarda","cuánto tarda","cuanto demora","cuánto demora","cuanto tiempo",
    "cuánto tiempo","tiempo de entrega","tiempo de envio","tiempo de envío",
    "cuando llega","cuándo llega","cuando me llega","dias habiles","días hábiles",
    "envio a","envío a","envian a","envían a","llega a","domicilio","despacho",
    "tiene garantia","tiene garantía","cuanta garantia","cuánta garantía",
    "anos de garantia","años de garantía","cubre la garantia","cubre la garantía",
    "formas de pago","medios de pago","puedo pagar","aceptan","cuotas","financiacion",
    "financiación","tarjeta de credito","tarjeta de crédito","addi","sistecredito",
    "como es el checkout","checkout","como compro","cómo compro","como pago","cómo pago",
    "proceso de compra","como finalizo","cómo finalizo","como hago la compra","carrito",
    "factura","facturacion","facturación","datacredito","pse","contraentrega","contra entrega",
    "cual me conviene","cuál me conviene","cual es mejor","cuál es mejor",
    "cual recomiendas","cuál recomiendas","de esas","de estas","de las que",
    "la primera","la segunda","la tercera","esa cual","cual de las",
    "diferencia entre","comparalas","compáralas","cual elijo","cuál elijo",
    "de las tres","de los tres","mejor de las","mejor de los","mejor de esas",
    "mejor de estas","mejor de esos","la mejor de","el mejor de","dame la mejor",
    "cual es la mejor","cuál es la mejor","la mas potente de","la más potente de",
    "recomiendame la","recomiéndame la","elijo","me quedo con","cual elegir","cuál elegir",
    "estas sirven","estas son buenas","estas son aptas","estas funcionan",
    "estos sirven","estos son buenos","estas siguen","estos siguen",
    "siguen siendo buenas","siguen siendo buenos","esas sirven","esas son buenas",
    "estas valen","estas aguantan","estos aguantan","estas corren","estos corren",
    "pero no tiene","pero ninguna tiene","no tienen","ninguna tiene","ninguno tiene",
    "no tiene i9","no tiene i7","queria i9","quería i9","esa no tiene","ese no tiene",
    "pero queria","pero quería","no es lo que pedi","no es lo que pedí",
    "no es para gaming","no es para juegos","no sirve para gaming","no sirve para juegos",
    "no son para gaming","no son gaming","no es gaming","esa no es para","ese no es para",
    "no sirve para","no sirven para","no es buena para","no son buenas para","no es apta",
    "es buena para","es buen para","son buenas para","sirve para","sirven para","es apta para",
    "es para gaming","es buena para gaming","sirve para gaming","aguanta gaming","corre",
    "me recomendaste","que recomendaste","recomendaste","la que me mostraste","esa que",
    "es buena la","es buena esa","como es la","que tal la","funciona para",
    "gracias","muchas gracias","listo","perfecto","de una","vale","entendido",
    "buenisimo","buenísimo","chevere","chévere","bacano",
  ];
  return hasWord(q, followUpWords);
}

function formatCOP(amount) {
  return `$${Math.round(amount).toLocaleString("es-CO")}`;
}

function addUTM(url, partNumber) {
  const base = url.includes("?") ? `${url}&` : `${url}?`;
  return `${base}utm_source=freshchat&utm_medium=chatbot&utm_campaign=anastasia-co&utm_content=${partNumber}`;
}

async function refreshCatalog() {
  try {
    console.log("Actualizando catálogo CO...");
    const res = await fetch(CONFIG.FEED_URL);
    const xml = await res.text();
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: true });
    const parsed = parser.parse(xml);
    const raw = parsed?.products?.product || parsed?.rss?.channel?.item || parsed?.feed?.entry || [];
    const items = Array.isArray(raw) ? raw : [raw];
    catalog = items.map((item) => {
      const val = (v) => { if (!v) return ""; if (typeof v === "string") return v.trim(); if (typeof v === "number") return String(v); if (v["#text"]) return String(v["#text"]).trim(); return ""; };
      const stripHtml = (s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&nbsp;/g, " ").replace(/&[a-z]+;/g, "").trim().slice(0, 300);
      return {
        id:           val(item.Part_Number) || val(item.Model) || "",
        title:        val(item.Name)        || val(item.title) || "",
        description:  stripHtml(val(item.Short_Description) || val(item.description) || ""),
        price:        val(item.Offer_Price) || val(item.Regular_Price) || val(item.price) || "",
        regularPrice: val(item.Regular_Price) || "",
        link:         val(item.Product_URL) || val(item.link)  || "",
        image:        val(item.Main_Image_URL) || val(item.image) || "",
        brand:        "ASUS",
        model:        val(item.Model)       || "",
        partNumber:   val(item.Part_Number) || "",
        category:     val(item.BU)          || val(item.category) || "",
        availability: val(item.Availability) || val(item.availability) || "in stock",
      };
    }).filter(p => {
      if (!p.title) return false;
      const regular = parseFloat(p.regularPrice) || 0;
      const offer = parseFloat(p.price) || 0;
      if (regular > 0 && offer > 0 && (offer / regular) < 0.5) return false;

      const t = `${p.title} ${p.category}`.toLowerCase();
      const accessoryWords = [
        "case","carcasa","funda","cover","sleeve","estuche","forro",
        "mochila","backpack","maletin","maletín","bolso","morral",
        "mouse","raton","ratón","teclado","keyboard","headset","diadema",
        "audifono","audífono","auricular","earbud","webcam",
        "cargador","charger","adaptador","cable","dock","docking","hub",
        "soporte","stand","base refrigerante","cooling pad",
        "memoria usb","pendrive","usb-c","powerbank","power bank",
        "mousepad","mouse pad","gift","regalo","kit",
      ];
      if (accessoryWords.some(w => t.includes(w))) return false;

      const handheldWords = ["ally","xbox ally","rog ally","steam deck","handheld"];
      if (handheldWords.some(w => t.includes(w))) return false;

      // Piso de precio: ninguna laptop ASUS en COP baja de ~$1.000.000.
      if (offer > 0 && offer < 1000000) return false;

      return true;
    });
    console.log(`✅ Catálogo CO cargado: ${catalog.length} productos activos`);
  } catch (err) {
    console.error("❌ Error actualizando catálogo CO:", err.message);
  }
}

const SINONIMOS = {
  gaming:        ["gamer","jugar","juego","juegos","game","fortnite","lol","valorant","rtx","nvidia","rog","tuf","strix"],
  trabajo:       ["trabajar","trabajo","oficina","excel","word","empresa","corporativo","negocios","office","parche"],
  universidad:   ["uni","universidad","estudio","estudiar","colegio","escuela","tarea","académico","la u"],
  diseño:        ["diseño","diseñar","photoshop","illustrator","editar","edición","video","fotos","creator","creativo"],
  economico:     ["barata","barato","económico","economico","precio","costo","accesible","low","presupuesto","pesos","billete","plata"],
  potente:       ["potente","poderosa","poderoso","mejor","top","gama alta","rápida","rápido","rapida","rapido","rendimiento","berraca","berracas"],
  liviana:       ["liviana","liviano","ligera","ligero","portatil","portátil","fácil de llevar","pequeña","pequeño","delgada"],
  pantalla:      ["pantalla","panta","display","oled","resolución","resolucion"],
  memoria:       ["ram","memoria","16gb","8gb","32gb","4gb","gb","ddr","ddr5","ddr4"],
  procesador:    ["intel","amd","ryzen","i5","i7","i9","i3","core","cpu","procesador","chip"],
  grafica:       ["gpu","gráfica","grafica","tarjeta de video","nvidia","rtx","gtx","rtx 4050","rtx 4060","rtx 4070","rtx 3050","rtx 3060","geforce","radeon","vram","dedicada","video"],
  bateria:       ["batería","bateria","dura","autonomía","autonomia","carga","horas","duración"],
  almacenamiento:["ssd","disco","almacenamiento","espacio","1tb","512gb","256gb","terabyte","storage"],
  tactil:        ["táctil","tactil","touch","convertible","2en1","2 en 1","tableta","tablet"],
  tamaño:        ["grande","14 pulgadas","15 pulgadas","16 pulgadas","13 pulgadas","pulgadas","pulgada"],
  lineas:        ["vivobook","zenbook","proart","expertbook","chromebook","rog","tuf","strix","scar","flow","zephyrus"],
  handheld:      ["ally","handheld","consola","portatil","portable","xbox","gamepass","game pass","steam","steam deck","mini consola","joystick","control"],
};

// Extrae un techo de presupuesto en COP. Devuelve null si no hay.
function extractBudget(q) {
  let m = q.match(/(\d+(?:[.,]\d+)?)\s*(millones|millon|palos|palo|lucas|luca|m\b)/i);
  if (m) return Math.round(parseFloat(m[1].replace(",", ".")) * 1000000);
  m = q.match(/(\d[\d.,]{5,})/);
  if (m) {
    const n = parseInt(m[1].replace(/[.,]/g, ""), 10);
    if (n >= 500000) return n;
  }
  return null;
}

function isGamingProduct(p) {
  const t = `${p.title} ${p.description} ${p.category}`.toLowerCase();
  if (/integrad|intel graphics|intel hd|adreno|radeon graphics|radeon integrada/.test(t)) {
    return /\brtx\s*\d{3,4}|\bgtx\s*\d{3,4}/.test(t);
  }
  return /gaming|\btuf\b|\brog\b|strix|\brtx\b|\bgtx\b|nitro/.test(t);
}

function searchProducts(query, wantsGamingCtx) {
  const q = query.toLowerCase();
  const wantsGaming = wantsGamingCtx || SINONIMOS.gaming.some(g => q.includes(g));
  const words = q.split(/\s+/).filter(w => w.length > 1);
  const expanded = new Set(words);
  for (const [_cat, syns] of Object.entries(SINONIMOS)) {
    if (syns.some(s => q.includes(s)) || words.some(w => syns.includes(w))) syns.forEach(s => expanded.add(s));
  }
  const allWords = [...expanded];
  if (allWords.length === 0) return catalog.slice(0, CONFIG.MAX_PRODUCTS_IN_PROMPT);
  const scored = catalog.map(product => {
    const text = `${product.title} ${product.description} ${product.category} ${product.brand} ${product.model} ${product.link}`.toLowerCase();
    let score = allWords.reduce((acc, w) => acc + (text.includes(w) ? 1 : 0), 0);
    words.forEach(w => { if (text.includes(w)) score += 5; });
    return { product, score };
  });
  let results = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, CONFIG.MAX_PRODUCTS_IN_PROMPT).map(s => s.product);

  const budget = extractBudget(q);
  if (budget) {
    let within = catalog.filter(p => {
      const price = parseFloat(p.price) || 0;
      return price > 0 && price <= budget;
    });
    if (wantsGaming) {
      const onlyGaming = within.filter(isGamingProduct);
      within = onlyGaming;
    }
    if (within.length > 0) {
      const ranked = within.map(p => {
        const t = `${p.title} ${p.description} ${p.category}`.toLowerCase();
        let s = allWords.reduce((a, w) => a + (t.includes(w) ? 1 : 0), 0);
        return { p, s, price: parseFloat(p.price) || 0 };
      }).sort((a, b) => b.s - a.s || a.price - b.price);
      return ranked.map(r => r.p).slice(0, CONFIG.MAX_PRODUCTS_IN_PROMPT);
    }
    return [];
  }

  if (wantsGaming) {
    let onlyGaming = results.filter(isGamingProduct);
    if (onlyGaming.length === 0) {
      onlyGaming = catalog.filter(isGamingProduct).sort((a, b) => (parseFloat(a.price)||999999) - (parseFloat(b.price)||999999));
    }
    if (onlyGaming.length > 0) {
      if (/(barat|economic|económic|menos|presupuesto)/i.test(q)) {
        onlyGaming = [...onlyGaming].sort((a, b) => (parseFloat(a.price)||999999) - (parseFloat(b.price)||999999));
      }
      return onlyGaming.slice(0, CONFIG.MAX_PRODUCTS_IN_PROMPT);
    }
    return [];
  }

  const budgetWords = ["barata","barato","económico","economico","precio","accesible","presupuesto","pesos","bajos","low","cheap","plata","billete"];
  if (budgetWords.some(w => q.includes(w)) && results.length > 0) {
    return results.sort((a, b) => (parseFloat(a.price) || 999999) - (parseFloat(b.price) || 999999));
  }
  return results.length > 0 ? results : catalog.slice(0, CONFIG.MAX_PRODUCTS_IN_PROMPT);
}

function exactMatchProducts(query, results) {
  const q = query.toLowerCase();
  const stopWords = ["busco","quiero","necesito","tengo","tiene","tienes","para","con","una","uno","un","el","la","los","las","del","que","algo","este","esta","ese","esa","hay","dame","dime","ver","cual","cuál","me","mi","su","tu","yo","por","muy","mas","más","pues","ome","marica","parcero","parce"];
  const words = q.split(/\s+/).filter(w => w.length > 1).filter(w => !stopWords.includes(w));
  if (words.length === 0) return [];
  return results.filter(product => {
    const text = `${product.title} ${product.description} ${product.model} ${product.link}`.toLowerCase();
    const matches = words.every(w => text.includes(w));
    if (!matches) return false;
    const processorSearch = query.match(/\bi[3579]\b/i);
    if (processorSearch) return text.includes(processorSearch[0].toLowerCase());
    return true;
  });
}

function calcPromo(regularPrice, price) {
  const regular = parseFloat(regularPrice) || 0;
  const offer = parseFloat(price) || 0;
  const hasDiscount = regular > 0 && offer > 0 && regular > offer;
  if (!hasDiscount) return null;
  return `${formatCOP(regular)} → ${formatCOP(offer)} ¡Oferta!`;
}

async function askClaude(conversationId, userMessage) {
  const relevant = searchProducts(userMessage);
  if (!conversations[conversationId]) conversations[conversationId] = [];
  const history = conversations[conversationId];
  const productList = relevant.map(p => `• ${p.title} — ${p.price}${p.link ? ` | URL: ${p.link}` : ""}`).join("\n");
  const systemPrompt = `Eres un asistente de ventas experto de esta tienda online ASUS Colombia.
TONO: profesional y cercano, en español claro. Entiendes la jerga colombiana si el cliente la usa, pero TU NUNCA respondes con jerga ni modismos (nada de "parce", "berraca", "marica"). Trata al cliente de "tú".
PRODUCTOS DISPONIBLES:
${productList}
INSTRUCCIONES:
- Haz UNA pregunta específica si necesitas más info.
- Explica brevemente POR QUÉ el producto encaja con lo que pidió.
- Recomienda máximo 2-3 productos con su link.
- Solo menciona productos de la lista.
- Responde en el mismo idioma del cliente. Sé conciso.`;
  const messages = [...history.slice(-CONFIG.CONVERSATION_HISTORY), { role: "user", content: userMessage }];
  const response = await anthropic.messages.create({ model: "claude-haiku-4-5-20251001", max_tokens: 500, system: systemPrompt, messages });
  const reply = response.content[0].text;
  history.push({ role: "user", content: userMessage });
  history.push({ role: "assistant", content: reply });
  if (history.length > CONFIG.CONVERSATION_HISTORY * 2) conversations[conversationId] = history.slice(-CONFIG.CONVERSATION_HISTORY * 2);
  return reply;
}

async function replyOnFreshchat(conversationId, actorId, text) {
  const url = `https://api.freshchat.com/v2/conversations/${conversationId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${CONFIG.FRESHCHAT_TOKEN}` },
    body: JSON.stringify({ message_type: "normal", actor_type: "agent", actor_id: actorId, message_parts: [{ text: { content: text } }] }),
  });
  if (!res.ok) throw new Error(`Freshchat API error ${res.status}: ${await res.text()}`);
}

// ── Log de Freshchat a Google Sheets (pestaña separada vía __tab) ────
// Reusa el mismo collector GAS que Magento, pero con __tab=Freshchat para
// que caiga en su propia pestaña. Fire-and-forget: no bloquea ni rompe el
// webhook si el sheet falla. GET con texto recortado (límite de URL).
function trackFreshchat(fields) {
  if (!CONFIG.TRACK_URL) return;
  try {
    const params = new URLSearchParams({
      __tab: CONFIG.TRACK_TAB,
      country: "CO",
      event: "query",
      source: "freshchat",
      ...fields,
    });
    fetch(`${CONFIG.TRACK_URL}?${params.toString()}`)
      .catch(err => console.error("⚠️ track Freshchat falló:", err.message));
  } catch (e) {
    console.error("⚠️ track Freshchat error:", e.message);
  }
}

app.post("/webhook/freshchat", async (req, res) => {
  res.sendStatus(200);
  try {
    const event = req.body;
    if (event.actor?.actor_type !== "user") return;
    if (!event.messages?.length) return;
    const conversationId = event.conversation?.id;
    const agentId = event.conversation?.assigned_agent_id;
    if (!conversationId) return;
    const userMessage = event.messages.map(m => m.message_parts?.map(p => p.text?.content).filter(Boolean).join(" ")).filter(Boolean).join(" ").trim();
    if (!userMessage) return;
    console.log(`[${conversationId}] Usuario: ${userMessage}`);
    const reply = await askClaude(conversationId, userMessage);
    console.log(`[${conversationId}] Claude: ${reply.slice(0, 80)}...`);
    trackFreshchat({
      session_id: conversationId,
      query: userMessage.slice(0, 500),
      bot_message: reply.slice(0, 500),
    });
    await replyOnFreshchat(conversationId, agentId, reply);
  } catch (err) {
    console.error("❌ Error procesando webhook:", err.message);
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", country: "CO", products: catalog.length, conversations: Object.keys(conversations).length });
});

app.get("/catalog/search", (req, res) => {
  res.json(searchProducts(req.query.q || ""));
});

app.get("/anastasia", async (req, res) => {
  const tStart = Date.now();
  const query = req.query.q || req.query.query || req.query.busqueda || "";
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  const sessionId = req.query.session || req.query.session_id || "";
  const session = getSession(sessionId);
  updateProfile(session, query);
  console.log(`AnastasIA CO consulta: "${query}"${sessionId ? ` [${sessionId}]` : ""}`);
  if (!query) return res.json({ items: [] });

  if (query.startsWith("http://") || query.startsWith("https://")) {
    return res.json({
      message: "Solo puedo ayudarte con recomendaciones de laptops ASUS. ¿Qué tipo de laptop estás buscando?",
      items: [{ TITLE: "Explora nuestras laptops ASUS", TITLE_DISPLAY: "Ver laptops disponibles", PRECIO_REGULAR_FORMAT: "", PRECIO_OFERTA_FORMAT: "", PRECIO_REGULAR: 0, PRECIO_OFERTA: 0, URL: "https://www.asus.com/co/store/", IMAGEN: "https://dlcdnwebimgs.asus.com/gain/34B7D53B-C42E-4F15-8B95-7EDA7F64F22C/w800", SPECS: "Gaming · Trabajo · Universidad · Diseño", PROMO: "Encuentra tu laptop ideal hoy" }]
    });
  }

  if (query.length > CONFIG.MAX_QUERY_LENGTH) {
    return res.json({
      message: "Tu mensaje es muy largo. Por favor escribe una consulta más corta.",
      items: [{ TITLE: "Explora nuestras laptops ASUS", TITLE_DISPLAY: "Ver laptops disponibles", PRECIO_REGULAR_FORMAT: "", PRECIO_OFERTA_FORMAT: "", PRECIO_REGULAR: 0, PRECIO_OFERTA: 0, URL: "https://www.asus.com/co/store/", IMAGEN: "https://dlcdnwebimgs.asus.com/gain/34B7D53B-C42E-4F15-8B95-7EDA7F64F22C/w800", SPECS: "Gaming · Trabajo · Universidad · Diseño", PROMO: "Encuentra tu laptop ideal hoy" }]
    });
  }

  if (isRateLimited(ip)) {
    return res.json({
      message: "Has hecho varias consultas seguidas. Dame un momentico y vuelve a intentar — o si prefieres, habla directo con un asesor.",
      escalate: true,
      items: []
    });
  }

  if (isSpam(ip, query)) {
    return res.json({
      message: "Parece que estás repitiendo la misma búsqueda. ¿Puedo ayudarte con algo más específico?",
      items: [{ TITLE: "Explora nuestras laptops ASUS", TITLE_DISPLAY: "Ver laptops disponibles", PRECIO_REGULAR_FORMAT: "", PRECIO_OFERTA_FORMAT: "", PRECIO_REGULAR: 0, PRECIO_OFERTA: 0, URL: "https://www.asus.com/co/store/", IMAGEN: "https://dlcdnwebimgs.asus.com/gain/34B7D53B-C42E-4F15-8B95-7EDA7F64F22C/w800", SPECS: "Gaming · Trabajo · Universidad · Diseño", PROMO: "Encuentra tu laptop ideal hoy" }]
    });
  }

  if (isOffTopic(query)) {
    return res.json({
      message: "Solo puedo ayudarte con laptops ASUS. ¿Estás buscando una laptop para gaming, trabajo, universidad o diseño?",
      items: [{ TITLE: "Explora nuestras laptops ASUS", TITLE_DISPLAY: "Ver laptops disponibles", PRECIO_REGULAR_FORMAT: "", PRECIO_OFERTA_FORMAT: "", PRECIO_REGULAR: 0, PRECIO_OFERTA: 0, URL: "https://www.asus.com/co/store/", IMAGEN: "https://dlcdnwebimgs.asus.com/gain/34B7D53B-C42E-4F15-8B95-7EDA7F64F22C/w800", SPECS: "Gaming · Trabajo · Universidad · Diseño", PROMO: "Encuentra tu laptop ideal hoy" }]
    });
  }

  try {
    const q = query.toLowerCase();

    const salesWords = [
      "cupon","cupón","codigo descuento","código descuento","promocion","promoción",
      "pedido","mi orden","mi compra","pago","factura","boleta",
      "trade in","trade-in","cambiar equipo","entregar equipo","canjear",
      "reposicion","reposición","restock","cuando llega","cuando estará","cuándo estará","cuando va a llegar",
      "tiendas","donde comprar","distribuidor","punto de venta",
      "devolucion","devolución","cambio de producto","reclamo","queja",
      "asesor","asesores","agente humano","hablar con humano","hablar con persona","hablar con alguien","persona real",
    ];
    if (hasWord(q, salesWords)) {
      return res.json({
        message: "Para consultas sobre cupones, pedidos o promociones, uno de nuestros asesores de ventas te puede ayudar. Da clic abajo para hablar con un asesor.",
        escalate: true,
        items: []
      });
    }

    const serviceWords = [
      "cargador","cargadora","charger","cable carga","adaptador","fuente de poder",
      "dañó","daño","dañada","dañado","quemó","quemada","se quemó","dejó de funcionar",
      "cambiar el ventilador","se rompió","esta rota","esta roto","no me sirve la",
      "bateria hinchada","bateria de repuesto","cambio de bateria",
      "pantalla rota","reemplazo de pantalla","cambio de pantalla","pantalla de repuesto",
      "reparacion","reparación","repair","repuesto","repuestos","spare part","pieza","componente",
      "arreglar","arreglo","tecnico","técnico","servicio tecnico","servicio técnico",
      "motherboard","motherboards","placa madre","placas madre","tarjeta madre","tarjetas madre",
      "graphics card","gpu externa",
      "psu","fuente de alimentacion","fuente de alimentación",
      "ram suelta","memoria ram suelta","disco duro","hdd",
      "gabinete","case pc","cooler",
      "celular","telefono","teléfono","smartphone","iphone","samsung","xiaomi",
      "warranty",
      "impresora","router","modem","módem",
      "memoria usb","pendrive","disco externo",
      "no prende","no enciende","no funciona","se apaga","pantalla negra","pantalla azul",
      "teclado roto","bisagra","puerto usb","puerto hdmi roto",
      "lento","lenta","virus","formatear","formateo","drivers","controladores",
      "wifi no funciona","no conecta","no se conecta",
      "instalar windows","activar windows","actualizacion","actualizar",
      "wifi","wi-fi","access point","punto de acceso","switch de red","hub de red",
      "ups","no break","estabilizador","proyector","smartwatch","reloj inteligente",
    ];
    const mentionsBattery = /\b(bateria|batería|battery|pila)\b/.test(q);
    const batteryProblem = mentionsBattery && /(hinchada|no carga|no funciona|repuesto|reemplaz|rota|muerta|dañ|estallad|inflada)/.test(q);
    const batteryFeature = mentionsBattery && /(duracion|duración|autonomia|autonomía|horas|dura|larga|buena|precio|hasta|pesos|millones|busco|quiero|recomienda|presupuesto)/.test(q);
    if (hasWord(q, serviceWords) || (batteryProblem && !batteryFeature)) {
      return res.json({
        message: "Esa consulta la maneja mejor nuestro equipo de soporte. Da clic abajo para hablar con un asesor y resolverla.",
        escalate: true,
        items: []
      });
    }

    const isHandheld = q.includes("ally") || q.includes("rog ally") ||
      (q.includes("handheld") && !q.includes("laptop")) ||
      q.includes("steam deck") ||
      (q.includes("consola") && q.includes("portatil"));
    if (isHandheld) {
      return res.json({
        message: "La ROG Ally no está disponible en stock en este momento. ¿Te puedo ayudar a encontrar una laptop gaming mientras tanto?",
        items: [{ TITLE: "ROG Ally - Sin stock por ahora", TITLE_DISPLAY: "Vuelve pronto - Proximamente", PRECIO_REGULAR_FORMAT: "", PRECIO_OFERTA_FORMAT: "", PRECIO_REGULAR: 0, PRECIO_OFERTA: 0, URL: "https://www.asus.com/co/store/", IMAGEN: "https://dlcdnwebimgs.asus.com/gain/34B7D53B-C42E-4F15-8B95-7EDA7F64F22C/w800", SPECS: "Consola portatil gaming - Sin stock por ahora", PROMO: "Proximamente disponible" }]
      });
    }

    const nonLaptopWords = [
      "torre","desktop","pc de escritorio","computadora de escritorio",
      "all in one","all-in-one","rog pc","rog desktop","mini pc","nuc",
      "monitor externo","pantalla externa","tablet","ipad",
      "servidor","server","nas","componentes","armar pc","build pc","pc armada","procesador suelto",
      "television","televisor","smart tv","smartwatch","reloj inteligente","proyector","ups","estabilizador",
      "bolso","mochila","maletin","maletín","funda","estuche","backpack","forro",
      "mouse","keyboard","teclado externo","audifonos","audífonos","headset","webcam","auriculares","auricular",
      "parlante","bocina","altavoz",
    ];
    if (hasWord(q, nonLaptopWords) || (q.includes("monitor") && !q.includes("laptop") && !q.includes("pantalla de laptop"))) {
      return res.json({
        message: "Por el momento solo contamos con laptops ASUS en nuestra tienda online en Colombia. ¿Te ayudo a encontrar la laptop perfecta para ti?",
        items: [{ TITLE: "Explora nuestras laptops ASUS", TITLE_DISPLAY: "Ver laptops disponibles", PRECIO_REGULAR_FORMAT: "", PRECIO_OFERTA_FORMAT: "", PRECIO_REGULAR: 0, PRECIO_OFERTA: 0, URL: "https://www.asus.com/co/store/", IMAGEN: "https://dlcdnwebimgs.asus.com/gain/34B7D53B-C42E-4F15-8B95-7EDA7F64F22C/w800", SPECS: "Gaming · Trabajo · Universidad · Diseño", PROMO: "Encuentra tu laptop ideal hoy" }]
      });
    }

    const wantsFullSpecs = hasWord(q, [
      "specs completos","especificaciones completas","ficha tecnica","ficha técnica",
      "todos los specs","todas las especificaciones","specs de","especificaciones de",
      "caracteristicas completas","características completas","detalles tecnicos","detalles técnicos",
      "ficha completa","specs completas",
    ]);
    if (wantsFullSpecs) {
      let target = null;
      const qNorm = q.replace(/[^a-z0-9]/g, "");
      const pool = (session && session.shownProducts.length)
        ? session.shownProducts.map(sp => catalog.find(c => c.title === sp.title)).filter(Boolean)
        : [];
      const candidates = pool.length ? pool : searchProducts(query);
      const scoreOf = (p) => {
        const model = (p.model || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const title = (p.title || "").toLowerCase();
        const qWords = q.split(/\s+/).filter(w => w.length > 2);
        let sc = qWords.filter(w => title.includes(w.replace(/[?¿!¡.,]/g, ""))).length;
        if (model && model.length >= 4 && qNorm.includes(model)) sc += 5;
        return sc;
      };
      let best = null, bestScore = 0;
      for (const p of candidates) {
        const sc = scoreOf(p);
        if (sc > bestScore) { bestScore = sc; best = p; }
      }
      target = (bestScore >= 2) ? best : null;
      if (!target) {
        if (/\b(esta|este|esa|ese|la misma|el mismo)\b/.test(q) && pool.length) target = pool[pool.length - 1];
        else target = candidates[0];
      }

      if (target) {
        const tSheet = Date.now();
        const promo = calcPromo(target.regularPrice, target.price);
        const sheetResp = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 600,
          system: `Eres AnastasIA, experta en laptops ASUS Colombia. Te doy UN producto y debes armar su ficha tecnica.
PRODUCTO: ${target.title}
DESCRIPCION: ${target.description.replace(/"/g, "'")}
Modelo: ${target.model} | Precio: ${target.price}

Devuelve SOLO JSON valido sin markdown:
{"intro":"1 frase corta presentando la laptop","specs":[{"label":"Procesador","value":"..."},{"label":"Memoria RAM","value":"..."},{"label":"Almacenamiento","value":"..."},{"label":"Pantalla","value":"..."},{"label":"Tarjeta grafica","value":"..."},{"label":"Sistema operativo","value":"..."}],"porque":"parrafo de 2-3 frases en español neutro y profesional (sin jerga) explicando por que es buena opcion y para que usos brilla (gaming, AutoCAD, universidad, diseño). Natural y vendedor sin exagerar."}
REGLAS: solo specs que aparezcan en la descripcion; si un spec no esta, omite ese objeto del array (no lo inventes). Incluye RAM ampliable si se menciona. Sin comillas dobles dentro de los valores.`,
          messages: [{ role: "user", content: query }],
        });
        console.log(`Ficha tecnica: ${Date.now() - tSheet}ms`);
        let sheet;
        try {
          let rawSheet = sheetResp.content[0].text.trim().replace(/```json|```/g, "").trim();
          sheet = JSON.parse(rawSheet);
        } catch {
          const d = target.description;
          const pick = (re) => { const m = d.match(re); return m ? m[0].trim() : ""; };
          const specs = [];
          const cpu = pick(/(amd\s+)?ryzen[\s\w]*?\d+\w*|core\s+(ultra\s+)?[i]?\d[\s\w-]*?\d*\w*|intel\s+core[\s\w-]*?\d+\w*/i);
          const ram = pick(/\d{1,3}\s?gb\s+(ddr\d|lpddr\d\w*)/i);
          const ssd = pick(/\d+\s?(gb|tb)\s+ssd/i);
          const pan = pick(/\d{2}(\.\d)?\s?(pulg|"|oled|fhd|wuxga|qhd)\w*/i);
          const gpu = pick(/(rtx|gtx)\s?\d{3,4}\s?(ti)?\s?(\d+gb)?|radeon[\s\w]*|arc[\s\w]*/i);
          if (cpu) specs.push({ label: "Procesador", value: cpu });
          if (ram) specs.push({ label: "Memoria RAM", value: ram });
          if (ssd) specs.push({ label: "Almacenamiento", value: ssd });
          if (pan) specs.push({ label: "Pantalla", value: pan });
          if (gpu) specs.push({ label: "Tarjeta grafica", value: gpu });
          sheet = {
            intro: `Esta es la ficha de la ${target.title}:`,
            specs,
            porque: "Una opcion solida de ASUS. Para mas detalles tecnicos da clic en Ver producto y revisa la ficha completa en la tienda.",
          };
          console.log(`⚠️ Ficha: JSON fallo, armada desde catalogo (${specs.length} specs)`);
        }

        if (sheet) {
          const sku = target.partNumber || target.model;
          const regularNum = parseFloat(target.regularPrice) || parseFloat(target.price) || 0;
          const offerNum   = parseFloat(target.price) || 0;
          if (session) {
            session.history.push({ role: "user", content: query });
            session.history.push({ role: "assistant", content: `[ficha tecnica de ${target.title}]` });
            if (session.history.length > MAGENTO_HISTORY_TURNS * 2) session.history = session.history.slice(-MAGENTO_HISTORY_TURNS * 2);
          }
          return res.json({
            message: sheet.intro || `Esta es la ficha de ${target.title}:`,
            specSheet: {
              TITLE: target.title,
              IMAGEN: target.image,
              SPECS_LIST: Array.isArray(sheet.specs) ? sheet.specs : [],
              PORQUE: sheet.porque || "",
              PRECIO_OFERTA_FORMAT: formatCOP(offerNum),
              PRECIO_REGULAR_FORMAT: formatCOP(regularNum),
              PRECIO_REGULAR: regularNum,
              PRECIO_OFERTA: offerNum,
              PROMO: promo || "",
              URL: addUTM(target.link, sku),
            },
            items: [],
          });
        }
      }
    }

    let isModelPick = false;
    if (session && session.shownProducts.length) {
      const qNorm = q.replace(/[^a-z0-9]/g, "");
      isModelPick = session.shownProducts.some(p => {
        const model = (p.model || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const title = (p.title || "").toLowerCase();
        if (model && model.length >= 4 && qNorm.includes(model)) return true;
        const qWords = q.split(/\s+/).filter(w => w.length > 2);
        const hit = qWords.filter(w => title.includes(w)).length;
        return qWords.length >= 2 && hit >= 2;
      });
    }

    if (isFollowUp(q) || isModelPick) {
      const tFollow = Date.now();
      const shown = session?.shownProducts || [];
      const shownList = shown.length
        ? `\nLaptops que el cliente YA vio en esta conversacion (puedes referirte a ellas por nombre):\n${shown.map((p, i) => `${i+1}. ${p.title} — ${p.specs || ""}`).join("\n")}`
        : "";
      const histMsgs = session?.history?.slice(-MAGENTO_HISTORY_TURNS) || [];

      const followResp = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 250,
        system: `Eres AnastasIA, asesora de laptops ASUS Colombia. Entiendes la jerga colombiana si el cliente la usa, pero TU respondes en español claro y profesional, sin jerga ni modismos.
El cliente ya vio recomendaciones de laptops y ahora hace una pregunta de seguimiento (envío, garantía, pago, o cuál elegir).${shownList}
REGLAS:
- Responde SOLO la pregunta, en 1-2 frases cortas, español neutro y profesional, sin jerga.
- NO listes tarjetas de producto nuevas. Si el cliente pregunta cual le conviene o elige una de las que vio, puedes mencionarla POR NOMBRE (de la lista de arriba) y dar un criterio breve, pero sin reabrir busqueda.
- Si pregunta por envíos: en Colombia la entrega suele ser 2-3 días hábiles según ciudad.
- Si pregunta por garantía: las laptops ASUS tienen garantía oficial; los detalles los confirma el asesor.
- Si pregunta por pago/financiación o checkout: se manejan varios medios de pago en la tienda; para finalizar la compra el cliente da clic en "Ver producto" y completa el checkout en la tienda. El asesor ayuda con el detalle.
- Si elige un modelo: confirma su eleccion, felicitalo brevemente y dile que puede dar clic en "Ver producto" de esa laptop para comprarla. NO muestres otras.
- Si es un agradecimiento o cierre: responde con cortesía breve y ofrece seguir ayudando.
- Si el cliente reclama que falta un spec que pidio (ej: "pero no tiene i9", "ninguna tiene 32GB"): reconoce con honestidad que ahora mismo no hay en la tienda exactamente ese spec, y explica brevemente por que las que le mostraste igual le sirven (ej: "Cierto, justo ahora no tenemos i9 disponible, pero el Ryzen 7 de la TUF rinde parejito para gaming"). NUNCA digas que una laptop tiene un spec que no tiene.
- IDONEIDAD PARA GAMING (importante): si el cliente pregunta si una laptop especifica sirve para gaming, juzga HONESTAMENTE por su tarjeta grafica:
  - Es buena para gaming SOLO si tiene GPU dedicada NVIDIA (RTX o GTX). Ej: RTX 5050, RTX 4050, RTX 3050.
  - NO es para gaming si tiene graficos integrados (Radeon integrada, Intel Graphics, Intel Arc, Adreno, Radeon Graphics). Estas son para trabajo/estudio. Dilo claro: "esa es mas para trabajo y estudio, no para gaming exigente".
  - Mira la lista de arriba para ver que GPU tiene la laptop por la que preguntan. NUNCA llames "gaming" a una con graficos integrados.
- Devuelve SOLO texto plano, sin JSON, sin markdown.`,
        messages: [...histMsgs, { role: "user", content: query }],
      });
      const followText = (followResp.content[0]?.text || "").trim();
      console.log(`AnastasIA CO follow-up: ${Date.now() - tFollow}ms`);

      if (session) {
        session.history.push({ role: "user", content: query });
        session.history.push({ role: "assistant", content: followText });
        if (session.history.length > MAGENTO_HISTORY_TURNS * 2) session.history = session.history.slice(-MAGENTO_HISTORY_TURNS * 2);
      }

      return res.json({ message: followText, items: [] });
    }

    const profile = session?.profile || { uses: [], budget: null };

    let searchQuery = query;
    const queryLow = query.toLowerCase();
    const useKeyword = { gaming: "gaming", universidad: "universidad", trabajo: "trabajo", diseño: "diseño", portatil: "portatil" };
    profile.uses.forEach(u => {
      const kw = useKeyword[u];
      if (kw && !queryLow.includes(kw) && !USE_PATTERNS[u].test(queryLow)) {
        searchQuery += ` ${kw}`;
      }
    });
    if (profile.budget && !extractBudget(queryLow)) {
      searchQuery += ` ${Math.round(profile.budget / 1000000)} millones`;
    }

    const gamingContext = profile.uses.includes("gaming");

    const relevant = searchProducts(searchQuery, gamingContext);
    if (relevant.length === 0) {
      const budget = extractBudget(query.toLowerCase());
      const cheapest = catalog.reduce((min, p) => {
        const pr = parseFloat(p.price) || 0;
        return (pr > 0 && pr < min) ? pr : min;
      }, Infinity);
      const cheapestTxt = cheapest !== Infinity ? formatCOP(cheapest) : "";
      const noStockPrompt =
        `Eres AnastasIA, asesora de laptops ASUS Colombia. Tono profesional y cercano, en español claro sin jerga ni modismos.
El cliente pidio: "${query}".
SITUACION: en la tienda NO hay ninguna laptop que encaje con ese pedido${budget ? ` (su presupuesto es ${formatCOP(budget)})` : ""}.${cheapestTxt ? ` La laptop mas economica disponible cuesta ${cheapestTxt}.` : ""}
Escribe un mensaje corto (2-3 frases) que:
- Diga con honestidad y sin drama que ahorita no tenemos algo en ese rango/criterio.
- ${budget && cheapestTxt ? `Mencione que las opciones arrancan alrededor de ${cheapestTxt}, por si puede ajustar.` : "Pida un poco mas de detalle (uso o presupuesto) para ayudarle mejor."}
- Pregunte hasta cuanto podria estirar el presupuesto o que ajuste busca.
- NUNCA inventes productos ni precios distintos a los que te di. Solo texto, sin listas.`;
      let msg;
      try {
        const r = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 180,
          system: noStockPrompt,
          messages: [{ role: "user", content: query }],
        });
        msg = (r.content[0]?.text || "").trim();
      } catch {
        msg = "";
      }
      if (!msg) {
        msg = budget
          ? `Parce, ahorita no tengo laptops en ese presupuesto${cheapestTxt ? `; las opciones arrancan alrededor de ${cheapestTxt}` : ""}. ¿Hasta cuánto podrías estirar?`
          : "Parce, cuéntame un poco más (uso y presupuesto) y te busco la mejor opción.";
      }
      if (session) {
        session.history.push({ role: "user", content: query });
        session.history.push({ role: "assistant", content: msg });
      }
      return res.json({ message: msg, items: [] });
    }

    const budgetWords = ["barata","barato","económico","economico","economica","económica","cheap","precio bajo","más barata","mas barata","menor precio","más económica","mas economica","low cost","accesible","pesos","plata","billete"];
    const powerWords  = ["potente","poderosa","poderoso","mejor","top","gama alta","más potente","mas potente","la mejor","lo mejor","high end","berraca","berracas"];
    const isBudget = budgetWords.some(w => q.includes(w));
    const isPower  = powerWords.some(w => q.includes(w));

    const processorMatch = q.match(/\bi[3579]\b/) || q.match(/ryzen\s*[3579]/) || q.match(/core\s*ultra/);
    const gpuMatch       = q.match(/rtx\s*\d{4}/) || q.match(/gtx\s*\d{4}/);

    let specFiltered = relevant;
    if (processorMatch) {
      const proc = processorMatch[0].toLowerCase().replace(/\s+/g, "");
      const w = relevant.filter(p => `${p.title} ${p.description} ${p.model} ${p.link}`.toLowerCase().replace(/\s+/g, "").includes(proc));
      if (w.length > 0) specFiltered = w;
    }
    if (gpuMatch) {
      const gpu = gpuMatch[0].toLowerCase().replace(/\s+/g, "");
      const w = specFiltered.filter(p => `${p.title} ${p.description} ${p.model} ${p.link}`.toLowerCase().replace(/\s+/g, "").includes(gpu));
      if (w.length > 0) specFiltered = w;
    }

    let productsToSend, messageType;
    if (isBudget && specFiltered.length > 0 && specFiltered.length < relevant.length) {
      productsToSend = [...specFiltered].sort((a, b) => (parseFloat(a.price)||999999) - (parseFloat(b.price)||999999)).slice(0, 3);
      messageType = "budget_spec";
    } else if (isBudget) {
      productsToSend = [...relevant].sort((a, b) => (parseFloat(a.price)||999999) - (parseFloat(b.price)||999999)).slice(0, 3);
      messageType = "budget";
    } else if (isPower) {
      productsToSend = [...specFiltered].sort((a, b) => (parseFloat(b.price)||0) - (parseFloat(a.price)||0)).slice(0, 3);
      messageType = "power";
    } else if (specFiltered.length > 0 && specFiltered.length < relevant.length) {
      productsToSend = specFiltered.slice(0, 3);
      messageType = "spec";
    } else {
      const exactMatches = exactMatchProducts(query, relevant);
      if (exactMatches.length > 0) {
        productsToSend = exactMatches.slice(0, 3);
        messageType = "exact";
      } else {
        productsToSend = relevant.slice(0, 3);
        messageType = "noMatch";
      }
    }

    const intentMap = {
      budget_spec: `El cliente busca: "${query}". Encontramos ${productsToSend.length} laptops economicas con esa especificacion, de menor a mayor precio. MESSAGE: frase corta y profesional en español neutro, sin jerga.`,
      budget:      `El cliente busca: "${query}". Encontramos ${productsToSend.length} laptops economicas de menor a mayor precio. MESSAGE: frase corta y profesional en español neutro, sin jerga.`,
      power:       `El cliente busca: "${query}". Encontramos ${productsToSend.length} laptops potentes de mayor a menor precio. MESSAGE: frase corta y profesional en español neutro, sin jerga.`,
      spec:        `El cliente busca: "${query}". Encontramos ${productsToSend.length} laptops con esa especificacion. MESSAGE: frase corta y profesional en español neutro, sin jerga.`,
      exact:       `El cliente busca: "${query}". Hay ${productsToSend.length} productos que coinciden exactamente. MESSAGE: frase corta celebrando que encontramos lo que buscaba.`,
      noMatch:     `El cliente busca: "${query}". No hay productos exactos pero tenemos ${productsToSend.length} alternativas similares. MESSAGE: frase amigable explicando las alternativas. NUNCA copies el texto del cliente en TITLE.`,
    };
    const userMessage = intentMap[messageType];

    const wantedGaming = /(gaming|gamer|jugar|juego|fortnite|valorant|lol)/i.test(searchQuery);
    const sentGaming = productsToSend.some(p => /gaming|tuf|rog|strix|rtx|gtx/i.test(`${p.title} ${p.description}`));
    if (wantedGaming && !sentGaming) {
      const budget = extractBudget(q) || extractBudget(searchQuery.toLowerCase());
      const cheapestGaming = catalog
        .filter(p => /gaming|tuf|rog|strix|rtx|gtx/i.test(`${p.title} ${p.description} ${p.category}`))
        .reduce((min, p) => { const pr = parseFloat(p.price) || 0; return (pr > 0 && pr < min) ? pr : min; }, Infinity);
      const gTxt = cheapestGaming !== Infinity ? formatCOP(cheapestGaming) : "";
      const gPrompt =
        `Eres AnastasIA, asesora de laptops ASUS Colombia, con tono profesional y cercano, en español claro sin jerga ni modismos.
El cliente quiere una laptop para GAMING${budget ? ` con presupuesto de ${formatCOP(budget)}` : ""}.
SITUACION: en ese rango de precio NO hay laptops gaming en la tienda. Las que caben en ese presupuesto son para trabajo/estudio, NO para juegos exigentes.${gTxt ? ` La laptop gaming mas economica disponible cuesta ${gTxt}.` : ""}
Escribe un mensaje corto (2-3 frases) que:
- Reconozca con honestidad que en ese presupuesto no hay laptops gaming de verdad.
- ${gTxt ? `Mencione que las gaming arrancan alrededor de ${gTxt}.` : "Explique que las gaming cuestan un poco mas."}
- Pregunte hasta cuanto podria estirar el presupuesto para conseguirle una gaming real.
- NO ofrezcas laptops de trabajo como si sirvieran para gaming. Solo texto, sin listas, sin inventar precios.`;
      let gMsg;
      try {
        const gr = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 180,
          system: gPrompt,
          messages: [{ role: "user", content: query }],
        });
        gMsg = (gr.content[0]?.text || "").trim();
      } catch { gMsg = ""; }
      if (!gMsg) {
        gMsg = `Parce, en ese presupuesto no tengo laptops gaming de verdad${gTxt ? `; las gaming arrancan alrededor de ${gTxt}` : ""}. ¿Hasta cuánto podrías estirar para conseguirte una que dispare en juegos?`;
      }
      if (session) {
        session.history.push({ role: "user", content: query });
        session.history.push({ role: "assistant", content: gMsg });
      }
      console.log(`🎮 Gaming sin opciones en presupuesto → mensaje honesto, sin tarjetas`);
      return res.json({ message: gMsg, items: [] });
    }
    const useLabel = { gaming: "gaming", universidad: "universidad", trabajo: "trabajo", diseño: "diseño", portatil: "portabilidad" };
    const profileUses = (session?.profile?.uses || []).map(u => useLabel[u] || u);
    const usesNote = profileUses.length > 1
      ? ` El cliente usara la laptop para varias cosas: ${profileUses.join(" y ")}. En "ideal_para" de cada producto refleja los usos que apliquen (ej: "Universidad y gaming"), no solo uno, siempre que el producto sirva para ellos.`
      : "";
    const userMessageFinal = userMessage + usesNote;

    const priorContext = (session && session.shownProducts.length)
      ? `\nCONTEXTO: antes en esta conversacion ya le mostramos estas laptops: ${session.shownProducts.map(p => p.title).join("; ")}. Las de ahora son una nueva seleccion segun lo que acaba de pedir; en el "message" no las repitas como si fueran nuevas marcas, conecta de forma natural con lo que pidio.`
      : "";

    const productList = productsToSend.map((p, i) => {
      const promo = calcPromo(p.regularPrice, p.price);
      const promoHint = promo ? `PROMO_CALCULADO: ${promo}` : `PROMO_CALCULADO: none`;
      return `${i+1}. ${p.title} | Precio oferta: ${p.price} | Precio regular: ${p.regularPrice} | Modelo: ${p.model} | Descripcion: ${p.description.replace(/"/g, "'")} | ${promoHint}`;
    }).join("\n");

    const tClaude = Date.now();
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1100,
      system: `Eres AnastasIA, asesora experta en laptops ASUS Colombia.
TONO: profesional y cercano, como un buen asesor de tienda. Trata al cliente de "tú". Entiendes la jerga colombiana si el cliente la usa (berraca, parce, plata, etc.), pero TU NUNCA respondes con jerga ni modismos: nada de "parce", "berraca", "marica", "chimba", "parcero". Usa español claro, correcto y amable. Evita ser frío o robótico, pero tambien evita lo demasiado coloquial.

CATALOGO (numerado por posicion):
${productList}

REGLAS (sin comillas dobles en ningun valor de texto):
- "message": frase corta, natural y profesional en español neutro. NUNCA copies el texto del cliente. NUNCA menciones otras marcas. NUNCA uses jerga.
  - HONESTIDAD: si el cliente pidio algo especifico (ej: procesador i9, 32GB de RAM, una GPU puntual, una pulgada exacta) y NINGUN producto del catalogo lo cumple, NO finjas que si. Reconoce con naturalidad que ahora mismo no tienes exactamente eso en la tienda y ofrece la alternativa mas cercana explicando por que sirve. Ej: "Parce, justo ahora no tenemos laptops con i9 en la tienda, pero estas con Ryzen 7 y RTX rinden igual de duro para gaming". Sé honesto pero positivo, nunca inventes que un producto tiene un spec que no tiene.
- "title_display": nombre corto del producto, max 40 caracteres.
- Specs clave extraidas de la descripcion (cada una corta, sin la etiqueta):
  - "cpu": procesador. Ej: Ryzen 7 260  o  Core Ultra 7 258V
  - "ram": memoria. Ej: 16GB DDR5  o  32GB LPDDR5X
  - "ssd": almacenamiento. Ej: 1TB SSD  o  512GB SSD
  - "pantalla": tamaño/tipo. Ej: 16 FHD  o  14 OLED  o  15.6pulg
  - "gpu": tarjeta grafica. Ej: RTX 5050  o  RTX 4060  o  Radeon integrada
  - "teclado_espanol": si la descripcion menciona teclado en español/latinoamericano pon "Sí", si menciona retroiluminado puedes poner "Retroiluminado ES". Si NO se menciona, pon "".
  - "en_caja": que incluye la caja si la descripcion lo dice (ej: Cargador y mouse). Si NO se menciona, pon "".
  - REGLA CRITICA: si un dato NO aparece en la descripcion, pon "" (vacio). NUNCA inventes specs.
- "ideal_para": para que tipo de uso brilla, 2-4 palabras. Ej: Gaming y AutoCAD  o  Universidad  o  Diseño y edicion  o  Trabajo diario.
- "tagline": frase corta y vendedora SIN emojis, max 28 chars. Conecta con lo que pidio el cliente. Ej: En oferta  o  Brutal para gaming  o  Perfecta para la u  o  Potencia pura.
- Devuelve SOLO JSON valido sin markdown, en el ORDEN exacto del catalogo:
{"message":"texto","items":[{"title_display":"...","cpu":"...","ram":"...","ssd":"...","pantalla":"...","gpu":"...","teclado_espanol":"...","en_caja":"...","ideal_para":"...","tagline":"..."}]}`,
      messages: [{ role: "user", content: userMessageFinal + priorContext }],
    });
    console.log(`⏱️ Claude API: ${Date.now() - tClaude}ms`);

    const raw = response.content[0].text.trim().replace(/```json|```/g, "").trim();
    let result;
    try {
      result = JSON.parse(raw);
    } catch (parseErr) {
      const lastValid = raw.lastIndexOf("},");
      if (lastValid > 0) {
        try { result = JSON.parse(raw.slice(0, lastValid + 1) + "]}"); console.log(`⚠️ JSON reparado`); }
        catch { throw parseErr; }
      } else { throw parseErr; }
    }

    const claudeItems = Array.isArray(result.items) ? result.items : [];

    const aligned = claudeItems.length === productsToSend.length;
    if (!aligned) console.log(`⚠️ Claude devolvio ${claudeItems.length} items vs ${productsToSend.length} productos — usando datos del catalogo`);

    const mergedItems = productsToSend.map((p, i) => {
      const ci = aligned ? (claudeItems[i] || {}) : {};
      const sku = p.partNumber || p.model;
      const regularNum = parseFloat(p.regularPrice) || parseFloat(p.price) || 0;
      const offerNum   = parseFloat(p.price) || 0;
      const clean = (s) => (s ? String(s).replace(/"/g, "'").trim() : "");
      const specsJoined = [ci.cpu, ci.ram, ci.ssd, ci.pantalla].filter(Boolean).join(" | ")
        || p.description.slice(0, 90);
      return {
        TITLE:                p.title,
        TITLE_DISPLAY:        (ci.title_display || p.title).slice(0, 50),
        PRECIO_REGULAR_FORMAT: formatCOP(regularNum),
        PRECIO_OFERTA_FORMAT:  formatCOP(offerNum),
        PRECIO_REGULAR:        regularNum,
        PRECIO_OFERTA:         offerNum,
        URL:                  addUTM(p.link, sku),
        IMAGEN:               p.image,
        SPECS:                clean(specsJoined),
        CPU:                  clean(ci.cpu),
        RAM:                  clean(ci.ram),
        SSD:                  clean(ci.ssd),
        PANTALLA:             clean(ci.pantalla),
        GPU:                  clean(ci.gpu),
        TECLADO_ES:           clean(ci.teclado_espanol),
        EN_CAJA:              clean(ci.en_caja),
        IDEAL_PARA:           clean(ci.ideal_para),
        TAGLINE:              clean(ci.tagline) || calcPromo(p.regularPrice, p.price) || "",
        PROMO:                clean(ci.tagline) || calcPromo(p.regularPrice, p.price) || formatCOP(offerNum),
      };
    });

    console.log(`✅ AnastasIA CO devuelve ${mergedItems.length} productos · Total: ${Date.now() - tStart}ms`);

    if (session) {
      session.shownProducts = mergedItems.map(it => ({
        title: it.TITLE, model: (productsToSend.find(p => p.title === it.TITLE)?.model) || "",
        specs: [it.CPU, it.RAM, it.SSD, it.PANTALLA, it.GPU].filter(Boolean).join(" | ") || it.SPECS,
      }));
      session.history.push({ role: "user", content: query });
      session.history.push({ role: "assistant", content: (result.message || "") + " [mostre: " + mergedItems.map(i => i.TITLE).join(", ") + "]" });
      if (session.history.length > MAGENTO_HISTORY_TURNS * 2) session.history = session.history.slice(-MAGENTO_HISTORY_TURNS * 2);
    }

    return res.json({ message: result.message || "", items: mergedItems });

  } catch (err) {
    console.error("❌ Error en AnastasIA CO:", err.message);
    const fallback = searchProducts(query).slice(0, 3).map(p => {
      const sku = p.partNumber || p.model;
      return {
        TITLE: p.title, TITLE_DISPLAY: p.title.slice(0, 50),
        PRECIO_REGULAR_FORMAT: formatCOP(parseFloat(p.regularPrice || p.price) || 0),
        PRECIO_OFERTA_FORMAT:  formatCOP(parseFloat(p.price) || 0),
        PRECIO_REGULAR: parseFloat(p.regularPrice || p.price) || 0,
        PRECIO_OFERTA:  parseFloat(p.price) || 0,
        URL: addUTM(p.link, sku), IMAGEN: p.image,
        SPECS: p.description ? p.description.replace(/"/g, "'").slice(0, 90) : "",
        PROMO: calcPromo(p.regularPrice, p.price) || "Visita nuestra tienda ASUS Colombia",
      };
    });
    return res.json({ items: fallback, error_flag: true, error_msg: String(err.message || "").slice(0, 200) });
  }
});

await refreshCatalog();
setInterval(refreshCatalog, CONFIG.FEED_REFRESH_MS);

// ── Keep-alive ping ──────────────────────────────────────────────────
setInterval(async () => {
  try {
    await fetch(`http://localhost:${CONFIG.PORT}/health`);
    console.log("Keep-alive CO");
  } catch (e) {}
}, 5 * 60 * 1000);

app.listen(CONFIG.PORT, () => {
  console.log(`AnastasIA CO corriendo en puerto ${CONFIG.PORT}`);
});
