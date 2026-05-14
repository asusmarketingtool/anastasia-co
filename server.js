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
  RATE_LIMIT_MAX: 10,
  RATE_LIMIT_WINDOW_MS: 60 * 60 * 1000,
  MAX_QUERY_LENGTH: 300,
};

let catalog = [];
const conversations = {};
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
function isOffTopic(query) {
  const q = query.toLowerCase();
  return offTopicWords.some(w => q.includes(w));
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
        id: val(item.Part_Number) || val(item.Model) || "",
        title: val(item.Name) || val(item.title) || "",
        description: stripHtml(val(item.Short_Description) || val(item.description) || ""),
        price: val(item.Offer_Price) || val(item.Regular_Price) || val(item.price) || "",
        regularPrice: val(item.Regular_Price) || "",
        link: val(item.Product_URL) || val(item.link) || "",
        image: val(item.Main_Image_URL) || val(item.image) || "",
        brand: "ASUS",
        model: val(item.Model) || "",
        partNumber: val(item.Part_Number) || "",
        category: val(item.BU) || val(item.category) || "",
        availability: val(item.Availability) || val(item.availability) || "in stock",
      };
    }).filter(p => {
      if (!p.title) return false;
      const regular = parseFloat(p.regularPrice) || 0;
      const offer = parseFloat(p.price) || 0;
      if (regular > 0 && offer > 0 && (offer / regular) < 0.5) return false;
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

function formatProductsForPrompt(products) {
  if (products.length === 0) return "No encontré productos que coincidan exactamente.";
  return products.map(p => `• ${p.title}${p.brand ? ` (${p.brand})` : ""} — ${p.price}${p.category ? ` | Categoría: ${p.category}` : ""}${p.link ? ` | URL: ${p.link}` : ""}`).join("\n");
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
  const productList = formatProductsForPrompt(relevant);
  if (!conversations[conversationId]) conversations[conversationId] = [];
  const history = conversations[conversationId];
  const systemPrompt = `Eres un asistente de ventas amigable y experto de esta tienda online.
Tu objetivo es ayudar al cliente a encontrar el producto perfecto según sus necesidades.
PRODUCTOS DISPONIBLES AHORA MISMO (en stock):
${productList}
INSTRUCCIONES:
- Si no tienes suficiente información del cliente, haz UNA pregunta específica para entender mejor qué necesita.
- Cuando recomiendas, explica brevemente POR QUÉ ese producto encaja con lo que pidió.
- Recomienda máximo 2-3 productos. Siempre incluye el link del producto.
- Si el producto no está en la lista de disponibles, no lo menciones.
- Responde siempre en el mismo idioma en que te escribe el cliente.
- Sé conciso: respuestas cortas, conversacionales.`;
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
  const query = req.query.q || req.query.query || req.query.busqueda || "";
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  console.log(`🤖 AnastasIA CO consulta: "${query}"`);
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
      message: "Has realizado demasiadas consultas en poco tiempo. Por favor espera unos minutos e intenta de nuevo.",
      items: [{ TITLE: "Servicio al Cliente ASUS Colombia", TITLE_DISPLAY: "Contáctanos directamente", PRECIO_REGULAR_FORMAT: "", PRECIO_OFERTA_FORMAT: "", PRECIO_REGULAR: 0, PRECIO_OFERTA: 0, URL: "https://www.asus.com/co/support/", IMAGEN: "https://www.asus.com/media/global/gallery/lVTlQHxDPCyHhWVU_setting_fff_1_90_end_1000.png", SPECS: "Lunes-Viernes 07:30-18:00 · Sábado 08:00-13:00", PROMO: "(601) 241 55 28" }]
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
    if (salesWords.some(w => q.includes(w))) {
      console.log(`💼 Consulta de ventas de IP ${ip}: "${query}"`);
      return res.json({
        message: "Para consultas sobre cupones, pedidos o promociones, nuestros asesores de ventas pueden ayudarte. Reinicia el chat y selecciona 'Hablar con un asesor', o escríbenos a soporteventas.co@asus.com",
        items: [{ TITLE: "Asesores de Ventas ASUS Colombia", TITLE_DISPLAY: "Contactar asesor de ventas", PRECIO_REGULAR_FORMAT: "", PRECIO_OFERTA_FORMAT: "", PRECIO_REGULAR: 0, PRECIO_OFERTA: 0, URL: "https://www.asus.com/co/store/", IMAGEN: "https://dlcdnwebimgs.asus.com/gain/34B7D53B-C42E-4F15-8B95-7EDA7F64F22C/w800", SPECS: "Lunes-Viernes 07:30-18:00 · Sábado 08:00-13:00", PROMO: "soporteventas.co@asus.com" }]
      });
    }

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
      "ups","no break","estabilizador",
      "proyector","smartwatch","reloj inteligente"
    ];

    const mentionsBattery = /\b(bateria|batería|battery|pila)\b/.test(q);
    const batteryProblem = mentionsBattery && /(hinchada|no carga|no funciona|repuesto|reemplaz|rota|muerta|dañ|estallad|inflada)/.test(q);
    const batteryFeature = mentionsBattery && /(duracion|duración|autonomia|autonomía|horas|dura|larga|buena|precio|hasta|pesos|millones|busco|quiero|recomienda|presupuesto)/.test(q);
    const isServiceRequest = serviceWords.some(w => q.includes(w)) || (batteryProblem && !batteryFeature);

    if (isServiceRequest) {
      return res.json({
        message: "Lo sentimos, este producto o servicio no está disponible en nuestra tienda online ASUS Colombia. Para más información contacta a nuestro equipo de soporte técnico:",
        items: [{ TITLE: "Servicio al Cliente ASUS Colombia", TITLE_DISPLAY: "Contáctanos para ayudarte", PRECIO_REGULAR_FORMAT: "", PRECIO_OFERTA_FORMAT: "", PRECIO_REGULAR: 0, PRECIO_OFERTA: 0, URL: "https://www.asus.com/co/support/", IMAGEN: "https://www.asus.com/media/global/gallery/lVTlQHxDPCyHhWVU_setting_fff_1_90_end_1000.png", SPECS: "Lunes-Viernes 07:30-18:00 · Sábado 08:00-13:00", PROMO: "(601) 241 55 28" }]
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
      "parlante","bocina","altavoz"
    ];
    const isNonLaptop = nonLaptopWords.some(w => q.includes(w)) ||
      (q.includes("monitor") && !q.includes("laptop") && !q.includes("pantalla de laptop"));
    if (isNonLaptop) {
      return res.json({
        message: "Por el momento solo contamos con laptops ASUS en nuestra tienda online en Colombia. ¿Te ayudo a encontrar la laptop perfecta para ti?",
        items: [{ TITLE: "Explora nuestras laptops ASUS", TITLE_DISPLAY: "Ver laptops disponibles", PRECIO_REGULAR_FORMAT: "", PRECIO_OFERTA_FORMAT: "", PRECIO_REGULAR: 0, PRECIO_OFERTA: 0, URL: "https://www.asus.com/co/store/", IMAGEN: "https://dlcdnwebimgs.asus.com/gain/34B7D53B-C42E-4F15-8B95-7EDA7F64F22C/w800", SPECS: "Gaming · Trabajo · Universidad · Diseño", PROMO: "Encuentra tu laptop ideal hoy" }]
      });
    }

    const relevant = searchProducts(query);
    if (relevant.length === 0) return res.json({ items: [] });

    const budgetWords = ["barata","barato","económico","economico","economica","económica","cheap","precio bajo","más barata","mas barata","menor precio","más económica","mas economica","low cost","accesible","pesos","plata","billete"];
    const powerWords = ["potente","poderosa","poderoso","mejor","top","gama alta","más potente","mas potente","la mejor","lo mejor","high end","berraca","berracas"];
    const isBudget = budgetWords.some(w => q.includes(w));
    const isPower = powerWords.some(w => q.includes(w));

    const processorMatch = q.match(/\bi[3579]\b/) || q.match(/ryzen\s*[3579]/) || q.match(/core\s*ultra/);
    const gpuMatch = q.match(/rtx\s*\d{4}/) || q.match(/gtx\s*\d{4}/);

    let specFiltered = relevant;
    if (processorMatch) {
      const proc = processorMatch[0].toLowerCase().replace(/\s+/g, "");
      const withSpec = relevant.filter(p => `${p.title} ${p.description} ${p.model} ${p.link}`.toLowerCase().replace(/\s+/g, "").includes(proc));
      if (withSpec.length > 0) specFiltered = withSpec;
    }
    if (gpuMatch) {
      const gpu = gpuMatch[0].toLowerCase().replace(/\s+/g, "");
      const withGpu = specFiltered.filter(p => `${p.title} ${p.description} ${p.model} ${p.link}`.toLowerCase().replace(/\s+/g, "").includes(gpu));
      if (withGpu.length > 0) specFiltered = withGpu;
    }

    let productsToSend, exactCount, messageType;

    if (isBudget && specFiltered.length > 0 && specFiltered.length < relevant.length) {
      productsToSend = [...specFiltered].sort((a, b) => (parseFloat(a.price) || 999999) - (parseFloat(b.price) || 999999)).slice(0, 3);
      exactCount = productsToSend.length; messageType = "budget_spec";
    } else if (isBudget) {
      productsToSend = [...relevant].sort((a, b) => (parseFloat(a.price) || 999999) - (parseFloat(b.price) || 999999)).slice(0, 3);
      exactCount = productsToSend.length; messageType = "budget";
    } else if (isPower) {
      productsToSend = [...specFiltered].sort((a, b) => (parseFloat(b.price) || 0) - (parseFloat(a.price) || 0)).slice(0, 3);
      exactCount = productsToSend.length; messageType = "power";
    } else if (specFiltered.length > 0 && specFiltered.length < relevant.length) {
      productsToSend = specFiltered.slice(0, 3); exactCount = productsToSend.length; messageType = "spec";
    } else {
      const exactMatches = exactMatchProducts(query, relevant);
      if (exactMatches.length > 0) {
        productsToSend = exactMatches.slice(0, 3); exactCount = productsToSend.length; messageType = "exact";
      } else {
        productsToSend = relevant.slice(0, 3); exactCount = 0; messageType = "noMatch";
      }
    }

    let userMessage;
    if (messageType === "budget_spec") {
      userMessage = `El cliente busca: "${query}". Encontramos ${productsToSend.length} laptops economicas con esa especificacion, ordenadas de menor a mayor precio. Muestralas TODAS. MESSAGE: frase corta en español colombiano.`;
    } else if (messageType === "budget") {
      userMessage = `El cliente busca: "${query}". Encontramos ${productsToSend.length} laptops economicas ordenadas de menor a mayor precio. Muestralas TODAS. MESSAGE: frase corta en español colombiano.`;
    } else if (messageType === "power") {
      userMessage = `El cliente busca: "${query}". Encontramos ${productsToSend.length} laptops potentes ordenadas de mayor a menor precio. Muestralas TODAS. MESSAGE: frase corta en español colombiano.`;
    } else if (messageType === "spec") {
      userMessage = `El cliente busca: "${query}". Encontramos ${productsToSend.length} laptops con esa especificacion. Muestra SOLO esas. MESSAGE: frase corta en español colombiano.`;
    } else if (messageType === "exact") {
      userMessage = `El cliente busca: "${query}". Hay ${exactCount} productos que coinciden exactamente. Muestra SOLO esos ${exactCount}. MESSAGE: frase corta celebrando que encontramos lo que buscaba.`;
    } else {
      userMessage = `El cliente busca: "${query}". No hay productos exactos pero tenemos ${productsToSend.length} alternativas similares. Muestralas TODAS. MESSAGE: frase amigable en español colombiano explicando que son alternativas similares. NUNCA copies el texto del cliente en el TITLE.`;
    }

    const productList = productsToSend.map((p, i) => {
      const promo = calcPromo(p.regularPrice, p.price);
      const promoHint = promo ? `PROMO_CALCULADO: ${promo}` : `PROMO_CALCULADO: none`;
      const sku = p.partNumber || p.model;
      return `${i+1}. ${p.title} | Precio oferta: ${p.price} | Precio regular: ${p.regularPrice} | Modelo: ${p.model} | URL: ${addUTM(p.link, sku)} | Imagen: ${p.image} | Descripcion: ${p.description.replace(/"/g, "'")} | ${promoHint}`;
    }).join("\n");

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2500,
      system: `Eres AnastasIA, experta en laptops ASUS para clientes colombianos.
El cliente puede escribir con errores ortograficos o español informal. Entiende colombianismos pero responde siempre de forma amigable y profesional.
TONO: Amigable y profesional con calidez colombiana. Puedes usar expresiones como "berraca" o "esta muy buena" ocasionalmente.

CATALOGO DISPONIBLE:
${productList}

INSTRUCCIONES ESTRICTAS:
- El campo TITLE siempre debe ser el nombre real del producto del catalogo
- NUNCA menciones marcas competidoras como Lenovo, HP, Dell, Acer, Samsung, Apple, MSI
- El campo MESSAGE debe ser siempre una frase natural y amigable, nunca una copia del texto del cliente
- Para SPECS extrae SOLO: procesador | RAM | GPU | almacenamiento | tamaño pantalla. NUNCA uses comillas dobles. Maximo 90 caracteres
- Los precios son en pesos colombianos COP con formato $23.999.900
- Para PROMO: si PROMO_CALCULADO no es none usalo como base y agrega tagline corto con emoji. Si es none escribe precio + emoji + frase corta.
- Sin comillas dobles internas en ningun campo de texto.
- Devuelve SOLO JSON valido sin markdown:
{"message":"texto","items":[{"TITLE":"nombre completo","TITLE_DISPLAY":"nombre corto max 40 chars","PRECIO_REGULAR_FORMAT":"$23.999.900","PRECIO_OFERTA_FORMAT":"$19.999.900","PRECIO_REGULAR":23999900,"PRECIO_OFERTA":19999900,"URL":"url","IMAGEN":"url imagen","SPECS":"specs max 90 chars","PROMO":"promo max 50 chars"}]}`,
      messages: [{ role: "user", content: userMessage }],
    });

    const raw = response.content[0].text.trim().replace(/```json|```/g, "").trim();
    let result;
    try {
      result = JSON.parse(raw);
    } catch (parseErr) {
      const lastValidItem = raw.lastIndexOf("},");
      if (lastValidItem > 0) {
        const repaired = raw.slice(0, lastValidItem + 1) + "]}";
        try { result = JSON.parse(repaired); console.log(`⚠️ JSON reparado: ${result.items?.length || 0} productos`); }
        catch { throw parseErr; }
      } else { throw parseErr; }
    }
    console.log(`✅ AnastasIA CO devuelve ${result.items?.length || 0} productos`);
    return res.json(result);

  } catch (err) {
    console.error("❌ Error en AnastasIA CO:", err.message);
    const fallback = searchProducts(query).slice(0, 3).map(p => {
      const promo = calcPromo(p.regularPrice, p.price);
      const sku = p.partNumber || p.model;
      return {
        TITLE: p.title, TITLE_DISPLAY: p.title.slice(0, 50),
        PRECIO_REGULAR_FORMAT: formatCOP(parseFloat(p.regularPrice || p.price) || 0),
        PRECIO_OFERTA_FORMAT: formatCOP(parseFloat(p.price) || 0),
        PRECIO_REGULAR: parseFloat(p.regularPrice || p.price) || 0,
        PRECIO_OFERTA: parseFloat(p.price) || 0,
        URL: addUTM(p.link, sku), IMAGEN: p.image,
        SPECS: p.description ? p.description.replace(/"/g, "'").slice(0, 90) : "",
        PROMO: promo || "Visita nuestra tienda ASUS Colombia",
      };
    });
    return res.json({ items: fallback });
  }
});

await refreshCatalog();
setInterval(refreshCatalog, CONFIG.FEED_REFRESH_MS);

app.listen(CONFIG.PORT, () => {
  console.log(`🚀 AnastasIA CO corriendo en puerto ${CONFIG.PORT}`);
});
