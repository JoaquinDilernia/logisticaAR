const BASE_URL = `https://api.tiendanube.com/v1/${process.env.TIENDANUBE_STORE_ID}`;
const HEADERS = {
  'Authentication': `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
  'User-Agent': 'Altorancho-Logistica/1.0',
  'Content-Type': 'application/json',
};

async function tnFetch(path, opts = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: HEADERS, ...opts });
  // TN returns 404 "Last page is 0" when a filtered query has no results — treat as empty
  if (res.status === 404) return Array.isArray([]) ? [] : null;
  if (!res.ok) throw new Error(`TN API ${res.status}: ${await res.text()}`);
  return res.json();
}

export function isEnvioPropio(order) {
  if (order.shipping_carrier_name !== null) return false;
  const option = (order.shipping_option || '').toLowerCase();
  return (
    option.includes('puerta a puerta') ||
    option.includes('dentro de tu domicilio') ||
    option.includes('dentro del domicilio') ||
    option.includes('envío propio') ||
    option.includes('envio propio')
  );
}

export function extractZone(shippingOption) {
  const opt = (shippingOption || '').toLowerCase();
  if (opt.includes('caba') || opt.includes('capital')) return 'CABA';
  if (opt.includes('norte')) return 'GBA_NORTE';
  if (opt.includes('sur')) return 'GBA_SUR';
  if (opt.includes('oeste')) return 'GBA_OESTE';
  if (opt.includes('la plata') || opt.includes('laplata')) return 'LA_PLATA';
  return 'OTRO';
}

const LOCALITY_ZONES = {
  CABA: ['palermo', 'belgrano', 'recoleta', 'caballito', 'flores', 'almagro', 'barracas', 'villa urquiza', 'devoto', 'villa del parque', 'villa crespo', 'boedo', 'san telmo', 'montserrat', 'retiro', 'nunez', 'nuñez', 'coghlan', 'villa pueyrredon', 'paternal', 'chacarita', 'colegiales', 'liniers', 'mataderos', 'villa lugano', 'parque avellaneda', 'parque patricios', 'pompeya', 'nueva pompeya'],
  GBA_NORTE: ['vicente lopez', 'vicente lópez', 'san isidro', 'tigre', 'pilar', 'escobar', 'san fernando', 'olivos', 'martinez', 'martínez', 'acassuso', 'beccar', 'boulogne', 'nordelta', 'general pacheco', 'garín', 'garin', 'campana', 'zarate', 'zárate'],
  GBA_SUR: ['lomas de zamora', 'lanus', 'lanús', 'avellaneda', 'quilmes', 'berazategui', 'florencio varela', 'almirante brown', 'esteban echeverria', 'ezeiza', 'san vicente', 'bosques', 'temperley', 'banfield', 'remedios de escalada', 'monte grande'],
  GBA_OESTE: ['moron', 'morón', 'merlo', 'moreno', 'hurlingham', 'ituzaingo', 'ituzaingó', 'la matanza', 'ramos mejia', 'san justo', 'haedo', 'castelar', 'ciudadela', 'tapiales', 'villa tesei', 'paso del rey', 'trujui', 'san antonio de padua', 'gregorio de laferrere'],
  LA_PLATA: ['la plata', 'berisso', 'ensenada', 'city bell', 'gonnet', 'tolosa', 'villa elisa'],
};

export function extractZoneFromAddress({ zipcode, locality, city } = {}) {
  // Try by zipcode ranges (Argentine postal codes)
  if (zipcode) {
    const cp = String(zipcode).trim().toUpperCase();
    // New format: C#### = CABA, B1900 = La Plata area
    if (/^C\d{4}/.test(cp)) return 'CABA';
    const num = parseInt(cp.replace(/\D/g, ''), 10);
    if (!isNaN(num)) {
      if (num >= 1000 && num <= 1499) return 'CABA';
      if (num >= 1600 && num <= 1699) return 'GBA_NORTE';
      if (num >= 1700 && num <= 1799) return 'GBA_OESTE';
      if (num >= 1800 && num <= 1899) return 'GBA_SUR';
      if (num >= 1900 && num <= 1999) return 'LA_PLATA';
    }
  }

  // Try by locality/city name
  const text = [(locality || ''), (city || '')].join(' ').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  for (const [zone, keywords] of Object.entries(LOCALITY_ZONES)) {
    const normalizedKws = keywords.map(k => k.normalize('NFD').replace(/[̀-ͯ]/g, ''));
    if (normalizedKws.some(kw => text.includes(kw))) return zone;
  }

  return 'OTRO';
}

export async function getOrders({ page = 1, perPage = 50, since, status } = {}) {
  let path = `/orders?per_page=${perPage}&page=${page}`;
  if (since) path += `&created_at_min=${since}`;
  if (status) path += `&status=${status}`;
  const result = await tnFetch(path);
  return Array.isArray(result) ? result : [];
}

export async function getOrder(orderId) {
  return tnFetch(`/orders/${orderId}`);
}

export async function updateOrderTracking(orderId, fulfillmentId, trackingCode, trackingUrl) {
  return tnFetch(`/orders/${orderId}/fulfillments/${fulfillmentId}`, {
    method: 'PUT',
    body: JSON.stringify({
      tracking_info: { code: trackingCode, url: trackingUrl },
    }),
  });
}

export async function sendOrderNotification(orderId, message) {
  return tnFetch(`/orders/${orderId}/notifications`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
}
