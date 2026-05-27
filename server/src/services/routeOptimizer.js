import Anthropic from '@anthropic-ai/sdk';
import { db } from './firebase.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function optimizeRoutes(date) {
  // 1. Fetch shipments for this date
  const shipmentsSnap = await db.collection('altorancho_shipments')
    .where('scheduled_date', '==', date)
    .get();

  const validStatuses = new Set(['pending', 'packaged', 'rescheduled', 'assigned']);
  const shipments = shipmentsSnap.docs.map(d => d.data()).filter(s => validStatuses.has(s.status));
  if (shipments.length === 0) return [];

  // Build a set of valid codes for Claude response validation
  const validCodes = new Set(shipments.map(s => s.tracking_code));

  // 2. Clear existing routes for this date (old docs + reset assigned shipments)
  const existingRoutesSnap = await db.collection('altorancho_routes')
    .where('date', '==', date)
    .get();

  if (!existingRoutesSnap.empty) {
    const clearBatch = db.batch();
    for (const doc of existingRoutesSnap.docs) {
      clearBatch.delete(doc.ref);
    }
    // Reset any 'assigned' shipments back to 'packaged' so they can be re-assigned
    for (const doc of shipmentsSnap.docs) {
      if (doc.data().status === 'assigned') {
        clearBatch.update(doc.ref, {
          status: 'packaged',
          route_id: null,
          truck_id: null,
          updated_at: new Date().toISOString(),
        });
      }
    }
    await clearBatch.commit();
    console.log(`[RouteOptimizer] Limpiadas ${existingRoutesSnap.size} rutas anteriores para ${date}`);
  }

  // 3. Fetch config and call Claude
  const configDoc = await db.collection('altorancho_config').doc('logistics_config').get();
  const config = configDoc.exists ? configDoc.data() : defaultConfig();

  const prompt = buildRoutePrompt(shipments, config, date);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text;
  let parsed;
  try {
    const jsonMatch = text.match(/```json\n?([\s\S]*?)\n?```/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[1]) : JSON.parse(text);
  } catch (e) {
    console.error('[RouteOptimizer] Error al parsear JSON de Claude:', text.slice(0, 500));
    throw new Error('La IA devolvió una respuesta inválida. Intentá de nuevo.');
  }

  if (!Array.isArray(parsed.routes)) {
    throw new Error('Respuesta de la IA sin campo "routes". Intentá de nuevo.');
  }

  // 4. Build and commit the new routes — only using validated codes
  const batch = db.batch();
  const routes = [];
  const now = new Date().toISOString();

  for (const route of parsed.routes) {
    // Filter to only codes that actually exist in the shipments collection
    const safeShipments = (route.shipments || []).filter(c => validCodes.has(c));
    const safeOrder = (route.order || []).filter(c => validCodes.has(c));
    // Ensure order contains all safeShipments (add any missing ones at the end)
    const inOrder = new Set(safeOrder);
    for (const c of safeShipments) {
      if (!inOrder.has(c)) safeOrder.push(c);
    }

    if (safeShipments.length === 0) continue;

    const routeId = `route-${date}-${route.truck_id}`;
    const routeRef = db.collection('altorancho_routes').doc(routeId);
    const routeData = {
      id: routeId,
      date,
      truck_id: route.truck_id,
      zone: route.zone,
      shipments: safeShipments,
      order: safeOrder,
      max_capacity: route.max_capacity,
      status: 'draft',
      notes: route.notes || '',
      created_at: now,
      updated_at: now,
    };
    batch.set(routeRef, routeData);
    routes.push(routeData);

    for (const code of safeShipments) {
      batch.update(db.collection('altorancho_shipments').doc(code), {
        route_id: routeId,
        truck_id: route.truck_id,
        scheduled_date: date,
        status: 'assigned',
        updated_at: now,
      });
    }
  }

  // Codes assigned by Claude — unassigned = all valid codes not in any route
  const assignedCodes = new Set(routes.flatMap(r => r.shipments));
  const unassignedCodes = [...validCodes].filter(c => !assignedCodes.has(c));

  batch.set(db.collection('altorancho_routes').doc(`unassigned-${date}`), {
    id: `unassigned-${date}`,
    date,
    type: 'unassigned',
    codes: unassignedCodes,
    updated_at: now,
  });

  await batch.commit();

  // 5. Update status_history (sequential, outside batch)
  for (const route of routes) {
    for (const code of route.shipments) {
      const ref = db.collection('altorancho_shipments').doc(code);
      const doc = await ref.get();
      if (doc.exists) {
        await ref.update({
          status_history: [
            ...(doc.data().status_history || []),
            { status: 'assigned', timestamp: now, note: `Asignado a ${route.truck_id} para ${date}` }
          ],
        });
      }
    }
  }

  console.log(`[RouteOptimizer] ${date}: ${routes.length} rutas creadas, ${unassignedCodes.length} pedidos sin asignar`);
  return routes;
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function buildRoutePrompt(shipments, config, date) {
  const dayOfWeek = DAY_NAMES[new Date(date + 'T12:00:00').getDay()];
  const activeTrucks = config.trucks.filter(t =>
    t.active && (!t.available_days?.length || t.available_days.includes(dayOfWeek))
  );
  const depot = config.depot || {};
  const depotLabel = [depot.name, depot.address, depot.locality, depot.province, 'Argentina']
    .filter(Boolean).join(', ');

  const shipmentList = shipments.map(s => ({
    code: s.tracking_code,
    zone: s.zone,
    address: `${s.address?.street}, ${s.address?.locality || s.address?.city}`,
    num_products: s.products?.length || 1,
    volume_cm3: s.total_volume_cm3 || 0,
    created_at: s.created_at,
  }));

  const truckLines = activeTrucks.map(t => {
    const zones = t.zones_preference?.length
      ? `zonas preferidas: ${t.zones_preference.join(', ')}`
      : 'sin restricción de zona';
    return `- ${t.id} (${t.name}): máximo ${t.max_stops} paradas, capacidad ${t.capacity_m3} m³, ${zones}`;
  }).join('\n');

  const totalCapacity = activeTrucks.reduce((sum, t) => sum + (t.max_stops || 0), 0);
  const totalVolume = shipmentList.reduce((sum, s) => sum + (s.volume_cm3 || 0), 0);
  const totalVolume_m3 = (totalVolume / 1_000_000).toFixed(2);

  return `Sos el optimizador de rutas logísticas de Altorancho, empresa de muebles y decoración en Argentina (GBA y CABA).

FECHA DE REPARTO: ${date}

PUNTO DE PARTIDA (depósito): ${depotLabel}
Todos los camiones salen desde esta dirección al inicio del día. Optimizá el orden de paradas considerando la distancia desde este punto de origen.

CAMIONES DISPONIBLES (${activeTrucks.length} activos, capacidad total: ${totalCapacity} paradas):
${truckLines}

PEDIDOS A ASIGNAR (${shipmentList.length} total, volumen estimado total: ${totalVolume_m3} m³):
${JSON.stringify(shipmentList, null, 2)}

ZONAS GEOGRÁFICAS:
- CABA: Capital Federal (Palermo, Belgrano, Recoleta, Flores, Caballito, etc.)
- GBA_NORTE: Vicente López, San Isidro, Tigre, Pilar, Escobar, San Fernando
- GBA_SUR: Lomas de Zamora, Lanús, Avellaneda, Quilmes, Berazategui
- GBA_OESTE: Morón, Merlo, Moreno, Hurlingham, Ituzaingó, La Matanza
- LA_PLATA: La Plata y alrededores
- OTRO: zona no identificada (incluir al camión con mayor espacio disponible)

REGLAS OBLIGATORIAS:
1. Nunca superes el límite de paradas (max_stops) de cada camión
2. Controlá también que el volumen total asignado a un camión no supere su capacity_m3 (volume_cm3 de cada pedido ÷ 1.000.000 = m³)
3. Si hay más pedidos que capacidad, priorizá los creados antes (campo created_at)
4. Listá los pedidos no asignados en "unassigned"
5. Si un camión tiene zonas preferidas, asignale prioritariamente pedidos de esas zonas; solo usá otras zonas si tiene capacidad sobrante

CRITERIOS DE OPTIMIZACIÓN:
1. El recorrido de cada camión empieza desde el depósito (${depotLabel})
2. Ordená las paradas para minimizar la distancia total recorrida desde el depósito
3. Agrupá pedidos geográficamente cercanos en el mismo camión
4. Un mismo camión puede tener múltiples zonas si son limítrofes (ej: CABA + GBA_NORTE)
5. Para CABA: norte primero (Palermo, Belgrano, Recoleta), luego centro, luego sur
6. Para GBA: empezar desde la zona más lejana al depósito y volver hacia él

Respondé ÚNICAMENTE con un JSON válido, sin texto adicional:
\`\`\`json
{
  "routes": [
    {
      "truck_id": "camion-01",
      "zone": "CABA",
      "shipments": ["ALT-20260526-ABC123", "ALT-20260526-XYZ456"],
      "order": ["ALT-20260526-XYZ456", "ALT-20260526-ABC123"],
      "max_capacity": 25,
      "notes": "Recorrido: Palermo → Belgrano → Recoleta → Centro"
    }
  ],
  "unassigned": [],
  "summary": "Breve descripción de la distribución realizada"
}
\`\`\``;
}

function defaultConfig() {
  return {
    trucks: [
      { id: 'camion-01', name: 'Camión 1', capacity: 15, active: true },
      { id: 'camion-02', name: 'Camión 2', capacity: 12, active: true },
    ],
  };
}
