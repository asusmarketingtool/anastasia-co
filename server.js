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
};

let catalog = [];
const conversations = {};
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Memoria por sesion para Magento (GET /anastasia) ─────────────────
// Igual que el objeto `conversations` de Freshchat, pero para la pagina
// web. Vive en RAM (sin base de datos). Guarda los ultimos turnos y los
// productos mostrados, para que AnastasIA entienda "mas barata que esas",
// reconozca cuando el cliente elige un modelo, y no re-recomiende.
const magentoSessions = {};
const MAGENTO_HISTORY_TURNS = 6;          // cuantos turnos recordar
const MAGENTO_SESSION_TTL_MS = 60 * 60 * 1000; // 1h sin actividad -> se borra

function getSession(id) {
  if (!id) return null;
  const now = Date.now();
  let s = magentoSessions[id];
  if (!s || (now - s.lastSeen) > MAGENTO_SESSION_TTL_MS) {
    s = { history: [], shownProducts: [], lastSeen: now };
    magentoSessions[id] = s;
  }
  s.lastSeen = now;
  return s;
}

// Limpieza periodica de sesiones viejas (evita que la RAM crezca infinito).
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
  "política","gobierno","presidente","elecciones","partido","congreso",
  "religion","religión","dios","iglesia",
  "sexo","pornografía","pornografia","xxx",
  "drogas","cocaína","cocaina","marihuana",
  "hack","hackear","piratear","crackear",
  "receta","comida","cocinar","ingredientes",
  "futbol","fútbol","deporte","partido de",
  "pelicula","película","serie","netflix",
  "música","canción","cancion","letra de",
  "chiste","broma","cuento",
  "noticias","periodico","periódico","novedades del mundo",
];
// Coincidencia por PALABRA COMPLETA (no por fragmento). Evita falsos
// positivos como "buenas" conteniendo "nas", o "descuento" conteniendo
// "cuento". Frases con espacios se buscan tal cual.
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

// ── Follow-up / conversacional (responde sin re-recomendar) ──────────
// Detecta preguntas de seguimiento (envíos, garantía, pago, "cuál me
// conviene") que NO son búsquedas de producto. Solo se usa en GET /anastasia
// (Magento). Freshchat NO pasa por aquí.
function isFollowUp(q) {
  const followUpWords = [
    // envíos / tiempos de entrega
    "cuanto tarda","cuánto tarda","cuanto demora","cuánto demora","cuanto tiempo",
    "cuánto tiempo","tiempo de entrega","tiempo de envio","tiempo de envío",
    "cuando llega","cuándo llega","cuando me llega","dias habiles","días hábiles",
    "envio a","envío a","envian a","envían a","llega a","domicilio","despacho",
    // garantía (info general; daños/repuestos ya los atrapa serviceWords antes)
    "tiene garantia","tiene garantía","cuanta garantia","cuánta garantía",
    "anos de garantia","años de garantía","cubre la garantia","cubre la garantía",
    // pago / financiación (info general)
    "formas de pago","medios de pago","puedo pagar","aceptan","cuotas","financiacion",
    "financiación","tarjeta de credito","tarjeta de crédito","addi","sistecredito",
    "como es el checkout","checkout","como compro","cómo compro","como pago","cómo pago",
    "proceso de compra","como finalizo","cómo finalizo","como hago la compra","carrito",
    "factura","facturacion","facturación","datacredito","pse","contraentrega","contra entrega",
    // referencia a lo ya mostrado
    "cual me conviene","cuál me conviene","cual es mejor","cuál es mejor",
    "cual recomiendas","cuál recomiendas","de esas","de estas","de las que",
    "la primera","la segunda","la tercera","esa cual","cual de las",
    "diferencia entre","comparalas","compáralas","cual elijo","cuál elijo",
    // preguntas de idoneidad sobre las que ya mostro (referencia con demostrativos)
    "estas sirven","estas son buenas","estas son aptas","estas funcionan",
    "estos sirven","estos son buenos","estas siguen","estos siguen",
    "siguen siendo buenas","siguen siendo buenos","esas sirven","esas son buenas",
    "estas valen","estas aguantan","estos aguantan","estas corren","estos corren",
    // cortesía / cierre
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
    console.log("🔄 Actualizando catálogo CO...");
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

      // ── Filtrar accesorios: el feed trae cases, mochilas, mouse, etc.
      // que NO son laptops. Sin esto, un case barato se cuela como
      // "alternativa economica" y rompe la recomendacion.
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

      // Handhelds (ROG Ally / XBOX Ally) NO son laptops y no estan en stock.
      // Cuestan >$1M asi que el piso de precio no los atrapa; se filtran aqui.
      const handheldWords = ["ally","xbox ally","rog ally","steam deck","handheld"];
      if (handheldWords.some(w => t.includes(w))) return false;

      // Piso de precio: ninguna laptop ASUS en COP baja de ~$1.000.000.
      // Accesorios (cases, mouse) estan muy por debajo -> se descartan.
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

function searchProducts(query) {
  const q = query.toLowerCase();
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
  const results = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, CONFIG.MAX_PRODUCTS_IN_PROMPT).map(s => s.product);
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
  return `${formatCOP(regular)} → ${formatCOP(offer)} ⚡ ¡Oferta!`;
}

async function askClaude(conversationId, userMessage) {
  const relevant = searchProducts(userMessage);
  if (!conversations[conversationId]) conversations[conversationId] = [];
  const history = conversations[conversationId];
  const productList = relevant.map(p => `• ${p.title} — ${p.price}${p.link ? ` | URL: ${p.link}` : ""}`).join("\n");
  const systemPrompt = `Eres un asistente de ventas amigable y experto de esta tienda online ASUS Colombia.
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
    console.log(`💬 [${conversationId}] Usuario: ${userMessage}`);
    const reply = await askClaude(conversationId, userMessage);
    console.log(`🤖 [${conversationId}] Claude: ${reply.slice(0, 80)}...`);
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
  const session = getSession(sessionId); // null si no mandan session
  console.log(`🤖 AnastasIA CO consulta: "${query}"${sessionId ? ` [${sessionId}]` : ""}`);
  if (!query) return res.json({ items: [] });

  // ── Guardrail 0: URL detector ────────────────────────────────────
  if (query.startsWith("http://") || query.startsWith("https://")) {
    return res.json({
      message: "Solo puedo ayudarte con recomendaciones de laptops ASUS. ¿Qué tipo de laptop estás buscando?",
      items: [{ TITLE: "Explora nuestras laptops ASUS", TITLE_DISPLAY: "Ver laptops disponibles", PRECIO_REGULAR_FORMAT: "", PRECIO_OFERTA_FORMAT: "", PRECIO_REGULAR: 0, PRECIO_OFERTA: 0, URL: "https://www.asus.com/co/store/", IMAGEN: "https://dlcdnwebimgs.asus.com/gain/34B7D53B-C42E-4F15-8B95-7EDA7F64F22C/w800", SPECS: "Gaming · Trabajo · Universidad · Diseño", PROMO: "Encuentra tu laptop ideal hoy" }]
    });
  }

  // ── Guardrail 1: Query length ────────────────────────────────────
  if (query.length > CONFIG.MAX_QUERY_LENGTH) {
    return res.json({
      message: "Tu mensaje es muy largo. Por favor escribe una consulta más corta.",
      items: [{ TITLE: "Explora nuestras laptops ASUS", TITLE_DISPLAY: "Ver laptops disponibles", PRECIO_REGULAR_FORMAT: "", PRECIO_OFERTA_FORMAT: "", PRECIO_REGULAR: 0, PRECIO_OFERTA: 0, URL: "https://www.asus.com/co/store/", IMAGEN: "https://dlcdnwebimgs.asus.com/gain/34B7D53B-C42E-4F15-8B95-7EDA7F64F22C/w800", SPECS: "Gaming · Trabajo · Universidad · Diseño", PROMO: "Encuentra tu laptop ideal hoy" }]
    });
  }

  // ── Guardrail 2: Rate limiting ───────────────────────────────────
  if (isRateLimited(ip)) {
    return res.json({
      message: "Has hecho varias consultas seguidas. Dame un momentico y vuelve a intentar — o si prefieres, habla directo con un asesor.",
      escalate: true,
      items: []
    });
  }

  // ── Guardrail 3: Spam detection ──────────────────────────────────
  if (isSpam(ip, query)) {
    return res.json({
      message: "Parece que estás repitiendo la misma búsqueda. ¿Puedo ayudarte con algo más específico?",
      items: [{ TITLE: "Explora nuestras laptops ASUS", TITLE_DISPLAY: "Ver laptops disponibles", PRECIO_REGULAR_FORMAT: "", PRECIO_OFERTA_FORMAT: "", PRECIO_REGULAR: 0, PRECIO_OFERTA: 0, URL: "https://www.asus.com/co/store/", IMAGEN: "https://dlcdnwebimgs.asus.com/gain/34B7D53B-C42E-4F15-8B95-7EDA7F64F22C/w800", SPECS: "Gaming · Trabajo · Universidad · Diseño", PROMO: "Encuentra tu laptop ideal hoy" }]
    });
  }

  // ── Guardrail 4: Off-topic detection ─────────────────────────────
  if (isOffTopic(query)) {
    return res.json({
      message: "Solo puedo ayudarte con laptops ASUS. ¿Estás buscando una laptop para gaming, trabajo, universidad o diseño?",
      items: [{ TITLE: "Explora nuestras laptops ASUS", TITLE_DISPLAY: "Ver laptops disponibles", PRECIO_REGULAR_FORMAT: "", PRECIO_OFERTA_FORMAT: "", PRECIO_REGULAR: 0, PRECIO_OFERTA: 0, URL: "https://www.asus.com/co/store/", IMAGEN: "https://dlcdnwebimgs.asus.com/gain/34B7D53B-C42E-4F15-8B95-7EDA7F64F22C/w800", SPECS: "Gaming · Trabajo · Universidad · Diseño", PROMO: "Encuentra tu laptop ideal hoy" }]
    });
  }

  try {
    const q = query.toLowerCase();

    // ── Sales redirect ───────────────────────────────────────────────
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

    // ── Service redirect ─────────────────────────────────────────────
    const serviceWords = [
      "cargador","cargadora","charger","cable carga","adaptador","fuente de poder",
      "bateria hinchada","bateria de repuesto","cambio de bateria",
      "pantalla rota","reemplazo de pantalla","cambio de pantalla","pantalla de repuesto",
      "reparacion","reparación","repair","repuesto","repuestos","spare part","pieza","componente",
      "arreglar","arreglo","tecnico","técnico","servicio tecnico","servicio técnico",
      "motherboard","motherboards","placa madre","placas madre","tarjeta madre","tarjetas madre",
      "tarjeta grafica","tarjeta gráfica","graphics card","gpu externa",
      "psu","fuente de alimentacion","fuente de alimentación",
      "ram suelta","memoria ram suelta","disco duro","hdd",
      "gabinete","case pc","ventilador","cooler",
      "celular","telefono","teléfono","smartphone","iphone","samsung","xiaomi",
      "garantia","garantía","warranty",
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

    // ── ROG Ally redirect ────────────────────────────────────────────
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

    // ── Non-laptop redirect ──────────────────────────────────────────
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

    // ── Ficha tecnica completa de UN modelo ──────────────────────────
    // Si el cliente pide "specs completos / ficha tecnica" de un modelo,
    // devolvemos una tarjeta de ficha (specSheet) en vez de texto plano.
    const wantsFullSpecs = hasWord(q, [
      "specs completos","especificaciones completas","ficha tecnica","ficha técnica",
      "todos los specs","todas las especificaciones","specs de","especificaciones de",
      "caracteristicas completas","características completas","detalles tecnicos","detalles técnicos",
      "ficha completa","specs completas",
    ]);
    if (wantsFullSpecs) {
      // Resolver a que producto se refiere: primero entre los ya mostrados,
      // si no, buscar en el catalogo.
      let target = null;
      const qNorm = q.replace(/[^a-z0-9]/g, "");
      const pool = (session && session.shownProducts.length)
        ? session.shownProducts.map(sp => catalog.find(c => c.title === sp.title)).filter(Boolean)
        : [];
      const candidates = pool.length ? pool : searchProducts(query);
      // Puntuar TODOS los candidatos y quedarnos con el mejor (no el primero
      // que pase el umbral), para que "a15" gane sobre "a16" si pedis la a15.
      const scoreOf = (p) => {
        const model = (p.model || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const title = (p.title || "").toLowerCase();
        const qWords = q.split(/\s+/).filter(w => w.length > 2);
        let sc = qWords.filter(w => title.includes(w.replace(/[?¿!¡.,]/g, ""))).length;
        if (model && model.length >= 4 && qNorm.includes(model)) sc += 5; // match por part-number = fuerte
        return sc;
      };
      let best = null, bestScore = 0;
      for (const p of candidates) {
        const sc = scoreOf(p);
        if (sc > bestScore) { bestScore = sc; best = p; }
      }
      target = (bestScore >= 2) ? best : null;
      // "specs de esta/esta laptop" sin nombre claro -> usar la ultima mostrada
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
{"intro":"1 frase corta presentando la laptop","specs":[{"label":"Procesador","value":"..."},{"label":"Memoria RAM","value":"..."},{"label":"Almacenamiento","value":"..."},{"label":"Pantalla","value":"..."},{"label":"Tarjeta grafica","value":"..."},{"label":"Sistema operativo","value":"..."}],"porque":"parrafo de 2-3 frases en español colombiano explicando por que es buena opcion y para que usos brilla (gaming, AutoCAD, universidad, diseño). Natural y vendedor sin exagerar."}
REGLAS: solo specs que aparezcan en la descripcion; si un spec no esta, omite ese objeto del array (no lo inventes). Incluye RAM ampliable si se menciona. Sin comillas dobles dentro de los valores.`,
          messages: [{ role: "user", content: query }],
        });
        console.log(`📋 Ficha tecnica: ${Date.now() - tSheet}ms`);
        let sheet;
        try {
          let rawSheet = sheetResp.content[0].text.trim().replace(/```json|```/g, "").trim();
          sheet = JSON.parse(rawSheet);
        } catch {
          // Fallback: armar la ficha desde la descripcion del catalogo,
          // para NO caer al texto plano. Siempre sale la tarjeta.
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
          // guardar turno en memoria
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
        // si fallo el JSON, cae al follow-up normal abajo
      }
    }

    // ── Deteccion de "eligio un modelo que ya vio" ───────────────────
    // Si el cliente escribe el nombre de una laptop que YA le mostramos,
    // no es una busqueda nueva: esta eligiendo. Lo tratamos como follow-up
    // para confirmar su eleccion en vez de re-recomendar.
    let isModelPick = false;
    if (session && session.shownProducts.length) {
      const qNorm = q.replace(/[^a-z0-9]/g, "");
      isModelPick = session.shownProducts.some(p => {
        const model = (p.model || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const title = (p.title || "").toLowerCase();
        // match por modelo (ej "fa506ncg") o por nombre comercial corto del titulo
        if (model && model.length >= 4 && qNorm.includes(model)) return true;
        // match por nombre tipo "tuf gaming a15" presente en el titulo
        const qWords = q.split(/\s+/).filter(w => w.length > 2);
        const hit = qWords.filter(w => title.includes(w)).length;
        return qWords.length >= 2 && hit >= 2;
      });
    }

    // ── Follow-up / conversacional (responde sin re-recomendar) ──────
    // Va DESPUÉS de los redirects de asesor/servicio (para que escalen bien)
    // y ANTES de searchProducts (para cortar el camino del producto).
    if (isFollowUp(q) || isModelPick) {
      const tFollow = Date.now();

      // Contexto de memoria: que laptops ya vio el cliente, para que pueda
      // responder "cual me conviene" / "la primera" refiriendose a modelos reales.
      const shown = session?.shownProducts || [];
      const shownList = shown.length
        ? `\nLaptops que el cliente YA vio en esta conversacion (puedes referirte a ellas por nombre):\n${shown.map((p, i) => `${i+1}. ${p.title} — ${p.specs || ""}`).join("\n")}`
        : "";

      // Historial reciente para que la respuesta tenga continuidad.
      const histMsgs = session?.history?.slice(-MAGENTO_HISTORY_TURNS) || [];

      const followResp = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 250,
        system: `Eres AnastasIA, asesora de laptops ASUS Colombia. Entiendes colombianismos pero respondes amigable y profesional.
El cliente ya vio recomendaciones de laptops y ahora hace una pregunta de seguimiento (envío, garantía, pago, o cuál elegir).${shownList}
REGLAS:
- Responde SOLO la pregunta, en 1-2 frases cortas, español colombiano natural.
- NO listes tarjetas de producto nuevas. Si el cliente pregunta cual le conviene o elige una de las que vio, puedes mencionarla POR NOMBRE (de la lista de arriba) y dar un criterio breve, pero sin reabrir busqueda.
- Si pregunta por envíos: en Colombia la entrega suele ser 2-3 días hábiles según ciudad.
- Si pregunta por garantía: las laptops ASUS tienen garantía oficial; los detalles los confirma el asesor.
- Si pregunta por pago/financiación o checkout: se manejan varios medios de pago en la tienda; para finalizar la compra el cliente da clic en "Ver producto" y completa el checkout en la tienda. El asesor ayuda con el detalle.
- Si elige un modelo: confirma su eleccion, felicitalo brevemente y dile que puede dar clic en "Ver producto" de esa laptop para comprarla. NO muestres otras.
- Si es un agradecimiento o cierre: responde con cortesía breve y ofrece seguir ayudando.
- Devuelve SOLO texto plano, sin JSON, sin markdown.`,
        messages: [...histMsgs, { role: "user", content: query }],
      });
      const followText = (followResp.content[0]?.text || "").trim();
      console.log(`💬 AnastasIA CO follow-up: ${Date.now() - tFollow}ms`);

      // Guardar el turno en memoria.
      if (session) {
        session.history.push({ role: "user", content: query });
        session.history.push({ role: "assistant", content: followText });
        if (session.history.length > MAGENTO_HISTORY_TURNS * 2) session.history = session.history.slice(-MAGENTO_HISTORY_TURNS * 2);
      }

      return res.json({ message: followText, items: [] });
    }

    // ── Search products ──────────────────────────────────────────────
    const relevant = searchProducts(query);
    if (relevant.length === 0) return res.json({ items: [] });

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

    // ── User message by intent ───────────────────────────────────────
    const intentMap = {
      budget_spec: `El cliente busca: "${query}". Encontramos ${productsToSend.length} laptops economicas con esa especificacion, de menor a mayor precio. MESSAGE: frase corta en español colombiano.`,
      budget:      `El cliente busca: "${query}". Encontramos ${productsToSend.length} laptops economicas de menor a mayor precio. MESSAGE: frase corta en español colombiano.`,
      power:       `El cliente busca: "${query}". Encontramos ${productsToSend.length} laptops potentes de mayor a menor precio. MESSAGE: frase corta en español colombiano.`,
      spec:        `El cliente busca: "${query}". Encontramos ${productsToSend.length} laptops con esa especificacion. MESSAGE: frase corta en español colombiano.`,
      exact:       `El cliente busca: "${query}". Hay ${productsToSend.length} productos que coinciden exactamente. MESSAGE: frase corta celebrando que encontramos lo que buscaba.`,
      noMatch:     `El cliente busca: "${query}". No hay productos exactos pero tenemos ${productsToSend.length} alternativas similares. MESSAGE: frase amigable explicando las alternativas. NUNCA copies el texto del cliente en TITLE.`,
    };
    const userMessage = intentMap[messageType];

    // Contexto de memoria: si ya mostramos laptops antes, decirle a Claude
    // cuales fueron para que el "message" no repita ni ignore lo anterior
    // (ej. el cliente pidio "mas barata" -> Claude sabe respecto a que).
    const priorContext = (session && session.shownProducts.length)
      ? `\nCONTEXTO: antes en esta conversacion ya le mostramos estas laptops: ${session.shownProducts.map(p => p.title).join("; ")}. Las de ahora son una nueva seleccion segun lo que acaba de pedir; en el "message" no las repitas como si fueran nuevas marcas, conecta de forma natural con lo que pidio.`
      : "";

    // ── Build product list — only what Claude needs ──────────────────
    const productList = productsToSend.map((p, i) => {
      const promo = calcPromo(p.regularPrice, p.price);
      const promoHint = promo ? `PROMO_CALCULADO: ${promo}` : `PROMO_CALCULADO: none`;
      return `${i+1}. ${p.title} | Precio oferta: ${p.price} | Precio regular: ${p.regularPrice} | Modelo: ${p.model} | Descripcion: ${p.description.replace(/"/g, "'")} | ${promoHint}`;
    }).join("\n");

    // ── Claude call — JSON enriquecido por item ──────────────────────
    const tClaude = Date.now();
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1100,
      system: `Eres AnastasIA, experta en laptops ASUS para clientes colombianos.
Entiende colombianismos (berraca, parce, plata, billete, la u, pega, etc.) pero responde amigable y profesional.

CATALOGO (numerado por posicion):
${productList}

REGLAS (sin comillas dobles en ningun valor de texto):
- "message": frase corta y natural en español colombiano. NUNCA copies el texto del cliente. NUNCA menciones otras marcas.
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
- "tagline": frase corta y vendedora con emoji, max 28 chars. Conecta con lo que pidio el cliente. Ej: ⚡ En oferta  o  🎮 Brutal para gaming  o  🎓 Perfecta para la u  o  💪 Potencia pura.
- Devuelve SOLO JSON valido sin markdown, en el ORDEN exacto del catalogo:
{"message":"texto","items":[{"title_display":"...","cpu":"...","ram":"...","ssd":"...","pantalla":"...","gpu":"...","teclado_espanol":"...","en_caja":"...","ideal_para":"...","tagline":"..."}]}`,
      messages: [{ role: "user", content: userMessage + priorContext }],
    });
    console.log(`⏱️ Claude API: ${Date.now() - tClaude}ms`);

    // ── Parse JSON ───────────────────────────────────────────────────
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

    // ── Merge Claude output with catalog data ────────────────────────
    const claudeItems = Array.isArray(result.items) ? result.items : [];

    // Si Claude no devolvio exactamente un item por producto, su orden NO es
    // confiable: pegar title/specs por indice mezclaria un producto con otro
    // (ej. titulo de laptop sobre URL de un case). En ese caso ignoramos el
    // texto de Claude y usamos los datos del propio producto del catalogo.
    const aligned = claudeItems.length === productsToSend.length;
    if (!aligned) console.log(`⚠️ Claude devolvio ${claudeItems.length} items vs ${productsToSend.length} productos — usando datos del catalogo`);

    const mergedItems = productsToSend.map((p, i) => {
      const ci = aligned ? (claudeItems[i] || {}) : {};
      const sku = p.partNumber || p.model;
      const regularNum = parseFloat(p.regularPrice) || parseFloat(p.price) || 0;
      const offerNum   = parseFloat(p.price) || 0;
      const clean = (s) => (s ? String(s).replace(/"/g, "'").trim() : "");
      // SPECS unificado (compat con cualquier render viejo) a partir de los campos.
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

    // ── Guardar en memoria: productos mostrados + turno de conversacion ──
    if (session) {
      session.shownProducts = mergedItems.map(it => ({
        title: it.TITLE, model: (productsToSend.find(p => p.title === it.TITLE)?.model) || "", specs: it.SPECS,
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
    // error_flag avisa al frontend que esto fue un fallback (para trackear).
    return res.json({ items: fallback, error_flag: true, error_msg: String(err.message || "").slice(0, 200) });
  }
});

await refreshCatalog();
setInterval(refreshCatalog, CONFIG.FEED_REFRESH_MS);

// ── Keep-alive ping ──────────────────────────────────────────────────
setInterval(async () => {
  try {
    await fetch(`http://localhost:${CONFIG.PORT}/health`);
    console.log("💓 Keep-alive CO");
  } catch (e) {}
}, 5 * 60 * 1000);

app.listen(CONFIG.PORT, () => {
  console.log(`🚀 AnastasIA CO corriendo en puerto ${CONFIG.PORT}`);
});
