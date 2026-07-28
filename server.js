// ═══════════════════════════════════════════════════════════════
//  ANASTASIA — COLOMBIA
//  repo: anastasia-co          moneda: COP
//  este archivo va junto con: search-co.js
//  feed: feeds.datafeedwatch.com/73484/...
//  NO mezclar con el server.js del otro pais
// ═══════════════════════════════════════════════════════════════

import express from "express";
import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";
import Anthropic from "@anthropic-ai/sdk";
// ── NUEVO: capa de intencion + seleccion de productos ────────────────
import { newIntent, updateIntent, selectProducts, extractBudget, isGamingProduct, powerScore } from "./search-co.js";

// Marca de version: se puede consultar en /health y en /catalog/audit.
// Sirve para confirmar que Railway esta corriendo el archivo que subiste.
const BUILD = "2026-07-28 · tipos+stock+dominio-raices";

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
  FEED_URL: process.env.FEED_URL || "https://feeds.datafeedwatch.com/73484/2796c588a919a06bb42a884950221484637dff3a.xml",
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
  // ── Tracking a Google Sheets ──
  TRACK_URL: process.env.TRACK_URL || "https://script.google.com/macros/s/AKfycbxp-9dO08nvUk0SRuSYh6Bx86hPS1mZ3iCdBM5trcVAX7YvlKwDtwO7WrUgmXjaqJOT_A/exec",
  TRACK_TAB: "Freshchat",        // webhook Freshchat
  TRACK_TAB_MAGENTO: "Magento",  // pagina AnastasIA en Magento (GET /anastasia)
};

let catalog = [];
let catalogoExcluidos = [];   // que se dejo por fuera y por que
const conversations = {};
const conversationIntents = {};   // NUEVO: intencion por conversacion de Freshchat
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
    s = { history: [], shownProducts: [], intent: newIntent(), lastSeen: now };
    magentoSessions[id] = s;
  }
  if (!s.intent) s.intent = newIntent();
  s.lastSeen = now;
  return s;
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
  "futbol","fútbol","deporte","partido","partidos","mundial","seleccion colombia","selección colombia",
  "juega colombia","a que hora juega","a qué hora juega","quien juega","quién juega","juegan hoy",
  "la seleccion","la selección","eliminatorias","liga betplay","el clasico","el clásico","torneo",
  "quien gano","quién ganó","quien ganó","marcador","liga betplay","champions",
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

// ── Filtro de relevancia ─────────────────────────────────────────────
// La lista de temas prohibidos siempre se queda corta. Esto lo invierte:
// solo pasa lo que habla de laptops, de la compra, o lo que continua una
// conversacion que ya tiene una laptop sobre la mesa.
const RAICES_DOMINIO = [
  // producto y marcas
  "laptop","portatil","portátil","notebook","computador","computadora","equipo","maquina","máquina",
  "asus","rog","tuf","vivobook","zenbook","expertbook","proart","strix","scar","zephyrus","ally",
  "torre","escritorio","desktop","aio","todo en uno","monitor","consola","handheld","chromebook",
  // usos
  "gam","jug","jueg","universi","estudi","colegi","carrera","tesis","clase","trabaj","oficin","negoci",
  "empres","teletrabaj","diseñ","disen","edit","edici","render","program","autocad","photoshop",
  "illustrator","premiere","solidworks","revit","excel","office","word","zoom","arquitect","ingenier",
  "creador","contenido","streaming","modelad","animac","fotograf","esport","e-sport",
  // uso en el hogar (menu "Para el Hogar" del sitio)
  "hogar","casa","personal","diari","dia a dia","día a día","famili","navegar","netflix",
  "redes sociales","basic","básic","uso general","2 en 1","dos en uno","convertible",
  "copilot","ai pc","inteligencia artificial","snapdragon","intel","amd","ryzen","core",
  // specs
  "ram","memoria","procesador","cpu","chip","nucleo","núcleo","disco","almacen","ssd","nvme","pantalla",
  "pulgada","resoluc","grafic","gráfic","gpu","rtx","gtx","nvidia","radeon","intel","amd","ryzen","core",
  "i3","i5","i7","i9","teclad","bateria","batería","autonom","camara","cámara","webcam","puerto","hdmi",
  "usb","thunderbolt","wifi","wi-fi","bluetooth","peso","pes","liger","livian","huella","oled","hz",
  "refresc","tasa","taza","refresh","spec","especificac","caracterist","ficha","gb","tb","windows",
  "sistema operativo","ampliab","expandib",
  // compra
  "precio","cuest","vale","barat","economic","económic","asequibl","accesibl","presupuest","millon",
  "luca","ofert","descuent","promoc","rebaj","compr","garant","envi","entreg","despach","domicilio",
  "pag","cuota","financiac","stock","disponib","tienda","asesor","factur",
  // intencion
  "recomend","sugier","opcion","opción","muestr","muéstr","tien","teng","hay","necesit","busc","quier",
  "escog","eleg","elij","decid","compar","diferenc","potent","gama","mejor","peor","sirve","aguanta",
  // juegos frecuentes
  "valorant","fortnite","minecraft","warzone","dota","csgo","fifa","roblox","apex","overwatch","elden",
  "genshin","cyberpunk","gta","sims","tarkov","rocket","forza",
];

function esDelDominio(q) {
  // La raiz tiene que coincidir con el ARRANQUE de una palabra. Con coincidencia
  // suelta, "soledad" contenia "oled" y colaba una consulta de literatura.
  const texto = normTxt(q).toLowerCase();
  const palabras = texto.split(/[^a-z0-9áéíóúñ]+/).filter(Boolean);
  return RAICES_DOMINIO.some(r =>
    r.includes(" ") ? texto.includes(r) : palabras.some(w => w.startsWith(r))
  );
}

const SALUDOS = /^(hola|buenas|buenos d[ií]as|buenas tardes|buenas noches|hey|que tal|qué tal|saludos|hi|hello)[\s!.,¡]*$/i;
// Respuestas cortas a una pregunta del bot: no son "fuera de dominio".
const AFIRMACIONES = /^(s[ií]|claro|dale|bueno|ok|okay|listo|por favor|porfa|de una|obvio|correcto|exacto|no|nop|ninguno|ninguna)[\s!.,¡]*$/i;

function isOffTopic(query) {
  return hasWord(query, offTopicWords);
}

// El cliente compara lo que ya vio. Cubre singular, plural y las formas
// comunes: "diferencias entre", "en que se diferencian", "cual me conviene".
const COMPARACION = /(diferencia|diferencias|se diferencian|qu[eé] cambia|compar[aá]|comp[aá]ralas|comparaci[oó]n|entre las (tres|dos)|entre estas|entre estos|cu[aá]l me conviene|cu[aá]l elijo|cu[aá]l escojo|cu[aá]l es mejor de|pros y contras|ventajas y desventajas)/i;

function isFollowUp(q) {
  const followUpWords = [
    "cuanto tarda","cuánto tarda","cuanto demora","cuánto demora","cuanto tiempo",
    "cuánto tiempo","tiempo de entrega","tiempo de envio","tiempo de envío",
    "cuando llega","cuándo llega","cuando me llega","dias habiles","días hábiles",
    "envio a","envío a","envian a","envían a","llega a","llega","llegaria","llegaría",
    "entrega","entregan","envian","envían","despachan","domicilio","despacho",
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

// Preguntas sobre specs de una laptop que el cliente YA vio o eligio.
// Antes caian en busqueda nueva y devolvian 3 productos sin relacion.
const specQuestionWords = [
  "cuanta ram","cuánta ram","que ram","qué ram","cuanta memoria","cuánta memoria",
  "memoria trae","cuanto almacenamiento","cuánto almacenamiento","que disco","qué disco",
  "cuanto ssd","cuánto ssd","que procesador","qué procesador","que cpu","qué cpu",
  "que tarjeta","qué tarjeta","que grafica","qué gráfica","que gpu","qué gpu",
  "cuantas pulgadas","cuántas pulgadas","que pantalla","qué pantalla","que resolucion","qué resolución",
  "tiene teclado","teclado en español","teclado retroiluminado","cuanto pesa","cuánto pesa",
  "que bateria","qué batería","que trae","qué trae","que incluye","qué incluye","viene con",
  "que sistema operativo","qué sistema operativo","tiene windows","es ampliable","se puede ampliar",
];
function isSpecQuestion(q) { return hasWord(q, specQuestionWords); }

// Pregunta corta sobre la laptop que el cliente ya eligio, aunque no use
// ninguna palabra de la lista de arriba ("sabes cual es la tasa de refresco?").
function esPreguntaCorta(q) {
  const t = (q || "").trim();
  if (t.split(/\s+/).length > 14) return false;
  // Si arranca pidiendo otra laptop, es busqueda nueva, no pregunta de ficha.
  const nuevaBusqueda = /(barat|econ[oó]mic|potente|otra|otras|mu[eé]strame|muestra|recomienda|presupuesto|millones|busco|necesito|quiero una|quiero otra|^laptop|^port[aá]til|^equipo|^computador)/i;
  return !nuevaBusqueda.test(t);
}

// Preguntas que la ficha del feed no puede responder aunque el campo exista.
// "¿Es ampliable la memoria?" no se contesta con "64GB LPDDR5X".
const NECESITA_DETALLE = [
  [/ampliable|se puede ampliar|expandir|agregar m[aá]s|sumar m[aá]s|subir la memoria/i, "ram", /ampliabl|soldad|expandibl|ranura|slot|so-dimm/i],
  [/se puede cambiar|reemplazar|actualizar el disco/i, "ssd", /ranura|slot|libre|adicional|m\.2/i],
];

function fichaAlcanza(q, campo, valor) {
  for (const [preg, c, requiere] of NECESITA_DETALLE) {
    if (c === campo && preg.test(q) && !requiere.test(valor)) return false;
  }
  return true;
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
    catalogoExcluidos = [];
    const excluir = (p, razon) => {
      catalogoExcluidos.push({ titulo: p.title, precio: p.price, razon });
    };
    catalog = items.map((item) => {
      const val = (v) => { if (!v) return ""; if (typeof v === "string") return v.trim(); if (typeof v === "number") return String(v); if (v["#text"]) return String(v["#text"]).trim(); return ""; };
      const stripHtml = (s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&nbsp;/g, " ").replace(/&[a-z]+;/g, "").trim();
      const fullDesc = stripHtml(val(item.Short_Description) || val(item.description) || "");
      return {
        id:           val(item.Part_Number) || val(item.Model) || "",
        title:        val(item.Name)        || val(item.title) || "",
        // description: version corta para los prompts de 3 tarjetas (control de tokens).
        // descriptionFull: ficha completa, para responder preguntas de un solo producto.
        description:  fullDesc.slice(0, 300),
        descriptionFull: fullDesc.slice(0, 1500),
        price:        val(item.Offer_Price) || val(item.Regular_Price) || val(item.price) || "",
        regularPrice: val(item.Regular_Price) || "",
        link:         val(item.Product_URL) || val(item.link)  || "",
        image:        val(item.Main_Image_URL) || val(item.image) || "",
        brand:        "ASUS",
        model:        val(item.Model)       || "",
        partNumber:   val(item.Part_Number) || "",
        category:     val(item.BU)          || val(item.category) || "",
        availability: val(item.Availability) || val(item.availability) || "in stock",
        tipo: clasificarTipo(`${val(item.Name)} ${val(item.BU)} ${val(item.category)}`),
      };
    }).filter(p => {
      if (!p.title) return false;
      const regular = parseFloat(p.regularPrice) || 0;
      const offer = parseFloat(p.price) || 0;
      // Solo se descarta un descuento absurdo (más del 80%), que casi siempre es un
      // error de precio en el feed. Las liquidaciones reales de 50-60% son válidas
      // y antes se estaban botando: una Vivobook Go a -53% no aparecía nunca.
      if (regular > 0 && offer > 0 && (offer / regular) < 0.2) { excluir(p, "descuento mayor a 80% (posible error de precio)"); return false; }

      // El feed manda: si viene marcado sin stock, no se recomienda.
      const dispo = normTxt(p.availability || "").toLowerCase();
      if (/out.?of.?stock|agotado|sin stock|no disponible|discontinued|descontinuado|unavailable/.test(dispo)) {
        excluir(p, "sin stock segun el feed");
        return false;
      }

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
      if (accessoryWords.some(w => t.includes(w))) { excluir(p, "accesorio"); return false; }





      // Piso de precio: ninguna laptop ASUS en COP baja de ~$1.000.000.
      if (offer > 0 && offer < 1000000) { excluir(p, "precio menor a $1.000.000"); return false; }

      return true;
    });
    console.log(`✅ Catálogo CO cargado: ${catalog.length} productos activos`);
  } catch (err) {
    console.error("❌ Error actualizando catálogo CO:", err.message);
  }
}

// ── Lectura de la ficha del feed ─────────────────────────────────────
// El feed CO trae la descripcion con etiquetas y con simbolos ® y ™:
//   "Sistema Operativo: Windows 11 Home Procesador: Intel® Core™ Ultra 9 ..."
// Sin normalizar, "RTX™ 5090" no coincide con "rtx 5090" y la tarjeta sale
// sin procesador, sin disco y sin GPU.
function normTxt(s) {
  return String(s || "")
    .replace(/[\u00ae\u2122\u00a9]/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Corta la descripcion en secciones usando SOLO etiquetas conocidas.
// Con un separador generico, "240Hz Tarjeta Grafica:" se leia como etiqueta
// y el valor de pantalla perdia el "Hz".
const ETIQUETAS = /(sistema operativo|procesador|memoria ram|memoria|almacenamiento|disco duro|disco|pantalla|display|tarjeta gr[aá]fica|gr[aá]ficos|gr[aá]fica|teclado|bater[ií]a|c[aá]mara|webcam|puertos|conectividad|interfaces|peso|color|garant[ií]a|incluye|contenido de la caja|en la caja|wi-?fi|bluetooth|audio|parlantes|red|lector|huella|dimensiones)\s*:\s*/gi;

function descSections(p) {
  const d = normTxt(p.descriptionFull || p.description || "");
  const out = [];
  let m, last = null;
  ETIQUETAS.lastIndex = 0;
  while ((m = ETIQUETAS.exec(d)) !== null) {
    if (last) out.push([last.k, d.slice(last.i, m.index).trim()]);
    last = { k: m[1].trim().toLowerCase(), i: ETIQUETAS.lastIndex };
  }
  if (last) out.push([last.k, d.slice(last.i).trim()]);
  return out;
}

const CAMPOS = {
  so:       /sistema operativo|windows/i,
  cpu:      /procesador|cpu/i,
  ram:      /memoria|\bram\b/i,
  ssd:      /almacenamiento|disco/i,
  pantalla: /pantalla|display/i,
  gpu:      /tarjeta gr[aá]fica|gr[aá]fic|gpu|video/i,
  teclado:  /teclado/i,
  huella:   /huella|lector/i,
  bateria:  /bater[ií]a/i,
  camara:   /c[aá]mara|webcam/i,
  puertos:  /puertos|conectividad|interfaces/i,
  peso:     /peso/i,
  color:    /color/i,
  garantia: /garant[ií]a/i,
  incluye:  /incluye|en la caja|contenido/i,
  wifi:     /wi-?fi|inal[aá]mbric|bluetooth/i,
  audio:    /audio|parlantes|bocinas|sonido/i,
};

function parseSpecs(p) {
  const out = {};
  for (const [label, val] of descSections(p)) {
    for (const key in CAMPOS) {
      if (!out[key] && CAMPOS[key].test(label)) { out[key] = val.slice(0, 130); break; }
    }
  }
  // Respaldo por texto libre para los cinco datos de la tarjeta.
  const d = " " + normTxt(p.descriptionFull || p.description || "") + " ";
  const pick = (re) => { const m = d.match(re); return m ? m[0].trim() : ""; };
  if (!out.cpu)      out.cpu      = pick(/(intel\s+)?core\s+(ultra\s+)?[i]?\d[\w-]*\s*\d{0,4}\w*|(amd\s+)?ryzen[\w\s]{0,14}\d{3,4}\w*|(amd\s+)?ryzen\s+z\d[\w\s]{0,10}|snapdragon[\w\s]{0,14}/i);
  if (!out.ram)      out.ram      = pick(/\d{1,3}\s?gb\s+(?:lp)?ddr\d\w*/i);
  if (!out.ssd)      out.ssd      = pick(/\d+\s?(gb|tb)[\w\s.]{0,18}ssd/i);
  if (!out.pantalla) out.pantalla = pick(/\d{2}(\.\d)?\s*("|pulg)[\w\s.+:x]{0,28}/i);
  if (!out.gpu)      out.gpu      = pick(/(nvidia\s+)?(geforce\s+)?(rtx|gtx)\s*\d{3,4}[\w\s]{0,14}|intel\s+arc[\w\s]{0,10}|iris\s+xe|radeon[\w\s]{0,10}/i);
  for (const k in out) out[k] = normTxt(out[k]);
  return out;
}

// Que campo de la ficha responde la pregunta del cliente.
const PREGUNTA_CAMPO = [
  // Pantalla — incluye ingles y errores comunes de escritura ("taza")
  [/ta[sz]a de refresco|tesa de refresco|refresh rate|frecuencia de (la )?pantalla|\bhz\b|herc?ios|herzios|hertz|refresco de pantalla|cuantos hz/i, "pantalla"],
  [/pantalla|display|pulgadas|\bpulg\b|tama[nñ]o de (la )?pantalla|resoluci[oó]n|\bfhd\b|\bqhd\b|\boled\b|\bips\b|nits|brillo|antirreflejo|mate|t[aá]ctil|touch/i, "pantalla"],
  // Memoria
  [/\bram\b|memoria|\bgb de memoria\b|\bddr\d/i, "ram"],
  // Procesador
  [/procesador|\bcpu\b|\bchip\b|n[uú]cleos|\bghz\b|que intel|que ryzen|generaci[oó]n del procesador/i, "cpu"],
  // Almacenamiento
  [/disco|almacenamiento|\bssd\b|\bnvme\b|capacidad|espacio|cuantos gb (tiene|trae|de disco)|\btb\b/i, "ssd"],
  // Grafica
  [/gr[aá]fic|\bgpu\b|tarjeta de video|\bvram\b|video dedicad|nvidia|geforce|radeon|\brtx\b|\bgtx\b/i, "gpu"],
  // Teclado
  [/teclado|keyboard|retroilumin|iluminad|distribuci[oó]n|\b[ñn]\b|numerico|num[eé]rico/i, "teclado"],
  [/huella|fingerprint|lector de huella|reconocimiento facial|windows hello/i, "huella"],
  // Bateria y portabilidad
  [/bater[ií]a|battery|autonom[ií]a|cu[aá]nto dura|duraci[oó]n de (la )?bater|\bwh\b|carga r[aá]pida/i, "bateria"],
  [/peso|pesa|\bkg\b|kilos|liviana|pesada|es pesado|f[aá]cil de llevar|para cargar/i, "peso"],
  // Camara y audio
  [/c[aá]mara|webcam|videollamad|para clases virtuales|para zoom|para meet/i, "camara"],
  [/audio|parlante|bocina|sonido|speakers|micr[oó]fono/i, "audio"],
  // Puertos y conectividad
  [/puerto|hdmi|\busb\b|usb-?c|thunderbolt|conector|conectar|entrada (de|para)|salida de|lector de tarjetas|lector sd|\bsd\b|ethernet|rj-?45|jack|aud[ií]fonos|auriculares|monitor externo|dos monitores|pantalla externa|proyector/i, "puertos"],
  [/wi-?fi|bluetooth|inal[aá]mbric|conectividad/i, "wifi"],
  // Otros
  [/de que color|\bcolor\b|colores disponibles/i, "color"],
  [/garant[ií]a|warranty|cobertura/i, "garantia"],
  [/incluye|en la caja|viene con|trae mouse|trae cargador|malet[ií]n|mochila|accesorios|contenido/i, "incluye"],
  [/sistema operativo|windows|office|\bso\b\b|preinstalado/i, "so"],
];

// Preguntas de idoneidad: no son un dato de la ficha, son un juicio.
// "¿Sirve para AutoCAD?" se responde mirando CPU/RAM/GPU, no escalando.
const PREGUNTA_USO = /(sirve para|es buena para|es bueno para|aguanta|corre|puedo (usar|correr|jugar|editar)|alcanza para|me sirve para|funciona para|rinde (bien )?(en|para)|es apta para)/i;

function campoDePregunta(q) {
  for (const [re, campo] of PREGUNTA_CAMPO) if (re.test(q)) return campo;
  return null;
}

const CAMPOS_VALIDOS = ["pantalla","ram","cpu","ssd","gpu","teclado","huella","bateria",
  "camara","audio","puertos","wifi","color","garantia","incluye","so"];

// Respaldo: si las reglas no reconocen la pregunta, se le pide a Haiku que la
// clasifique en uno de los campos de la ficha. Solo clasifica; NO responde ni
// inventa datos. Si no es una pregunta tecnica, devuelve null y sigue el flujo.
async function campoDePreguntaIA(q) {
  try {
    const r = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 12,
      system: `Clasificas preguntas de clientes sobre laptops. Devuelve UNA sola palabra de esta lista, sin explicar y sin puntuacion:
${CAMPOS_VALIDOS.join(" ")} NINGUNO
Significado: pantalla (tamaño, resolucion, hz, tactil), ram (memoria), cpu (procesador), ssd (disco), gpu (tarjeta grafica), teclado, huella (lector o desbloqueo), bateria (duracion), camara, audio, puertos (usb, hdmi, lector), wifi (bluetooth), color, garantia, incluye (que trae en la caja), so (sistema operativo, Office).
Si la pregunta NO es sobre una caracteristica de la laptop (precio, envio, pago, si sirve para algun uso, saludo), responde NINGUNO.`,
      messages: [{ role: "user", content: q }],
    });
    const out = (r.content[0]?.text || "").trim().toLowerCase().replace(/[^a-z]/g, "");
    return CAMPOS_VALIDOS.includes(out) ? out : null;
  } catch (e) {
    console.error("⚠️ Clasificador de pregunta fallo:", e.message);
    return null;
  }
}

// "Ideal para" y tagline calculados del catalogo (no los genera el LLM).
function gpuTier(t) {
  const g = normTxt(t).match(/\b(rtx|gtx)\s*(\d{4})\b/i);
  return g ? parseInt(g[2].slice(2), 10) + parseInt(g[2][0], 10) * 2 : 0;
}

function idealPara(p) {
  const t = normTxt(`${p.title || ""} ${p.descriptionFull || p.description || ""}`).toLowerCase();
  const tier = gpuTier(t);
  if (/proart/.test(t)) return "Diseño y edición";
  if (/zephyrus|strix|scar/.test(t) && tier >= 70) return "Gaming y creación";
  if (tier >= 65) return "Gaming exigente";
  if (tier > 0) return "Gaming y estudio";
  if (/expertbook/.test(t)) return "Trabajo diario";
  if (/zenbook/.test(t)) return /oled/.test(t) ? "Productividad y diseño" : "Portabilidad y trabajo";
  if (/vivobook/.test(t)) return "Universidad y trabajo";
  return "Uso diario";
}

function taglineFor(p) {
  const t = normTxt(`${p.title || ""} ${p.descriptionFull || p.description || ""}`).toLowerCase();
  const tier = gpuTier(t);
  if (/zephyrus duo|screenpad plus|doble pantalla/.test(t)) return "Doble pantalla";
  if (/proart/.test(t)) return "Color profesional";
  if (tier >= 85) return "Potencia máxima";
  if (tier >= 65) return "Alto rendimiento";
  if (tier > 0) return "Gaming accesible";
  if (/oled/.test(t)) return "Pantalla OLED";
  if (/1\.[0-4]\s*kg|liviana|delgada/.test(t)) return "Ultraliviana";
  return "Disponible";
}

function itemFromCatalog(p, extra = {}) {
  const sp = parseSpecs(p);
  const regularNum = parseFloat(p.regularPrice) || parseFloat(p.price) || 0;
  const offerNum   = parseFloat(p.price) || 0;
  return {
    TITLE: p.title,
    TITLE_DISPLAY: p.title.slice(0, 50),
    PRECIO_REGULAR_FORMAT: formatCOP(regularNum),
    PRECIO_OFERTA_FORMAT:  formatCOP(offerNum),
    PRECIO_REGULAR: regularNum,
    PRECIO_OFERTA:  offerNum,
    URL: addUTM(p.link, p.partNumber || p.model),
    IMAGEN: p.image,
    SPECS: [sp.cpu, sp.ram, sp.ssd, sp.pantalla].filter(Boolean).join(" | ") || (p.description || "").slice(0, 90),
    CPU: sp.cpu, RAM: sp.ram, SSD: sp.ssd, PANTALLA: sp.pantalla, GPU: sp.gpu,
    TECLADO_ES: sp.teclado || "", EN_CAJA: sp.incluye || "",
    IDEAL_PARA: idealPara(p), TAGLINE: calcPromo(p.regularPrice, p.price) ? "En oferta" : taglineFor(p),
    PROMO: calcPromo(p.regularPrice, p.price) || formatCOP(offerNum),
    ...extra,
  };
}

// Que es cada producto del feed. El stock lo manda el feed: si no viene,
// no existe para el bot; si viene, se puede recomendar cuando lo pidan.
function clasificarTipo(texto) {
  const t = normTxt(texto).toLowerCase();
  if (/\bally\b|steam deck|handheld|consola/.test(t)) return "handheld";
  if (/all in one|all-in-one|todo en uno|\baio\b/.test(t)) return "aio";
  if (/\btorre\b|\btower\b|desktop|de escritorio|mini pc|\bnuc\b/.test(t)) return "torre";
  return "laptop";
}

// Que categorias tiene la tienda HOY, segun el feed. Nada quemado en codigo.
function tiposDisponibles() {
  return [...new Set(catalog.map(p => p.tipo || "laptop"))];
}

// "Lo que si tengo son laptops, torres y todo-en-uno. ¿Cual te muestro?"
function fraseOfrecerLoQueHay(excepto) {
  const nombres = tiposDisponibles().filter(t => t !== excepto).map(t => NOMBRE_TIPO[t]);
  if (!nombres.length) return "";
  if (nombres.length === 1) return `Lo que sí tengo disponible en la tienda son ${nombres[0]}. ¿Te muestro las opciones?`;
  const ultimo = nombres.pop();
  return `Lo que sí tengo disponible son ${nombres.join(", ")} y ${ultimo}. ¿Cuál te gustaría ver?`;
}

const NOMBRE_TIPO = { laptop: "laptops", torre: "torres o equipos de escritorio", aio: "todo-en-uno", handheld: "consolas portátiles" };

function calcPromo(regularPrice, price) {
  const regular = parseFloat(regularPrice) || 0;
  const offer = parseFloat(price) || 0;
  const hasDiscount = regular > 0 && offer > 0 && regular > offer;
  if (!hasDiscount) return null;
  return `${formatCOP(regular)} → ${formatCOP(offer)} ¡Oferta!`;
}

async function askClaude(conversationId, userMessage) {
  // La intencion tambien se mantiene por conversacion en Freshchat.
  conversationIntents[conversationId] = updateIntent(conversationIntents[conversationId] || newIntent(), userMessage);
  const relevant = selectProducts(catalog, userMessage, conversationIntents[conversationId], 3).products;
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

// ── Log a Google Sheets (pestaña separada vía __tab) ─────────────────
// Mismo collector GAS para ambos canales, pero cada canal cae en su
// propia pestaña con su propio source. Fire-and-forget: no bloquea ni
// rompe el flujo si el sheet falla. GET con texto recortado (límite URL).
// Nunca mandar datos sensibles al Sheet: si el cliente escribe una tarjeta,
// una cedula o un telefono, se guarda enmascarado.
function redactar(t) {
  return String(t || "")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[NUMERO OCULTO]")
    .replace(/\b3\d{2}[ -]?\d{3}[ -]?\d{4}\b/g, "[TELEFONO OCULTO]")
    .replace(/\b\d{6,11}\b/g, "[NUMERO OCULTO]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[CORREO OCULTO]");
}

function trackEvent(fields, tab, source) {
  if (!CONFIG.TRACK_URL) return;
  try {
    if (fields.query) fields.query = redactar(fields.query);
    if (fields.bot_message) fields.bot_message = redactar(fields.bot_message);
    const params = new URLSearchParams({
      __tab: tab,
      country: "CO",
      event: "query",
      channel: source,
      ...fields,
    });
    fetch(`${CONFIG.TRACK_URL}?${params.toString()}`)
      .catch(err => console.error(`⚠️ track ${tab} falló:`, err.message));
  } catch (e) {
    console.error(`⚠️ track ${tab} error:`, e.message);
  }
}

// Webhook de Freshchat → pestaña Freshchat
function trackFreshchat(fields) {
  trackEvent(fields, CONFIG.TRACK_TAB, "freshchat");
}

// Pagina AnastasIA en Magento (GET /anastasia) → pestaña Magento
function trackMagento(fields) {
  trackEvent(fields, CONFIG.TRACK_TAB_MAGENTO, "magento");
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
      message_type: "webhook",
      query: userMessage.slice(0, 500),
      bot_message: reply.slice(0, 500),
    });
    await replyOnFreshchat(conversationId, agentId, reply);
  } catch (err) {
    console.error("❌ Error procesando webhook:", err.message);
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", version: BUILD, country: "CO", products: catalog.length, conversations: Object.keys(conversations).length });
});

// Radiografia del catalogo real, para revisarlo como eShop manager.
// Abrir en el navegador: <tu-url>/catalog/audit
app.get("/catalog/audit", (req, res) => {
  const cop = (n) => "$" + Math.round(n).toLocaleString("es-CO");
  const filas = catalog.map(p => {
    const sp = parseSpecs(p);
    const faltan = ["cpu","ram","ssd","pantalla","gpu"].filter(k => !sp[k]);
    return {
      titulo: p.title,
      tipo: p.tipo || "laptop",
      modelo: p.model,
      precio: parseFloat(p.price) || 0,
      precio_fmt: cop(parseFloat(p.price) || 0),
      descuento_pct: (() => {
        const r = parseFloat(p.regularPrice) || 0, o = parseFloat(p.price) || 0;
        return r > o && r > 0 ? Math.round((1 - o / r) * 100) : 0;
      })(),
      ideal_para: idealPara(p),
      badge: taglineFor(p),
      gaming: isGamingProduct(p),
      potencia: Math.round(powerScore(p)),
      specs_faltantes: faltan,
    };
  }).sort((a, b) => a.precio - b.precio);

  const porCategoria = {};
  filas.forEach(f => { porCategoria[f.ideal_para] = (porCategoria[f.ideal_para] || 0) + 1; });

  const porRazon = {};
  catalogoExcluidos.forEach(e => { porRazon[e.razon] = (porRazon[e.razon] || 0) + 1; });

  res.json({
    version: BUILD,
    total_en_catalogo: catalog.length,
    por_tipo: catalog.reduce((a, p) => { const t = p.tipo || "laptop"; a[t] = (a[t] || 0) + 1; return a; }, {}),
    excluidos: {
      total: catalogoExcluidos.length,
      por_razon: porRazon,
      detalle: catalogoExcluidos,
    },
    resumen: {
      por_categoria: porCategoria,
      gaming: filas.filter(f => f.gaming).length,
      no_gaming: filas.filter(f => !f.gaming).length,
      con_specs_incompletos: filas.filter(f => f.specs_faltantes.length).length,
      descuento_mayor_40: filas.filter(f => f.descuento_pct > 40).length,
    },
    revisar: {
      specs_incompletos: filas.filter(f => f.specs_faltantes.length)
        .map(f => ({ titulo: f.titulo, falta: f.specs_faltantes })),
      posibles_accesorios: filas.filter(f => f.precio < 2000000)
        .map(f => ({ titulo: f.titulo, precio: f.precio_fmt })),
      descuentos_altos: filas.filter(f => f.descuento_pct > 40)
        .map(f => ({ titulo: f.titulo, descuento: f.descuento_pct + "%", precio: f.precio_fmt })),
    },
    mas_baratas: filas.slice(0, 5).map(f => ({ titulo: f.titulo, precio: f.precio_fmt, ideal_para: f.ideal_para })),
    mas_potentes: [...filas].sort((a, b) => b.potencia - a.potencia).slice(0, 5)
      .map(f => ({ titulo: f.titulo, potencia: f.potencia, precio: f.precio_fmt })),
    catalogo: filas,
  });
});

app.get("/catalog/search", (req, res) => {
  const q = req.query.q || "";
  res.json(selectProducts(catalog, q, updateIntent(newIntent(), q), CONFIG.MAX_PRODUCTS_IN_PROMPT).products);
});

// Reinicio de conversacion. La pagina lo llama al dar clic en "Nueva consulta".
// Borra intencion, historial y productos vistos de esa sesion.
app.get("/anastasia/reset", (req, res) => {
  const sessionId = req.query.session || req.query.session_id || "";
  if (sessionId && magentoSessions[sessionId]) delete magentoSessions[sessionId];
  console.log(`🔄 Sesion reiniciada${sessionId ? ` [${sessionId}]` : ""}`);
  res.json({
    ok: true,
    message: "Listo, empecemos de nuevo. ¿Qué tipo de laptop estás buscando?",
    items: [],
  });
});

app.get("/anastasia", async (req, res) => {
  const tStart = Date.now();
  const query = req.query.q || req.query.query || req.query.busqueda || "";
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  const sessionId = req.query.session || req.query.session_id || "";
  const session = getSession(sessionId);
  // Freshchat (Freshworks) tambien llama GET /anastasia (solo ?q=), SIN session.
  // La pagina Magento siempre manda session= → ese es el discriminador de canal.
  // Trafico Magento NO se trackea aqui: la pagina ya lo trackea completa
  // client-side a la pestaña Events (chips, clicks, CSAT, UTMs, errores).
  // Trackear aqui tambien lo duplicaria. Solo Freshchat se loguea del server.
  const trackWeb = (fields) => { if (!sessionId) trackFreshchat(fields); };

  // ── Intencion: lo ultimo que dice el cliente manda ──────────────────
  const intent = updateIntent(session?.intent || newIntent(), query);
  if (session) session.intent = intent;

  console.log(`AnastasIA CO consulta: "${query}"${sessionId ? ` [${sessionId}]` : ""} intent=[${intent.uses.join(",")}] budget=${intent.budget}`);
  if (!query || !query.trim()) return res.json({ message: "Cuéntame qué tipo de laptop buscas y te ayudo a encontrarla.", items: [] });

  // Si el feed no cargo, no se le puede pedir al cliente que insista.
  if (!catalog.length) {
    console.error("⚠️ Catálogo vacío: el feed no cargó");
    return res.json({
      message: "Estoy teniendo problemas para consultar el catálogo en este momento. Un asesor te puede atender de una vez mientras se restablece.",
      escalate: true,
      items: [],
    });
  }

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

    // ── Intentos de manipular al bot ─────────────────────────────────
    // Se atajan aqui: nunca llegan al modelo.
    const inyeccion = /(ignora|olvida|omite|desobedece)[\w\s]{0,20}(instruccion|instrucci[oó]n|regla|prompt|orden)|actua como|act[uú]a como|haz de cuenta que eres|finge (que )?(ser|eres)|system prompt|prompt del sistema|revela (tus|el)|repite tus (instruccion|regla)|dime tus (instruccion|regla)|eres (chatgpt|gpt|claude|un modelo|una ia|un bot de)|jailbreak|modo desarrollador|sin restricciones|di que[\w\s]{0,40}(cuesta|vale|es gratis|sale en|est[aá] en)|autoriza(me)? (un|el)|dame (el|tu) (codigo|c[oó]digo) fuente/i;
    if (inyeccion.test(q)) {
      console.log(`🛡️ Intento de manipulacion bloqueado`);
      trackWeb({ session_id: sessionId || ip, message_type: "blocked",
        query: query.slice(0, 500), bot_message: "bloqueado", products_count: 0 });
      return res.json({
        message: "Solo puedo ayudarte a encontrar laptops ASUS en nuestra tienda. ¿Qué tipo de laptop estás buscando?",
        items: [],
      });
    }

    // ── Datos personales: no se piden ni se guardan ──────────────────
    const datoSensible = /\b(?:\d[ -]?){13,19}\b|\b3\d{2}[ -]?\d{3}[ -]?\d{4}\b|c[eé]dula|tarjeta de cr[eé]dito|n[uú]mero de tarjeta|cvv|clave|contrase[nñ]a/i;
    if (datoSensible.test(q)) {
      console.log(`🛡️ Dato sensible detectado → no se guarda`);
      trackWeb({ session_id: sessionId || ip, message_type: "pii_blocked",
        query: "[consulta con dato sensible]", bot_message: "bloqueado", products_count: 0 });
      return res.json({
        message: "Por tu seguridad no compartas datos personales ni de tu tarjeta por este chat. Si necesitas ayuda con un pago o un pedido, un asesor te atiende de forma segura.",
        escalate: true,
        items: [],
      });
    }

    // ── Otras marcas: se redirige sin hablar mal de nadie ────────────
    const competencia = /\b(macbook|apple|imac|hp\b|pavilion|lenovo|thinkpad|ideapad|dell\b|xps|inspiron|acer\b|nitro|predator|msi\b|katana|huawei|matebook|surface|alienware|razer|gigabyte|compumax)\b/i;
    if (competencia.test(q)) {
      return res.json({
        message: "Solo manejo el catálogo de laptops ASUS de nuestra tienda, así que no puedo compararte con otras marcas. Cuéntame para qué la necesitas y te muestro la mejor opción ASUS para ti.",
        items: [],
      });
    }

    // ── Consulta vacía ───────────────────────────────────────────────
    if (!q.trim()) {
      return res.json({ message: "Cuéntame qué tipo de laptop buscas y te ayudo a encontrarla.", items: [] });
    }

    // ── Relevancia: si no habla de laptops ni continua la conversacion,
    // no entra. Esto es lo que impide usar a AnastasIA como una IA general.
    const hayContexto = !!(session?.selectedProduct || session?.shownProducts?.length);
    // Si ya hay laptops en pantalla, cualquier mensaje corto es parte de la
    // conversacion: "pero son los mas baratos?" no puede quedar bloqueado.
    const cortoConContexto = hayContexto && q.trim().split(/\s+/).length <= 14;
    if (!esDelDominio(q) && !SALUDOS.test(q.trim()) && !isFollowUp(q) && !cortoConContexto) {
      console.log(`🛡️ Fuera de dominio: "${query.slice(0, 60)}"`);
      trackWeb({ session_id: sessionId || ip, message_type: "fuera_de_dominio",
        query: query.slice(0, 500), bot_message: "redirigido", products_count: 0 });
      return res.json({
        message: `Soy AnastasIA, la asesora virtual de la tienda ASUS Colombia, así que solo puedo ayudarte con eso. ${fraseOfrecerLoQueHay(null)}`.trim(),
        items: [],
      });
    }

    const salesWords = [
      "cupon","cupón","codigo descuento","código descuento","promocion","promoción",
      "me das un descuento","me da un descuento","me hacen un descuento","hacer un descuento",
      "descuento adicional","descuento especial","rebaja","rebajar","precio especial","mejor precio","me lo dejas",
      "me lo deja","hacer un precio","precio mas bajo","precio más bajo","negociar","regatear",
      "apartar","apartado","separar","reservar","me lo guardas","me lo guarda","separame","apartame",
      "factura electronica","factura electrónica","datos de facturacion",
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

    // ── Que tipo de equipo pide, y que hay en el feed ────────────────
    // Si pide algo que no sea laptop: si hay en stock se le muestra; si no,
    // se le dice con honestidad y se le ofrece la alternativa mas cercana.
    const pedido = intent.tipo || "laptop";
    if (pedido !== "laptop" && !catalog.some(p => (p.tipo || "laptop") === pedido)) {
      // Quien busca una consola de mano no quiere una laptop encima. Se le dice
      // que no hay, se le cuenta que SI hay, y se le deja elegir.
      const msg = `Ahora mismo no tengo ${NOMBRE_TIPO[pedido]} disponibles en la tienda. ${fraseOfrecerLoQueHay(pedido)}`.trim();
      if (session) {
        session.intent.tipo = "laptop";   // queda abierto a lo que el cliente elija
        session.history.push({ role: "user", content: query });
        session.history.push({ role: "assistant", content: msg });
      }
      console.log(`📦 Sin stock de ${pedido} → se ofrece elegir entre ${tiposDisponibles().join(", ")}`);
      trackWeb({ session_id: sessionId || ip, message_type: "sin_stock_tipo",
        query: query.slice(0, 500), bot_message: msg.slice(0, 500), products_count: 0 });
      return res.json({ message: msg, items: [] });
    }

    const nonLaptopWords = [
      "rog pc","rog desktop",
      "monitor externo","pantalla externa","tablet","ipad",
      "servidor","server","nas","componentes","armar pc","build pc","pc armada","procesador suelto",
      "television","televisor","smart tv","smartwatch","reloj inteligente","proyector","ups","estabilizador",
      "bolso","mochila","maletin","maletín","funda","estuche","backpack","forro",
      "mouse","keyboard","teclado externo","audifonos","audífonos","headset","webcam","auriculares","auricular",
      "parlante","bocina","altavoz",
    ];
    if (hasWord(q, nonLaptopWords) || (q.includes("monitor") && !q.includes("laptop") && !q.includes("pantalla de laptop"))) {
      // No se le empuja una laptop a quien pidio otra cosa: se le dice que no
      // hay y se le ofrece elegir entre lo que si tiene la tienda.
      const queria = /monitor|pantalla externa/i.test(q) ? "monitores"
                   : /mouse|teclado|audifon|auricular|diadema|mochila|malet|funda|cargador/i.test(q) ? "accesorios"
                   : /celular|telefono|tablet|ipad|smartwatch|reloj/i.test(q) ? "ese tipo de producto"
                   : "ese tipo de producto";
      const msg = `Ahora mismo no tengo ${queria} en la tienda. ${fraseOfrecerLoQueHay(null)}`.trim();
      trackWeb({ session_id: sessionId || ip, message_type: "sin_stock_tipo",
        query: query.slice(0, 500), bot_message: msg.slice(0, 500), products_count: 0 });
      return res.json({ message: msg, items: [] });
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
      const candidates = pool.length ? pool : selectProducts(catalog, query, intent, CONFIG.MAX_PRODUCTS_IN_PROMPT).products;
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
DESCRIPCION: ${(target.descriptionFull || target.description).replace(/"/g, "'")}
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
          const d = target.descriptionFull || target.description;
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
          trackWeb({
            session_id: sessionId || ip,
            message_type: "spec_sheet",
            query: query.slice(0, 500),
            bot_message: `[ficha tecnica: ${target.title}]`.slice(0, 500),
            products_count: 1,
          });
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

    // Red de seguridad: pregunta sobre la laptop elegida que no sabemos mapear
    // a ningun campo. Antes caia en busqueda y devolvia 3 tarjetas sin relacion.
    if (session?.selectedProduct && !campoDePregunta(q) && esPreguntaCorta(q) &&
        /(tiene|trae|viene|incluye|soporta|es compatible|cuenta con)/i.test(q) &&
        !PREGUNTA_USO.test(q) &&
        !/(gaming|jugar|juegos|dise[nñ]o|autocad|solidworks|revit|photoshop|illustrator|premiere|editar|render|streaming|programar|excel|office|word|zoom|meet|clases|universidad|trabajo|estudiar|contabilidad)/i.test(q)) {
      const t = session.selectedProduct.title;
      const msg = `Ese detalle no aparece en la ficha que tengo de la ${t}. Para no darte un dato equivocado, mejor te lo confirma un asesor. Da clic en "Hablar con asesor".`;
      session.history.push({ role: "user", content: query });
      session.history.push({ role: "assistant", content: msg });
      console.log(`❓ Pregunta sin campo conocido → asesor`);
      trackWeb({ session_id: sessionId || ip, message_type: "no_data",
        query: query.slice(0, 500), bot_message: msg.slice(0, 500), products_count: 0 });
      return res.json({ message: msg, escalate: true, items: [] });
    }

    // ── Pregunta sobre la laptop que el cliente ya eligio ──────────────
    // Se responde con el dato EXACTO de la ficha del feed. Si el feed no lo
    // trae, se dice con honestidad y se ofrece un asesor: nunca se inventa.
    const elegida = session?.selectedProduct;
    let campoPreg = campoDePregunta(q);
    // Si las reglas no la reconocen pero es una pregunta corta sobre la laptop
    // elegida y no es de idoneidad, se le pide a Haiku que la clasifique.
    if (elegida && !campoPreg && esPreguntaCorta(q) && !PREGUNTA_USO.test(q) && !isFollowUp(q)) {
      campoPreg = await campoDePreguntaIA(query);
      if (campoPreg) console.log(`🤖 Clasificador IA: "${query}" → ${campoPreg}`);
    }
    if (elegida && campoPreg && (isSpecQuestion(q) || esPreguntaCorta(q))) {
      const prod = catalog.find(c => c.title === elegida.title);
      const sp = prod ? parseSpecs(prod) : {};
      let valor = sp[campoPreg] || "";
      if (valor && !fichaAlcanza(q, campoPreg, valor)) valor = "";   // la ficha no alcanza
      const nombreCampo = {
        pantalla: "la pantalla", ram: "la memoria RAM", cpu: "el procesador",
        ssd: "el almacenamiento", gpu: "la tarjeta grafica", teclado: "el teclado",
        bateria: "la bateria", camara: "la camara", puertos: "los puertos",
        peso: "el peso", color: "el color", garantia: "la garantia",
        incluye: "lo que trae en la caja", so: "el sistema operativo", huella: "el lector de huella",
        wifi: "la conectividad", audio: "el audio",
      }[campoPreg] || "ese detalle";

      if (!valor) {
        const msg = `Ese detalle no aparece en la ficha que tengo de la ${elegida.title}. No quiero darte un dato equivocado, asi que mejor te lo confirma un asesor. Da clic en "Hablar con asesor" y te responden enseguida.`;
        if (session) {
          session.history.push({ role: "user", content: query });
          session.history.push({ role: "assistant", content: msg });
        }
        console.log(`❓ Dato no disponible en el feed (${campoPreg}) → asesor`);
        trackWeb({
          session_id: sessionId || ip, message_type: "no_data",
          query: query.slice(0, 500), bot_message: msg.slice(0, 500),
          products_shown: elegida.title.slice(0, 500), products_count: 0,
        });
        return res.json({ message: msg, escalate: true, items: [] });
      }

      let ans = "";
      try {
        const r = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 160,
          system: `Eres AnastasIA, asesora de laptops ASUS Colombia. Español claro y profesional, sin jerga, trata al cliente de "tú".
El cliente ya eligio esta laptop: ${elegida.title}
DATO EXACTO de su ficha sobre ${nombreCampo}: ${valor.replace(/"/g, "'")}
REGLAS:
- Responde SOLO su pregunta usando ESE dato tal cual. No agregues numeros ni caracteristicas que no esten en el dato.
- Maximo 2 frases. Puedes cerrar invitando a dar clic en "Ver producto".
- No menciones otras laptops. Texto plano, sin JSON, sin listas.`,
          messages: [{ role: "user", content: query }],
        });
        ans = (r.content[0]?.text || "").trim();
      } catch (e) {
        console.error("⚠️ Respuesta de spec fallo:", e.message);
      }
      if (!ans) ans = `En la ${elegida.title}, ${nombreCampo} es: ${valor}.`;
      if (session) {
        session.history.push({ role: "user", content: query });
        session.history.push({ role: "assistant", content: ans });
      }
      console.log(`📄 Pregunta de ficha (${campoPreg}) respondida con dato del feed`);
      trackWeb({
        session_id: sessionId || ip, message_type: "model_question",
        query: query.slice(0, 500), bot_message: ans.slice(0, 500),
        products_shown: elegida.title.slice(0, 500), products_count: 0,
      });
      return res.json({ message: ans, items: [] });
    }

    const specQuestion = isSpecQuestion(q) && (session?.selectedProduct || session?.shownProducts?.length);

    // Preguntas de idoneidad sobre la laptop ya elegida ("aguanta autocad?")
    // tambien son seguimiento: se juzgan con su ficha, no abren busqueda nueva.
    const usoSobreElegida = !!(session?.selectedProduct && PREGUNTA_USO.test(q));
    // Comparar lo ya mostrado: se responde con esas mismas laptops, sin buscar de nuevo.
    const comparaLoVisto = !!(session?.shownProducts?.length && COMPARACION.test(q));

    // Sin laptops en pantalla, las preguntas comparativas ("cual es la mejor")
    // son una busqueda, no un seguimiento. Solo las de informacion general
    // (envio, garantia, pago, saludos) se responden sin contexto.
    const infoGeneral = hasWord(q, [
      "cuanto tarda","cuánto tarda","cuanto demora","tiempo de entrega","tiempo de envio","tiempo de envío",
      "cuando llega","cuándo llega","dias habiles","días hábiles","envio","envío","envian","entrega","entregan",
      "domicilio","despacho","despachan","garantia","garantía","formas de pago","medios de pago","puedo pagar",
      "aceptan","cuotas","financiacion","financiación","tarjeta de credito","addi","sistecredito","pse",
      "contraentrega","checkout","como compro","cómo compro","como pago","cómo pago","proceso de compra",
      "factura","facturacion","facturación","gracias","muchas gracias","listo","perfecto","de una","vale",
      "entendido","buenisimo","buenísimo","chevere","chévere","bacano",
    ]);
    const esSeguimiento = hayContexto ? isFollowUp(q) : infoGeneral;

    if (esSeguimiento || isModelPick || specQuestion || usoSobreElegida || comparaLoVisto) {
      const tFollow = Date.now();
      const shown = session?.shownProducts || [];
      const picked = session?.selectedProduct;
      const pickedLine = picked
        ? `\nEl cliente YA ELIGIO esta laptop: ${picked.title} — ${picked.specs || ""}.${picked.ficha ? `\nFICHA COMPLETA de esa laptop (usala para responder preguntas de specs): ${picked.ficha}` : ""} Si pregunta por un spec de ella (RAM, procesador, disco, pantalla, grafica, teclado), respondele con el valor exacto de esa ficha. Si el dato NO aparece ahi, dilo con honestidad y ofrece que un asesor lo confirme. NO muestres otras laptops.`
        : "";
      const shownList = shown.length
        ? `\nLaptops que el cliente YA vio en esta conversacion (puedes referirte a ellas por nombre):\n${shown.map((p, i) => `${i+1}. ${p.nombreTarjeta || p.title} (en la tarjeta aparece asi) — ${p.specs || ""}${p.ficha ? ` || FICHA: ${p.ficha}` : ""}`).join("\n")}`
        : "";
      const histMsgs = session?.history?.slice(-MAGENTO_HISTORY_TURNS) || [];

      let followResp = null;
      try {
      followResp = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 250,
        system: `Eres AnastasIA, asesora de laptops ASUS Colombia. Entiendes la jerga colombiana si el cliente la usa, pero TU respondes en español claro y profesional, sin jerga ni modismos.
El cliente ya vio recomendaciones de laptops y ahora hace una pregunta de seguimiento (envío, garantía, pago, o cuál elegir).${pickedLine}${shownList}
REGLAS:
- Responde SOLO la pregunta, en 1-2 frases cortas, español neutro y profesional, sin jerga.
- Al comparar, usa SOLO los datos que aparecen en la lista de arriba. Si una laptop no dice OLED, tactil o dedicada, NO se lo atribuyas. Si dos comparten un dato, dilo tal cual ("las dos traen 16GB"). Inventar una caracteristica es peor que no mencionarla.
- Nombra las laptops EXACTAMENTE como aparecen en la tarjeta (el nombre entre parentesis de la lista de arriba). NUNCA uses codigos internos tipo "UM3406KA" o "FX607VJB": el cliente no los ve en la tarjeta y no sabria a cual te refieres.
- Si el cliente pide COMPARAR o pregunta las diferencias entre las que ya vio: comparalas SOLO entre esas, por nombre, usando la lista de arriba. Nombra 2 o 3 diferencias concretas (procesador, pantalla, RAM, almacenamiento, precio) y cierra sugiriendo cual le conviene segun su uso. Refierete a cada laptop por el NOMBRE que el cliente vio en la tarjeta, nunca por un codigo interno de modelo que no aparece en pantalla. NO menciones ninguna laptop que no este en esa lista. Aqui puedes usar hasta 4 frases.
- ANTES de decir que no tienes un dato (teclado, bateria, puertos, peso, sistema operativo, que trae en la caja), BUSCALO en la FICHA COMPLETA de arriba. Solo di que no lo tienes si de verdad no aparece ahi. Si aparece, responde con el texto exacto de la ficha.
- NO listes tarjetas de producto nuevas. Si el cliente pregunta cual le conviene o elige una de las que vio, puedes mencionarla POR NOMBRE (de la lista de arriba) y dar un criterio breve, pero sin reabrir busqueda.
- Si pregunta por envíos: en Colombia la entrega suele ser 2-3 días hábiles según ciudad.
- Si pregunta por garantía: las laptops ASUS tienen garantía oficial; los detalles los confirma el asesor.
- Si pregunta por pago/financiación o checkout: se manejan varios medios de pago en la tienda; para finalizar la compra el cliente da clic en "Ver producto" y completa el checkout en la tienda. El asesor ayuda con el detalle.
- Si elige un modelo: confirma su eleccion, felicitalo brevemente y dile que puede dar clic en "Ver producto" de esa laptop para comprarla. NO muestres otras.
- Si es un agradecimiento o cierre: responde con cortesía breve y ofrece seguir ayudando.
- Si el cliente reclama que falta un spec que pidio (ej: "pero no tiene i9", "ninguna tiene 32GB"): reconoce con honestidad que ahora mismo no hay en la tienda exactamente ese spec, y explica brevemente por que las que le mostraste igual le sirven (ej: "Cierto, justo ahora no tenemos i9 disponible, pero el Ryzen 7 de la TUF rinde parejito para gaming"). NUNCA digas que una laptop tiene un spec que no tiene.
- IDONEIDAD DE USO (importante): si el cliente pregunta si la laptop le sirve para algo (Excel, Office, Zoom, clases, programar, AutoCAD, Photoshop, edicion de video, gaming), JUZGALO con los datos de la FICHA COMPLETA de arriba y responde con honestidad. Guia rapida: ofimatica, clases y videollamadas los cumple cualquier laptop del catalogo; programar y multitarea piden 16GB de RAM o mas; AutoCAD 2D y edicion de fotos piden 16GB y de preferencia grafica dedicada; render 3D, edicion de video 4K y gaming exigente piden RTX dedicada y 32GB. Si la laptop no alcanza, dilo claro y explica que le faltaria. Nunca digas que sirve para todo.
- IDONEIDAD PARA GAMING: si el cliente pregunta si una laptop especifica sirve para gaming, juzga HONESTAMENTE por su tarjeta grafica:
  - Es buena para gaming SOLO si tiene GPU dedicada NVIDIA (RTX o GTX). Ej: RTX 5050, RTX 4050, RTX 3050.
  - NO es para gaming si tiene graficos integrados (Radeon integrada, Intel Graphics, Intel Arc, Adreno, Radeon Graphics). Estas son para trabajo/estudio. Dilo claro: "esa es mas para trabajo y estudio, no para gaming exigente".
  - Mira la lista de arriba para ver que GPU tiene la laptop por la que preguntan. NUNCA llames "gaming" a una con graficos integrados.
- Devuelve SOLO texto plano, sin JSON, sin markdown.`,
        messages: [...histMsgs, { role: "user", content: query }],
      });
      } catch (apiErr) {
        console.error("⚠️ Claude no respondio en seguimiento:", apiErr.message);
      }
      let followText = (followResp?.content?.[0]?.text || "").trim();
      // Respaldo: sin IA no se abre una busqueda nueva ni se tiran tarjetas;
      // se responde con honestidad y se ofrece un asesor.
      let followEscala = false;
      if (!followText) {
        followText = picked
          ? `Para darte ese detalle de la ${picked.title} con precision, mejor te lo confirma un asesor. Da clic en "Hablar con asesor".`
          : `Un asesor te puede ayudar con ese detalle. Da clic en "Hablar con asesor".`;
        followEscala = true;
      }
      console.log(`AnastasIA CO follow-up: ${Date.now() - tFollow}ms`);

      if (session) {
        if (isModelPick && !specQuestion) {
          const hit = shown.find(p => {
            const m = (p.model || "").toLowerCase().replace(/[^a-z0-9]/g, "");
            return (m.length >= 4 && q.replace(/[^a-z0-9]/g, "").includes(m)) ||
                   q.split(/\s+/).filter(w => w.length > 2 && p.title.toLowerCase().includes(w)).length >= 2;
          });
          if (hit) session.selectedProduct = hit;
        }
        session.history.push({ role: "user", content: query });
        session.history.push({ role: "assistant", content: followText });
        if (session.history.length > MAGENTO_HISTORY_TURNS * 2) session.history = session.history.slice(-MAGENTO_HISTORY_TURNS * 2);
      }

      trackWeb({
        session_id: sessionId || ip,
        message_type: "follow_up",
        query: query.slice(0, 500),
        bot_message: followText.slice(0, 500),
      });

      return res.json({ message: followText, escalate: followEscala, items: [] });
    }

    // Si el cliente nombro un modelo en un mensaje anterior y ahora lo confirma,
    // isModelPick ya lo resolvio arriba. Aqui solo seguimos con la seleccion.
    // ── SELECCION DE PRODUCTOS ────────────────────────────────────────
    // Todo el ranking vive en search-co.js. Aqui solo se redacta.
    // ¿Nombró un modelo que no tenemos? Se le dice antes de mostrar parecidas.
    const codigoPedido = (q.match(/\b[a-z]{1,3}\d{3,4}[a-z0-9-]{0,12}\b/gi) || [])
      .filter(c => c.replace(/[^a-z0-9]/gi, "").length >= 5);
    let notaModelo = "";
    if (codigoPedido.length) {
      const existe = catalog.some(p => {
        const m = `${p.model} ${p.partNumber} ${p.title}`.toLowerCase().replace(/[^a-z0-9]/g, "");
        return codigoPedido.some(c => m.includes(c.toLowerCase().replace(/[^a-z0-9]/g, "")));
      });
      if (!existe) {
        notaModelo = `IMPORTANTE: el cliente pidio un modelo puntual (${codigoPedido[0]}) que NO esta en la tienda. Dilo con honestidad en la primera frase y presenta estas como las opciones mas parecidas que si tenemos.`;
        console.log(`🔎 Modelo no disponible: ${codigoPedido[0]}`);
      }
    }

    const sel = selectProducts(catalog, query, intent, 3);

    // Caso: pidio gaming pero su presupuesto no alcanza para ninguna gaming.
    if (sel.mode === "gaming_over_budget") {
      const gTxt = sel.cheapestEligible ? formatCOP(sel.cheapestEligible) : "";
      const gPrompt =
        `Eres AnastasIA, asesora de laptops ASUS Colombia, con tono profesional y cercano, en español claro sin jerga ni modismos.
El cliente quiere una laptop para GAMING${sel.budget ? ` con presupuesto de ${formatCOP(sel.budget)}` : ""}.
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
        gMsg = `En ese presupuesto no tengo laptops gaming de verdad${gTxt ? `; las gaming arrancan alrededor de ${gTxt}` : ""}. ¿Hasta cuánto podrías estirar para conseguir una que rinda bien en juegos?`;
      }
      if (session) {
        session.history.push({ role: "user", content: query });
        session.history.push({ role: "assistant", content: gMsg });
      }
      console.log(`🎮 Gaming sin opciones en presupuesto → mensaje honesto, sin tarjetas`);
      trackWeb({
        session_id: sessionId || ip,
        message_type: "gaming_no_budget",
        query: query.slice(0, 500),
        bot_message: gMsg.slice(0, 500),
        products_count: 0,
      });
      return res.json({ message: gMsg, items: [] });
    }

    // Caso: pidio una serie puntual que no hay en el feed.
    if (sel.mode === "serie_sin_stock") {
      const nombreSerie = { proart: "ProArt", zenbook: "Zenbook", vivobook: "Vivobook",
        expertbook: "ExpertBook", chromebook: "Chromebook", rog: "ROG", tuf: "TUF Gaming" }[sel.serie] || sel.serie;
      const otras = [...new Set(catalog.filter(p => (p.tipo || "laptop") === "laptop")
        .map(p => { for (const k of ["proart","zenbook","vivobook","expertbook","chromebook","rog","tuf"])
          if (new RegExp(k === "rog" ? "\\brog\\b|strix|scar|zephyrus" : k, "i").test(p.title)) return k; return null; })
        .filter(Boolean))].map(k => ({ proart: "ProArt", zenbook: "Zenbook", vivobook: "Vivobook",
          expertbook: "ExpertBook", chromebook: "Chromebook", rog: "ROG", tuf: "TUF Gaming" }[k]));
      const msg = otras.length
        ? `Ahora mismo no tengo laptops ${nombreSerie} disponibles. Las series que sí tengo son ${otras.join(", ")}. ¿Cuál te gustaría ver?`
        : `Ahora mismo no tengo laptops ${nombreSerie} disponibles en la tienda.`;
      if (session) {
        session.intent.serie = null;
        session.history.push({ role: "user", content: query });
        session.history.push({ role: "assistant", content: msg });
      }
      console.log(`📦 Serie ${sel.serie} sin stock → se ofrecen: ${otras.join(", ")}`);
      trackWeb({ session_id: sessionId || ip, message_type: "serie_sin_stock",
        query: query.slice(0, 500), bot_message: msg.slice(0, 500), products_count: 0 });
      return res.json({ message: msg, items: [] });
    }

    // Caso: no hay NADA que encaje.
    if (sel.mode === "empty" || sel.products.length === 0) {
      const budget = sel.budget;
      const delTipo = catalog.filter(p => (p.tipo || "laptop") === (intent.tipo || "laptop"));
      const cheapest = delTipo.reduce((min, p) => {
        const pr = parseFloat(p.price) || 0;
        return (pr > 0 && pr < min) ? pr : min;
      }, Infinity);
      const cheapestTxt = cheapest !== Infinity ? formatCOP(cheapest) : "";
      const noStockPrompt =
        `Eres AnastasIA, asesora de laptops ASUS Colombia. Tono profesional y cercano, en español claro sin jerga ni modismos.
El cliente pidio: "${query}".
SITUACION: en la tienda NO hay ningún equipo del tipo pedido (${NOMBRE_TIPO[intent.tipo || "laptop"]}) que encaje con ese pedido${budget ? ` (su presupuesto es ${formatCOP(budget)})` : ""}.${cheapestTxt ? ` La laptop mas economica disponible cuesta ${cheapestTxt}.` : ""}
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
          ? `Ahorita no tengo ${NOMBRE_TIPO[intent.tipo || "laptop"]} en ese presupuesto${cheapestTxt ? `; las opciones arrancan alrededor de ${cheapestTxt}` : ""}. ¿Hasta cuánto podrías estirar?`
          : "Cuéntame un poco más (uso y presupuesto) y te busco la mejor opción.";
      }
      if (session) {
        session.history.push({ role: "user", content: query });
        session.history.push({ role: "assistant", content: msg });
      }
      trackWeb({
        session_id: sessionId || ip,
        message_type: "no_stock",
        query: query.slice(0, 500),
        bot_message: msg.slice(0, 500),
        products_count: 0,
      });
      return res.json({ message: msg, items: [] });
    }

    // Pregunta puntual sobre un modelo nombrado: respuesta en texto plano
    // (sin JSON, que es donde se rompia) + la tarjeta de ESA laptop.
    if (sel.exactModel && sel.products.length === 1) {
      const p = sel.products[0];
      let answer = "";
      try {
        const r = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 220,
          system: `Eres AnastasIA, asesora de laptops ASUS Colombia. Español claro y profesional, sin jerga, trata al cliente de "tú".
El cliente se intereso por UNA laptop puntual y SI la tenemos disponible en la tienda.
FICHA: ${p.title}
DESCRIPCION: ${(p.descriptionFull || p.description || "").replace(/"/g, "'")}
Precio: ${formatCOP(parseFloat(p.price) || 0)}${calcPromo(p.regularPrice, p.price) ? ` (en oferta, antes ${formatCOP(parseFloat(p.regularPrice) || 0)})` : ""}
REGLAS:
- Arranca confirmando que SI esta disponible en la tienda.${isSpecQuestion(q) ? `
- El cliente hizo una pregunta puntual sobre sus especificaciones: RESPONDELA con el dato exacto que aparece en la DESCRIPCION (ej: "Trae 64GB LPDDR5X"). Si ese dato NO aparece en la descripcion, dilo con honestidad y sugiere confirmarlo con un asesor. NUNCA lo inventes.` : ""}
- Di en una o dos frases por que es buena opcion y para que usos brilla, basandote SOLO en sus specs reales de la descripcion.
- Si esta en oferta, mencionalo en pocas palabras.
- Cierra invitando a dar clic en "Ver producto" para comprarla.
- NO menciones ni compares otras laptops. NUNCA digas que le muestras varias opciones: solo hay una tarjeta.
- Maximo 3 frases. Texto plano: sin JSON, sin markdown, sin listas, sin jerga.`,
          messages: [{ role: "user", content: query }],
        });
        answer = (r.content[0]?.text || "").trim();
      } catch (e) {
        console.error("⚠️ Respuesta de spec fallo:", e.message);
        answer = "";
      }
      const sp = parseSpecs(p);
      if (!answer) {
        const ficha = [sp.cpu && `procesador ${sp.cpu}`, sp.ram && `${sp.ram} de RAM`, sp.ssd, sp.gpu].filter(Boolean).join(", ");
        const oferta = calcPromo(p.regularPrice, p.price) ? ` Ahora esta en oferta a ${formatCOP(parseFloat(p.price) || 0)}.` : "";
        answer = `Sí, la ${p.title} está disponible en la tienda.${ficha ? ` Trae ${ficha}.` : ""}${oferta} Puedes dar clic en "Ver producto" para comprarla.`;
      }
      const item = itemFromCatalog(p);
      if (session) {
        session.selectedProduct = {
          title: p.title, model: p.model,
          specs: [sp.cpu, sp.ram, sp.ssd, sp.pantalla, sp.gpu, sp.teclado].filter(Boolean).join(" | "),
          ficha: (p.descriptionFull || p.description || "").slice(0, 1200),
        };
        session.shownProducts = [session.selectedProduct];
        session.history.push({ role: "user", content: query });
        session.history.push({ role: "assistant", content: answer });
      }
      console.log(`📄 Modelo nombrado → respuesta en texto + 1 tarjeta`);
      trackWeb({
        session_id: sessionId || ip,
        message_type: "model_question",
        query: query.slice(0, 500),
        bot_message: answer.slice(0, 500),
        products_shown: p.title.slice(0, 500),
        products_count: 1,
      });
      return res.json({ message: answer, items: [item] });
    }

    const productsToSend = sel.products;
    // Si solo hay una tarjeta, esa es "la elegida" para los seguimientos:
    // asi "cuanta ram trae" se responde con el dato exacto de su ficha y no
    // depende de que el modelo lo recuerde.
    if (productsToSend.length === 1 && session) {
      const p = productsToSend[0];
      session.selectedProduct = { title: p.title, model: p.model, specs: p.description };
    }

    // El tipo de mensaje sale del orden REAL que se aplico, no de adivinar.
    const messageType =
      sel.orderedBy === "precio_asc"       ? "budget" :
      sel.orderedBy === "oferta"           ? "oferta" :
      sel.orderedBy === "modelo"           ? "named"  :
      sel.orderedBy === "rendimiento_desc" ? "power"  :
      (intent.cpu || intent.gpu || intent.ram) ? "spec" : "normal";

    const intentMap = {
      budget: `El cliente busca: "${query}". Le mostramos ${productsToSend.length} opciones ordenadas de MENOR a MAYOR precio; la primera es la mas economica de la tienda que encaja con lo que pidio. MESSAGE: frase corta y profesional en español neutro, sin jerga.`,
      power:  `El cliente busca: "${query}". Le mostramos ${productsToSend.length} opciones ordenadas de MAYOR a MENOR rendimiento real (tarjeta grafica y procesador, no precio). MESSAGE: frase corta y profesional en español neutro, sin jerga.`,
      spec:   `El cliente busca: "${query}". Le mostramos ${productsToSend.length} laptops que cumplen la especificacion que pidio. MESSAGE: frase corta y profesional en español neutro, sin jerga.`,
      oferta: `El cliente pregunto que hay en oferta. Le mostramos ${"${productsToSend.length}"} productos con descuento, del mayor al menor descuento. MESSAGE: frase corta que invite a aprovechar, sin exagerar ni inventar porcentajes. Español neutro, sin jerga.`,
      named:  `El cliente pregunto por un modelo especifico y SI lo tenemos disponible.${isSpecQuestion(q) ? ` ADEMAS hizo una pregunta puntual sobre sus especificaciones. RESPONDE ESA PREGUNTA PRIMERO, con el dato exacto que aparece en la descripcion del producto (ej: "Trae 64GB LPDDR5X"). Si ese dato NO aparece en la descripcion, dilo con honestidad y sugiere confirmarlo con un asesor. Despues de responder, una sola frase de por que es buena opcion.` : ` MESSAGE: confirma que esta disponible en la tienda y di en una frase por que es buena opcion y para que usos brilla segun sus specs reales.`} NO ofrezcas alternativas ni la compares con otras: el cliente ya sabe cual quiere. NUNCA digas que le estas mostrando varias opciones: solo hay una tarjeta. Frase corta, profesional, sin jerga.`,
      normal: `El cliente busca: "${query}". Le mostramos ${productsToSend.length} opciones que encajan con lo que pidio, de menor a mayor precio, para que compare. MESSAGE: frase corta y profesional en español neutro, sin jerga.`,
    };
    let userMessage = (notaModelo ? notaModelo + " " : "") + intentMap[messageType];

    // Honestidad: specs pedidos que NINGUNA de estas laptops cumple.
    if (sel.unmet.length) {
      userMessage += ` IMPORTANTE: el cliente pidio ${sel.unmet.join(", ")} y NINGUNA de estas laptops lo tiene. Reconocelo con honestidad en el message y explica brevemente por que las que le mostramos igual le sirven. NUNCA digas que alguna tiene ese spec.`;
    }

    const useLabel = { gaming: "gaming", universidad: "universidad", trabajo: "trabajo", diseno: "diseño", portabilidad: "portabilidad", hogar: "uso en el hogar" };
    const profileUses = (intent.uses || []).map(u => useLabel[u] || u);
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
    let result = null;
    try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1100,
      system: `Eres AnastasIA, asesora experta en laptops ASUS Colombia.
TONO: profesional y cercano, como un buen asesor de tienda. Trata al cliente de "tú". Entiendes la jerga colombiana si el cliente la usa (berraca, parce, plata, etc.), pero TU NUNCA respondes con jerga ni modismos: nada de "parce", "berraca", "marica", "chimba", "parcero". Usa español claro, correcto y amable. Evita ser frío o robótico, pero tambien evita lo demasiado coloquial.

CATALOGO (numerado por posicion):
${productList}

REGLAS (sin comillas dobles en ningun valor de texto):
- "message": frase corta, natural y profesional en español neutro. NUNCA copies el texto del cliente. NUNCA menciones otras marcas. NUNCA uses jerga.
  - NUNCA digas que una linea o modelo "no esta en stock", "no lo tenemos" o "esta agotado". Tu no sabes que hay en bodega: eso lo decide el sistema y te lo diria explicitamente. Si el cliente pidio algo puntual y los productos que te pasaron son otros, presenta lo que hay como alternativa SIN afirmar que lo otro no existe.
  - NUNCA afirmes un orden distinto al que te indicaron arriba. Si te dijeron que van de menor a mayor precio, no digas que van por rendimiento.
  - HONESTIDAD: si el cliente pidio algo especifico (ej: procesador i9, 32GB de RAM, una GPU puntual, una pulgada exacta) y NINGUN producto del catalogo lo cumple, NO finjas que si. Reconoce con naturalidad que ahora mismo no tienes exactamente eso en la tienda y ofrece la alternativa mas cercana explicando por que sirve. Sé honesto pero positivo, nunca inventes que un producto tiene un spec que no tiene.
- "title_display": nombre corto del producto, max 40 caracteres. Si dos productos de esta lista tienen un nombre parecido (por ejemplo "Zenbook A14" y "Zenbook 14"), agregale a cada uno el dato que los distingue (el modelo, el procesador o la pantalla) para que el cliente pueda diferenciarlos de un vistazo.
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
    try {
      result = JSON.parse(raw);
    } catch (parseErr) {
      const lastValid = raw.lastIndexOf("},");
      if (lastValid > 0) {
        try { result = JSON.parse(raw.slice(0, lastValid + 1) + "]}"); console.log(`⚠️ JSON reparado`); }
        catch { result = null; }
      }
    }
    } catch (apiErr) {
      console.error("⚠️ Claude no respondio para las tarjetas:", apiErr.message);
      result = null;
    }

    // Respaldo: si la API falla o el JSON no sirve, las tarjetas se arman con
    // los datos del feed y el mensaje se escribe aqui. Nunca sale una tarjeta
    // pelada ni una respuesta sin texto.
    if (!result) {
      const msgPorTipo = {
        budget: "Estas son las opciones mas economicas que tengo disponibles, de menor a mayor precio.",
        power:  "Estas son las mas potentes que tengo ahora mismo, ordenadas por rendimiento.",
        spec:   "Estas cumplen lo que me pediste. Dale clic en Ver producto para el detalle.",
        oferta: "Estas son las que tenemos en oferta ahora mismo, de mayor a menor descuento.",
        named:  "Si, la tenemos disponible. Dale clic en Ver producto para el detalle.",
        normal: "Estas son las opciones que mejor encajan con lo que buscas.",
      };
      const base = msgPorTipo[messageType] || msgPorTipo.normal;
      result = { message: notaModelo ? `No tengo ese modelo exacto en la tienda. ${base}` : base, items: [] };
      console.log(`↩️ Respaldo sin IA: ${productsToSend.length} tarjeta(s) armadas del catalogo`);
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
      const sp = parseSpecs(p);   // respaldo si el LLM no devolvio specs
      const specsJoined = [ci.cpu || sp.cpu, ci.ram || sp.ram, ci.ssd || sp.ssd, ci.pantalla || sp.pantalla].filter(Boolean).join(" | ")
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
        CPU:                  clean(ci.cpu) || sp.cpu,
        RAM:                  clean(ci.ram) || sp.ram,
        SSD:                  clean(ci.ssd) || sp.ssd,
        PANTALLA:             clean(ci.pantalla) || sp.pantalla,
        GPU:                  clean(ci.gpu) || sp.gpu,
        TECLADO_ES:           clean(ci.teclado_espanol) || sp.teclado,
        EN_CAJA:              clean(ci.en_caja),
        IDEAL_PARA:           clean(ci.ideal_para) || idealPara(p),
        TAGLINE:              clean(ci.tagline) || calcPromo(p.regularPrice, p.price) || taglineFor(p),
        PROMO:                clean(ci.tagline) || calcPromo(p.regularPrice, p.price) || formatCOP(offerNum),
      };
    });

    // Cuando dos tarjetas son de la misma linea ("Zenbook 14" y "Zenbook 14
    // OLED"), el cliente no las distingue. Se les agrega el codigo de modelo.
    const lineaCorta = (t) => (t || "").toLowerCase().replace(/asus|port[aá]til|notebook/g, "")
      .replace(/[^a-z0-9]/g, "").slice(0, 9);
    const cuentaLinea = {};
    mergedItems.forEach(it => { const k = lineaCorta(it.TITLE_DISPLAY); cuentaLinea[k] = (cuentaLinea[k] || 0) + 1; });
    mergedItems.forEach(it => {
      if (cuentaLinea[lineaCorta(it.TITLE_DISPLAY)] < 2) return;
      const src = productsToSend.find(p => p.title === it.TITLE);
      const modelo = String(src?.model || "").split("-")[0].trim();
      if (modelo && modelo.length >= 4 && !it.TITLE_DISPLAY.toUpperCase().includes(modelo.toUpperCase())) {
        it.TITLE_DISPLAY = `${it.TITLE_DISPLAY} ${modelo}`.slice(0, 50);
      }
    });

    // Dos productos de la misma linea pueden quedar con el mismo nombre visible
    // ("ASUS Zenbook 14" y "ASUS Zenbook 14"). Ahi se les agrega el codigo de
    // modelo, que es lo unico que los distingue para el cliente.
    {
      const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const cuenta = {};
      mergedItems.forEach(it => { const k = norm(it.TITLE_DISPLAY); cuenta[k] = (cuenta[k] || 0) + 1; });
      mergedItems.forEach(it => {
        if (cuenta[norm(it.TITLE_DISPLAY)] > 1) {
          const src = productsToSend.find(p => p.title === it.TITLE);
          const codigo = (src?.model || src?.partNumber || "").split(/[-\s]/)[0];
          if (codigo && !it.TITLE_DISPLAY.toUpperCase().includes(codigo.toUpperCase())) {
            it.TITLE_DISPLAY = `${it.TITLE_DISPLAY} ${codigo}`.slice(0, 50);
          }
        }
      });
    }

    // Dos tarjetas con nombre casi igual ("Zenbook A14" y "Zenbook 14") dejan
    // al cliente sin forma de distinguirlas. Si pasa, se agrega el modelo.
    (() => {
      const clave = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9 ]/g, "")
        .split(/\s+/).filter(Boolean).slice(0, 2).join(" ");
      const cuenta = {};
      mergedItems.forEach(it => { const k = clave(it.TITLE_DISPLAY); cuenta[k] = (cuenta[k] || 0) + 1; });
      mergedItems.forEach(it => {
        if (cuenta[clave(it.TITLE_DISPLAY)] < 2) return;
        const src = productsToSend.find(p => p.title === it.TITLE);
        // Solo la parte base del modelo: UX3407QA en vez de UX3407QA-QD232W
        const modelo = (src?.model || src?.partNumber || "").split(/[\s,-]/)[0];
        if (modelo && !it.TITLE_DISPLAY.toLowerCase().includes(modelo.toLowerCase().slice(0, 6))) {
          it.TITLE_DISPLAY = `${it.TITLE_DISPLAY.slice(0, 32).trim()} · ${modelo.slice(0, 14)}`;
        }
      });
    })();

    console.log(`✅ AnastasIA CO devuelve ${mergedItems.length} productos · Total: ${Date.now() - tStart}ms`);

    trackWeb({
      session_id: sessionId || ip,
      message_type: "cards",
      query: query.slice(0, 500),
      bot_message: (result.message || "").slice(0, 500),
      products_shown: mergedItems.map(it => it.TITLE).join(" | ").slice(0, 500),
      products_count: mergedItems.length,
    });

    if (session) {
      session.shownProducts = mergedItems.map(it => {
        const src = productsToSend.find(p => p.title === it.TITLE);
        return {
          title: it.TITLE, nombreTarjeta: it.TITLE_DISPLAY, model: src?.model || "",
          specs: [it.CPU, it.RAM, it.SSD, it.PANTALLA, it.GPU, it.TECLADO_ES].filter(Boolean).join(" | ") || it.SPECS,
          ficha: (src?.descriptionFull || src?.description || "").slice(0, 500),
        };
      });
      session.history.push({ role: "user", content: query });
      session.history.push({ role: "assistant", content: (result.message || "") + " [mostre: " + mergedItems.map(i => i.TITLE).join(", ") + "]" });
      if (session.history.length > MAGENTO_HISTORY_TURNS * 2) session.history = session.history.slice(-MAGENTO_HISTORY_TURNS * 2);
    }

    return res.json({ message: result.message || "", items: mergedItems });

  } catch (err) {
    console.error("❌ Error en AnastasIA CO:", err.message);
    const fallback = selectProducts(catalog, query, newIntent(), 3).products.map(p => {
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
