// ═══════════════════════════════════════════════════════════════
//  ANASTASIA — COLOMBIA  ·  modulo de busqueda
//  repo: anastasia-co   ·   va junto con server.js
// ═══════════════════════════════════════════════════════════════

// search-co.js — capa de intencion + seleccion de productos para AnastasIA CO.
// Unico lugar que decide QUE 3 laptops ve el cliente. server.js solo redacta.
//
// Reglas duras:
//   1. Lo ultimo que dice el cliente sobre su USO manda (reemplaza, no acumula).
//   2. Las palabras de precio cambian el ORDEN, nunca el uso.
//   3. Los superlativos ("la mas X") se resuelven sobre TODO el catalogo elegible.
//   4. Si el cliente pide un spec que no existe en tienda, se reporta en `unmet`
//      para que el prompt lo diga con honestidad en vez de inventarlo.

// ── Tokenizacion ─────────────────────────────────────────────────────
// El bug original: text.includes("top") daba match dentro de "lapTOP", y
// includes("el") dentro de "IntEL". Todo puntuaba igual y el ranking era ruido.
const STOP_ES = new Set([
  "cual","cuál","cuales","cuáles","que","qué","como","cómo","donde","dónde","es","son","esta","este",
  "el","la","los","las","un","una","unos","unas","del","para","con","sin","por","pero","mas","más",
  "muy","hay","tengo","tiene","tienen","quiero","busco","necesito","dame","dime","ver","muestra",
  "mostrar","recomienda","recomiendame","equipo","equipos","laptop","laptops","portatil","portátil",
  "notebook","computador","computadora","pc","asus","favor","gracias","hola","buenas","parce","ome",
  "marica","hermano","señor","señora","algo","cosa","tipo","seria","sería","estaria","estaría",
]);

const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const B = "[^a-z0-9áéíóúñ]";
export const hasTok = (text, w) =>
  new RegExp(`(^|${B})${esc(w.toLowerCase())}(${B}|$)`, "i").test(text);
export const hasAny = (text, list) =>
  list.some(w => (w.includes(" ") ? ` ${text.toLowerCase()} `.includes(w.toLowerCase()) : hasTok(text, w)));

export function tokenize(q) {
  return q.toLowerCase().split(/\s+/)
    .map(w => w.replace(/[¿?¡!.,;:()"'*]/g, ""))
    .filter(w => w.length > 2 && !STOP_ES.has(w));
}

// ── Presupuesto COP ──────────────────────────────────────────────────
// En Colombia una "luca" son mil pesos, NO un millon. El parser viejo leia
// "500 lucas" como $500.000.000 y por eso el filtro no devolvia nada.
const UNITS = { millon: 1e6, millones: 1e6, "millón": 1e6, palo: 1e6, palos: 1e6, luca: 1e3, lucas: 1e3, mil: 1e3 };
const BUDGET_FLOOR = 500000;

export function extractBudget(text) {
  // Los numeros de specs no son dinero: "rtx 4060", "16GB", "144Hz", "1TB".
  // En Peru los montos son de 4 digitos, asi que sin esto "rtx 4060" se leia
  // como un presupuesto de 4.060.
  const q = String(text || "").toLowerCase()
    .replace(/\b(rtx|gtx|geforce|radeon|arc)\s*\d{3,4}\s*(ti|super)?\b/g, " ")
    .replace(/\b\d{1,4}\s*(gb|tb|mb|hz|wh|mah|nits|mpx|mp|w)\b/g, " ")
    .replace(/\b(i[3579]|ryzen|core|ultra|snapdragon|celeron|pentium)[\s-]*\d{0,5}\w*/g, " ")
    .replace(/\b\d{2}(\.\d)?\s*(pulgadas|pulg|")/g, " ")
    .replace(/\b(ddr|lpddr|pcie|usb|wifi|bluetooth)\s*\d(\.\d)?\w*/g, " ")
    .replace(/\s+/g, " ");
  const m = q.match(new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(${Object.keys(UNITS).join("|")})\\b`));
  if (m) {
    const n = Math.round(parseFloat(m[1].replace(",", ".")) * UNITS[m[2]]);
    return n >= BUDGET_FLOOR ? n : null;
  }
  const n2 = q.match(/(\d[\d.,]{5,})/);
  if (n2) {
    const n = parseInt(n2[1].replace(/[.,]/g, ""), 10);
    if (n >= BUDGET_FLOOR) return n;
  }
  return null;
}

// ── Intencion ────────────────────────────────────────────────────────
export const USE_PATTERNS = {
  gaming:       /(gaming|gamer|jugar|juego|juegos|videojuego|fortnite|valorant|\blol\b|\bgta\b|warzone|\bcod\b|minecraft|dota|csgo|fifa|\bea fc\b)/i,
  universidad:  /(universidad|\bla u\b|\buni\b|estudiar|estudio|estudiante|carrera|tesis|colegio|clases|programar|programaci[oó]n|ingenier[ií]a)/i,
  trabajo:      /(trabajo|trabajar|oficina|ofim[aá]tica|excel|contabilidad|negocio|empresa|teletrabajo|home office|facturaci[oó]n|profesional|profesionales|ejecutiv|consultor|trabajo remoto|remoto|viajo por trabajo|reuniones)/i,
  diseno:       /(dise[nñ]o|dise[nñ]ar|autocad|solidworks|revit|render|\b3d\b|edici[oó]n de video|editar video|photoshop|illustrator|premiere|arquitectura|fotograf|creador|creadores|creaci[oó]n de contenido|streaming|modelado|animaci[oó]n)/i,
  portabilidad: /(liviana|liviano|ligera|ligero|delgada|delgado|ultraligera|ultradelgada|para llevar|llevarla|llevarlo|de viaje|viajo|premium|elegante|bater[ií]a que dure|larga duraci[oó]n|todo el d[ií]a)/i,
  hogar:        /(para (la )?casa|para el hogar|uso personal|d[ií]a a d[ií]a|dia a dia|familiar|para la familia|uso general|b[aá]sic[oa]|navegar|netflix|series y peliculas|redes sociales|tareas del hogar)/i,
};

const CHANGE = /(en realidad|realmente|mejor|ya no|cambi[eé]|cambio de idea|olvida|olv[ií]date|en vez de|m[aá]s bien|pensandolo bien|pens[aá]ndolo bien|la verdad|no es para|no ser[aá] para)/i;
const ADD    = /(tambi[eé]n|adem[aá]s|aparte|de paso|igual quiero|igual me sirve|y de paso|y para)/i;
const RESET  = /(empecemos de nuevo|empieza de nuevo|desde cero|olvida todo|borra todo|reinicia|otra cosa totalmente)/i;
const NEG    = /(\bno\b|\bnada de\b|\bsin\b|\bnunca\b|\btampoco\b|\bya no\b)/i;

export const CHEAPER = /barat|econ[oó]mic|asequibl|accesibl|menos costos|precio m[aá]s bajo|precio bajo|bajo precio|menor precio|no tan car|muy car|se me pasa|bajo presupuesto|de entrada/i;
export const PRICIER = /m[aá]s potente|potentes|m[aá]s poderos|la mejor\b|el mejor\b|lo mejor\b|gama m[aá]s alta|tope de gama|top gama|gama alta|m[aá]s berrac|m[aá]s top|mayor rendimiento|mejor rendimiento|m[aá]s r[aá]pid/i;

// Que tipo de equipo pide el cliente. Por defecto, laptop.
const TIPO_PEDIDO = [
  [/\bally\b|steam deck|handheld|consolas? port[aá]til(es)?|consola de mano|consola gamer|consola de juegos/i, "handheld"],
  [/all in one|all-in-one|todo en uno|todo-en-uno|\baio\b/i, "aio"],
  [/\btorre\b|\btorres\b|\btower\b|desktop|de escritorio|de mesa|computadores? de mesa|\bpc gamer\b|g700/i, "torre"],
  [/\blaptop\b|\blaptops\b|port[aá]til|portatil|notebook/i, "laptop"],
];

// Series del menu del sitio ASUS Colombia.
export const SERIES = {
  proart:     /\bproarts?\b|studiobooks?/i,
  zenbook:    /\bzenbooks?\b/i,
  vivobook:   /\bvivobooks?\b/i,
  expertbook: /\bexpertbooks?\b/i,
  chromebook: /\bchromebooks?\b/i,
  rog:        /\brog\b|strix|\bscar\b|zephyrus/i,
  tuf:        /\btufs?\b/i,
};

export function seriePedida(q) {
  for (const [nombre, re] of Object.entries(SERIES)) if (re.test(q || "")) return nombre;
  return null;
}

export function esDeSerie(p, serie) {
  return SERIES[serie] ? SERIES[serie].test(`${p.title || ""} ${p.model || ""}`) : false;
}

export function tipoPedido(q) {
  for (const [re, tipo] of TIPO_PEDIDO) if (re.test(q || "")) return tipo;
  return null;
}

export const newIntent = () => ({ uses: [], budget: null, cpu: null, gpu: null, ram: null, tipo: "laptop", serie: null, turn: 0 });

export function updateIntent(state, message) {
  const st = state || newIntent();
  st.turn++;
  const msg = (message || "").toLowerCase();
  if (RESET.test(msg)) { const f = newIntent(); f.turn = st.turn; return f; }

  // Clausulas: la negacion aplica solo a su pedazo de la frase.
  const clauses = msg.split(/[,.;]|\bpero\b|\baunque\b|\bsino\b/).map(c => c.trim()).filter(Boolean);
  const mentioned = new Set(), negated = new Set();
  for (const c of clauses) {
    const uses = Object.entries(USE_PATTERNS).filter(([, re]) => re.test(c)).map(([u]) => u);
    if (!uses.length) continue;
    const target = NEG.test(c) ? negated : mentioned;
    uses.forEach(u => target.add(u));
  }
  if (mentioned.size) {
    if (ADD.test(msg) && !CHANGE.test(msg)) mentioned.forEach(u => { if (!st.uses.includes(u)) st.uses.push(u); });
    else st.uses = [...mentioned];                       // ← lo ultimo manda
  }
  if (negated.size) st.uses = st.uses.filter(u => !negated.has(u));

  const t = tipoPedido(msg);
  if (t) st.tipo = t;

  const serie = seriePedida(msg);
  if (serie) st.serie = serie;
  else if (CHANGE.test(msg) || mentioned.size || CHEAPER.test(msg) || PRICIER.test(msg) ||
           tipoPedido(msg) || extractBudget(msg) ||
           /\b(que|qu[eé])\s+(tienes|tienen|hay|manejan)\b|mu[eé]strame|muestrame|otras opciones|todas las/i.test(msg)) {
    // Una busqueda nueva suelta la serie: si pidio Zenbooks y luego pregunta
    // "cual es la mas potente", quiere la mas potente del catalogo, no la mas
    // potente Zenbook.
    st.serie = null;
  }
  else if (mentioned.size) st.tipo = "laptop";   // uso nuevo sin decir tipo → laptop

  const b = extractBudget(msg);
  if (b) st.budget = b;

  if (CHANGE.test(msg)) { st.cpu = null; st.gpu = null; st.ram = null; }

  const cpu = msg.match(/\bi[3579]\b/) || msg.match(/\bryzen\s*[3579]\b/) || msg.match(/\bcore ultra\s*[579]\b/);
  if (cpu) st.cpu = cpu[0].replace(/\s+/g, " ").trim();
  const gpu = msg.match(/\b(rtx|gtx)\s*(\d{3,4})\b/);
  if (gpu) st.gpu = `${gpu[1]}${gpu[2]}`.toLowerCase();
  const ram = msg.match(/\b(\d{1,2})\s*gb\b/);
  if (ram) st.ram = `${ram[1]}gb`;
  return st;
}

// "¿Qué tienen en oferta?" debe mostrar SOLO lo que tiene descuento.
export const SOLO_OFERTA = /(en oferta|ofertas|con descuento|descuentos|rebajad|promoci[oó]n|promociones|liquidaci[oó]n|black friday|cyber)/i;

function pctDescuento(p) {
  const r = parseFloat(p.regularPrice) || 0, o = parseFloat(p.price) || 0;
  return r > o && r > 0 ? (1 - o / r) : 0;
}

export function sortDirection(message) {
  const m = (message || "").toLowerCase();
  if (CHEAPER.test(m)) return "asc";
  if (PRICIER.test(m)) return "desc";
  return null;
}

// ── Clasificacion de producto ────────────────────────────────────────
// El feed trae ® y ™ dentro de los specs ("RTX™ 5090"). Sin quitarlos, el
// filtro de gaming y el orden por rendimiento leen el catalogo a ciegas.
const txt = (p) =>
  `${p.title || ""} ${p.descriptionFull || p.description || ""} ${p.category || ""} ${p.model || ""}`
    .replace(/[\u00ae\u2122\u00a9]/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();

export function isGamingProduct(p) {
  const t = txt(p);
  if (/integrad|intel graphics|intel hd|iris xe|adreno|radeon graphics/.test(t)) {
    return /\brtx\s*\d{3,4}|\bgtx\s*\d{3,4}/.test(t);
  }
  return /gaming|\btuf\b|\brog\b|strix|\brtx\b|\bgtx\b|nitro/.test(t);
}

// "La mas potente" no es "la mas cara". Se ordena por hardware real.
export function powerScore(p) {
  const t = txt(p);
  let s = 0;
  const g = t.match(/\b(rtx|gtx)\s*(\d{4})\b/);
  if (g) s += parseInt(g[2].slice(2), 10) + parseInt(g[2][0], 10) * 2;  // 5060 → 60+10; 5050 → 50+10
  else if (/arc|iris xe|radeon graphics|integrad/.test(t)) s += 5;
  if (/\b(i9|ryzen 9|core ultra 9|core 9[\s-]?\d)/.test(t)) s += 18;
  else if (/\b(i7|ryzen 7|core ultra 7|core 7[\s-]?\d)/.test(t)) s += 12;
  else if (/\b(i5|ryzen 5|core ultra 5|core 5[\s-]?\d)/.test(t)) s += 7;
  // Sufijo del procesador: HX/HK son chips de escritorio y rinden mas que los H,
  // y los U/V son de bajo consumo. Por eso una 275HX gana a una 386H.
  if (/\b\d{3,5}(hx|hk)\b/.test(t)) s += 6;
  else if (/\b\d{3,5}h\b/.test(t)) s += 3;
  const ram = t.match(/\b(\d{2})\s*gb\b/);
  if (ram) s += Math.min(parseInt(ram[1], 10) / 4, 8);
  return s;
}

// Señales ponderadas: una RTX suma poco para diseño y mucho para gaming.
// Con un peso plano, cualquier TUF empataba con la ProArt en "diseño".
const AFFINITY = {
  // Gaming: ROG y TUF Gaming. Integrados restan fuerte.
  gaming:       [[/\brog\b|strix|scar|zephyrus/i, 9], [/\btuf\b|gaming/i, 7], [/\brtx\b|\bgtx\b/i, 6],
                 [/144\s*hz|165\s*hz|240\s*hz|300\s*hz/i, 3],
                 [/integrad|iris xe|radeon graphics|intel graphics|intel arc/i, -12]],
  // Universidad: Vivobook y tambien TUF Gaming ("estudia y juega"). La gama
  // alta de creador/gaming extremo no es lo que busca un estudiante.
  // Estudiantes: Vivobook y TUF lideran (menu del sitio), pero el Zenbook entra
  // como la opcion premium del escalon alto para quien puede pagarla.
  universidad:  [[/vivobook/i, 8], [/zenbook/i, 8], [/\btuf\b/i, 6], [/chromebook/i, 5],
                 [/\bi5\b|ryzen 5|core 5/i, 3], [/\b14\b|\b15\.6\b|\b16\b/i, 2],
                 [/proart|scar|zephyrus|\b18\b/i, -5]],
  // Oficina: ExpertBook y Chromebook. Las gaming no van aqui.
  trabajo:      [[/expertbook/i, 10], [/zenbook/i, 8], [/chromebook/i, 7], [/windows 11 pro/i, 5],
                 [/vivobook/i, 5], [/huella|fingerprint/i, 4], [/1\.[0-4]\s*kg|liviana|delgada/i, 3],
                 [/gaming|\btuf\b|\brog\b|strix|scar|zephyrus/i, -8]],
  // Creadores: ProArt primero, luego Zephyrus y los OLED de alta resolucion.
  diseno:       [[/proart/i, 12], [/zephyrus/i, 8], [/\boled\b/i, 6], [/zenbook/i, 5],
                 [/pantone|dci-p3|calman|100% adobe/i, 5],
                 [/3\.2k|\b3k\b|2\.8k|\bqhd\b|\b4k\b/i, 4],
                 [/\b32\s*gb\b|\b64\s*gb\b/i, 3], [/\brtx\b/i, 3]],
  // Para el Hogar: Zenbook, Vivobook y ProArt segun el menu del sitio.
  hogar:        [[/zenbook/i, 8], [/vivobook/i, 8], [/proart/i, 4], [/\boled\b/i, 3],
                 [/expertbook|chromebook/i, 2], [/gaming|\btuf\b|\brog\b|strix|scar/i, -4]],
  portabilidad: [[/zenbook/i, 12], [/expertbook|vivobook go/i, 7], [/1\.[0-4]\s*kg/i, 6],
                 [/\boled\b/i, 4], [/liviana|delgada|ultraligera|ultradelgad/i, 4],
                 [/\b\d{2}\s*wh\b|carga r[aá]pida/i, 3], [/\b13\b|\b14\b/i, 3],
                 [/\b17\b|\b18\b|gaming|\btuf\b|\brog\b/i, -8]],
};

const price = (p) => parseFloat(p.price) || 0;

// Reparte n opciones a lo largo del rango de precio de la lista corta.
function priceLadder(list, n) {
  const byPrice = [...list].sort((a, b) => price(a) - price(b));
  if (byPrice.length <= n) return byPrice;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = byPrice[Math.round((i * (byPrice.length - 1)) / (n - 1))];
    if (!out.includes(p)) out.push(p);
  }
  for (const p of byPrice) { if (out.length >= n) break; if (!out.includes(p)) out.push(p); }
  return out.sort((a, b) => price(a) - price(b));
}

function keywordScore(p, words) {
  const t = `${txt(p)} ${p.link || ""}`;
  return words.reduce((a, w) => a + (hasTok(t, w) ? 5 : 0), 0);
}

function affinityScore(p, uses) {
  const t = txt(p);
  let s = 0;
  for (const u of uses) {
    for (const [re, w] of (AFFINITY[u] || [])) if (re.test(t)) s += w;
  }
  return s;
}

// ── Modelo nombrado ──────────────────────────────────────────────────
// Si el cliente escribe un SKU o el nombre de una linea puntual, ESE es el
// resultado. No se diluye con alternativas ni pasa por la escalera de precio.
const GENERICO = new Set([
  "asus","portatil","portátil","laptop","notebook","computador","computadora","gaming","gamer",
  "intel","amd","ryzen","core","ultra","rtx","gtx","geforce","nvidia","radeon","ssd","ram","oled",
  "fhd","qhd","pulgadas","pulgada","rog","tuf","quiero","dije","esta","este","para","con","que",
  "los","las","del","una","uno","interesada","interesado","estoy","busco","necesito","mostrar",
  "ver","precio","tienda","serie","modelo","2024","2025","2026","gama",
]);

export function findNamedModel(catalog, query, max = 3) {
  const q = (query || "").toLowerCase();
  const qNorm = q.replace(/[^a-z0-9]/g, "");
  const codes = (q.match(/[a-z]{1,3}\d{3,4}[a-z0-9-]*/g) || []).map(c => c.replace(/[^a-z0-9]/g, "")).filter(c => c.length >= 6);
  const words = q.split(/\s+/).map(w => w.replace(/[^a-z0-9áéíóúñ]/g, "")).filter(w => w.length >= 3 && !GENERICO.has(w));

  let best = 0;
  const scored = catalog.map(p => {
    const modelNorm = (p.model || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const partNorm  = (p.partNumber || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const title     = (p.title || "").replace(/[\u00ae\u2122\u00a9]/g, " ").toLowerCase();
    let s = 0;
    if (modelNorm.length >= 5 && qNorm.includes(modelNorm)) s += 10;
    if (partNorm.length >= 6 && qNorm.includes(partNorm)) s += 10;
    for (const c of codes) if (modelNorm.startsWith(c) || partNorm.startsWith(c)) s += 8;
    s += words.filter(w => title.includes(w)).length * 2;   // ej: "zephyrus" + "duo" = 4
    if (s > best) best = s;
    return { p, s };
  });

  if (best < 4) return [];                       // no nombro nada concreto
  return scored.filter(r => r.s === best).map(r => r.p).slice(0, max);
}

// ── Seleccion ────────────────────────────────────────────────────────
// Devuelve { products, mode, budget, unmet }.
//   mode: "ok" | "empty" | "gaming_over_budget"
//   unmet: specs que el cliente pidio y NINGUN producto devuelto cumple.
export function selectProducts(catalog, query, intent, n = 3) {
  const q = (query || "").toLowerCase();
  const it = intent || newIntent();
  const words = tokenize(q);
  const dir = sortDirection(q);

  // Modelo nombrado: respuesta directa, sin alternativas ni escalera.
  // Un modelo nombrado se busca en TODO el catalogo: si el cliente escribe el
  // nombre de una torre sin decir "torre", igual hay que encontrarla.
  const named = findNamedModel(catalog, query, n);
  if (named.length) {
    return { products: named, mode: "ok", budget: it.budget, unmet: [], orderedBy: "modelo",
             exactModel: true, tipoEncontrado: named[0].tipo || "laptop" };
  }

  // Solo se recomiendan equipos del tipo pedido (laptop por defecto).
  const tipo = it.tipo || "laptop";
  let pool = catalog.filter(p => price(p) > 0 && (p.tipo || "laptop") === tipo);
  const wantsGaming = it.uses.includes("gaming");
  if (wantsGaming) pool = pool.filter(isGamingProduct);
  if (!pool.length) return { products: [], mode: "empty", budget: it.budget, unmet: [] };

  // Serie puntual (Zenbook, ProArt, ExpertBook...): si no hay de esa linea,
  // se dice con honestidad en vez de devolver otra cosa.
  if (it.serie) {
    const deLaSerie = pool.filter(p => esDeSerie(p, it.serie));
    if (!deLaSerie.length) {
      return { products: [], mode: "serie_sin_stock", serie: it.serie, budget: it.budget, unmet: [] };
    }
    pool = deLaSerie;
  }

  // Solo ofertas: se filtra y se ordena por mayor descuento.
  if (SOLO_OFERTA.test(q)) {
    const conOferta = pool.filter(p => pctDescuento(p) > 0);
    if (conOferta.length) {
      const ordenadas = [...conOferta].sort((a, b) => pctDescuento(b) - pctDescuento(a));
      return { products: ordenadas.slice(0, n), mode: "ok", budget: it.budget,
               unmet: [], orderedBy: "oferta" };
    }
  }

  // Presupuesto: techo duro.
  if (it.budget) {
    const within = pool.filter(p => price(p) <= it.budget);
    if (!within.length) {
      const anyWithin = catalog.some(p => price(p) > 0 && price(p) <= it.budget);
      return {
        products: [],
        mode: wantsGaming && anyWithin ? "gaming_over_budget" : "empty",
        budget: it.budget,
        cheapestEligible: Math.min(...pool.map(price)),
        unmet: [],
      };
    }
    pool = within;
  }

  // Specs pedidos: filtro duro solo si existe algo que los cumpla.
  const unmet = [];
  for (const [key, val] of [["cpu", it.cpu], ["gpu", it.gpu], ["ram", it.ram]]) {
    if (!val) continue;
    const needle = val.replace(/\s+/g, "");
    const hit = pool.filter(p => txt(p).replace(/\s+/g, "").includes(needle));
    if (hit.length) pool = hit; else unmet.push(val);
  }

  // Orden.
  let ranked;
  if (dir === "asc") {
    ranked = [...pool].sort((a, b) => price(a) - price(b));
  } else if (dir === "desc") {
    ranked = [...pool].sort((a, b) => powerScore(b) - powerScore(a) || price(b) - price(a));
  } else {
    // Sin superlativo y sin spec puntual: escalera de precio (buena / mejor / tope)
    // dentro de lo que encaja con la intencion. Evita abrir siempre con lo mas caro
    // (afinidad sola) o siempre con lo mas barato (precio solo).
    const scored = [...pool]
      .map(p => ({ p, s: keywordScore(p, words) + affinityScore(p, it.uses) }))
      .sort((a, b) => b.s - a.s || price(a) - price(b));
    // Banda de afinidad: solo compiten los que estan cerca del mejor puntaje.
    // Sin esto la escalera metia una ProArt en una consulta de gaming solo
    // porque su precio caia en el escalon del medio.
    const maxS = scored.length ? scored[0].s : 0;
    // Banda estrecha: solo compiten los que de verdad coinciden con lo pedido.
    // Con la banda ancha, "laptop con pantalla OLED" mostraba TUF que no son OLED
    // porque la escalera de precio repartia entre todos los que empataban abajo.
    const band = maxS > 0 ? scored.filter(r => r.s >= maxS * 0.75) : scored;
    // Si hay un ganador claro por afinidad (muy por encima del segundo), va de
    // primero aunque no sea el mas barato: en "premium delgada" el cliente
    // quiere ver la Zenbook, no la mas economica que tambien encaja.
    const dominante = (scored.length > 1 && scored[0].s >= scored[1].s * 1.25 && scored[0].s > 0)
      ? scored[0].p : null;

    // Una opcion por linea de producto. Sin esto, con un catalogo grande los
    // tres escalones de precio podian caer todos en Vivobook y el cliente
    // nunca veia una Zenbook o una TUF. Ahora ve alternativas de verdad.
    const lineaDe = (p) => {
      // Las series (Zenbook, TUF, ROG...) solo agrupan notebooks. Una placa
      // madre y una fuente ROG son productos distintos, no la misma linea.
      if ((p.tipo || "laptop") === "laptop") {
        const t = txt(p);
        for (const [nombre, re] of Object.entries(SERIES)) if (re.test(t)) return nombre;
      }
      return (p.title || "").split(/\s+/).slice(0, 3).join(" ").toLowerCase();
    };
    const lineasVistas = new Set();
    let base = [];
    for (const r of band) {
      const l = lineaDe(r.p);
      if (lineasVistas.has(l)) continue;
      lineasVistas.add(l);
      base.push(r.p);
      if (base.length >= 8) break;
    }
    if (base.length < n) {
      // Completar SOLO con productos que encajan (puntaje > 0). Si no alcanzan,
      // se devuelven menos tarjetas: una que sirve vale mas que tres de relleno.
      for (const r of scored) { if (base.length >= n) break; if (r.s > 0 && !base.includes(r.p)) base.push(r.p); }
    }
    ranked = priceLadder(base, n);
    if (dominante && ranked.includes(dominante) && ranked[0] !== dominante) {
      ranked = [dominante, ...ranked.filter(p => p !== dominante)];
    }
  }
  // orderedBy le dice al prompt que puede afirmar. En el pantallazo el bot decia
  // "ordenadas de mayor a menor rendimiento" mientras ordenaba por precio.
  const orderedBy = dir === "asc" ? "precio_asc" : dir === "desc" ? "rendimiento_desc" : "afinidad";
  return { products: ranked.slice(0, n), mode: "ok", budget: it.budget, unmet, orderedBy };
}
