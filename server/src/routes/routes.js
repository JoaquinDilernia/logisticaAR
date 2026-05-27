import express from 'express';
import { db } from '../services/firebase.js';
import { authMiddleware } from '../middleware/auth.js';
import { optimizeRoutes } from '../services/routeOptimizer.js';

const router = express.Router();
const SHIPMENTS = 'altorancho_shipments';
const ROUTES = 'altorancho_routes';

const WEEKDAYS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

// Builds a clean address string for Google Maps geocoding.
// Strips floor/apartment info that confuses the geocoder and adds zipcode for precision.
function buildMapsAddress(a) {
  if (!a?.street) return null;
  // Remove common Argentine floor/apt patterns from the street string
  const street = a.street
    .replace(/\b(piso|p\.?)\s*\d+[°º]?\s*(depto?|dpto?|dto?|d\.?)?\s*[\w-]*/gi, '')
    .replace(/\b(depto?|dpto?|dto?)\s*[\w-]+/gi, '')
    .replace(/\bpb\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!street) return null;
  const parts = [
    street,
    a.locality || a.city || null,
    a.zipcode || null,
    a.province || 'Buenos Aires',
    'Argentina',
  ];
  return parts.filter(Boolean).join(', ');
}

router.use(authMiddleware);

function toYMD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getMondayOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return d;
}

// GET /week?from=YYYY-MM-DD — returns 7 days of route data
router.get('/week', async (req, res) => {
  try {
    const from = req.query.from
      ? new Date(req.query.from + 'T12:00:00')
      : getMondayOfWeek(new Date());
    from.setHours(0, 0, 0, 0);

    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(from);
      d.setDate(from.getDate() + i);
      return toYMD(d);
    });

    const [shipSnap, routeSnap] = await Promise.all([
      db.collection(SHIPMENTS).where('scheduled_date', 'in', days).get(),
      db.collection(ROUTES).where('date', 'in', days).get(),
    ]);

    const byDate = Object.fromEntries(days.map(d => [d, []]));
    for (const doc of shipSnap.docs) {
      const data = doc.data();
      if (byDate[data.scheduled_date]) {
        byDate[data.scheduled_date].push({ id: doc.id, ...data });
      }
    }

    const routesByDate = {};
    const unassignedByDate = {};
    for (const doc of routeSnap.docs) {
      const data = doc.data();
      if (data.type === 'unassigned') {
        unassignedByDate[data.date] = data.codes || [];
      } else {
        if (!routesByDate[data.date]) routesByDate[data.date] = [];
        routesByDate[data.date].push(data);
      }
    }

    const week = days.map(date => {
      const shipments = byDate[date];
      const routes = routesByDate[date] || [];
      const unassignedCodes = new Set(unassignedByDate[date] || []);
      const zones = [...new Set(shipments.map(s => s.zone).filter(Boolean))];
      const statuses = new Set(shipments.map(s => s.status));

      let status = 'empty';
      if (shipments.length > 0) {
        if (shipments.every(s => s.status === 'delivered')) status = 'completed';
        else if (statuses.has('out_for_delivery') || statuses.has('in_route')) status = 'in_progress';
        else if (routes.length > 0) {
          status = routes.every(r => r.status === 'approved') ? 'approved' : 'draft';
        } else status = 'planned';
      }

      const shipmentList = shipments.map(s => ({
        tracking_code: s.tracking_code,
        tn_order_number: s.tn_order_number,
        customer: s.customer,
        address: s.address,
        zone: s.zone,
        status: s.status,
        products: s.products || [],
        total_volume_cm3: s.total_volume_cm3 || 0,
        unassigned: unassignedCodes.has(s.tracking_code),
      }));

      const d = new Date(date + 'T12:00:00');
      return {
        date,
        weekday: WEEKDAYS_ES[d.getDay()],
        day_num: d.getDate(),
        month_short: d.toLocaleDateString('es-AR', { month: 'short' }),
        total: shipments.length,
        zones,
        status,
        routes,
        unassigned_codes: [...unassignedCodes],
        total_volume_cm3: shipments.reduce((sum, s) => sum + (s.total_volume_cm3 || 0), 0),
        shipments: shipmentList,
      };
    });

    res.json({ week, from: toYMD(from) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /maps-url/:date?truck_id=... — returns Google Maps URL with ordered waypoints
router.get('/maps-url/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const { truck_id } = req.query;

    const [shipSnap, routeSnap] = await Promise.all([
      db.collection(SHIPMENTS).where('scheduled_date', '==', date).get(),
      db.collection(ROUTES).where('date', '==', date).get(),
    ]);

    if (shipSnap.empty) return res.status(404).json({ error: 'Sin envíos para esa fecha' });

    const shipMap = {};
    for (const doc of shipSnap.docs) shipMap[doc.id] = doc.data();

    // Filter out meta-docs (unassigned, etc.) — only real route docs
    const realRoutes = routeSnap.docs.filter(d => !d.data().type);

    let codes = null;
    if (realRoutes.length > 0) {
      const route = truck_id
        ? realRoutes.find(d => d.data().truck_id === truck_id)?.data()
        : realRoutes[0].data();
      codes = route?.order || route?.shipments;
    }
    if (!codes) codes = shipSnap.docs.map(d => d.id);

    const addresses = codes
      .map(code => shipMap[code]?.address)
      .filter(Boolean)
      .map(a => buildMapsAddress(a))
      .filter(Boolean);

    const configDoc = await db.collection('altorancho_config').doc('logistics_config').get();
    const depotCfg = configDoc.exists ? configDoc.data()?.depot : null;
    const DEPOT = depotCfg
      ? [depotCfg.name, depotCfg.address, depotCfg.locality, depotCfg.province, 'Argentina'].filter(Boolean).join(', ')
      : 'Altorancho, Buenos Aires, Argentina';
    const parts = [DEPOT, ...addresses].map(a => encodeURIComponent(a)).join('/');
    const url = `https://www.google.com/maps/dir/${parts}`;

    res.json({ url, stops: addresses.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /optimize/:date — AI optimizes routes for a specific date
router.post('/optimize/:date', async (req, res) => {
  try {
    const routes = await optimizeRoutes(req.params.date);
    res.json(routes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /optimize — legacy endpoint (kept for compatibility)
router.post('/optimize', async (req, res) => {
  try {
    const { date } = req.body;
    if (!date) return res.status(400).json({ error: 'Fecha requerida (YYYY-MM-DD)' });
    const routes = await optimizeRoutes(date);
    res.json(routes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const snap = await db.collection(ROUTES).orderBy('date', 'desc').limit(30).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:date', async (req, res) => {
  try {
    const snap = await db.collection(ROUTES).where('date', '==', req.params.date).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /approve/:routeId — encargado aprueba una ruta
router.post('/approve/:routeId', async (req, res) => {
  try {
    await db.collection(ROUTES).doc(req.params.routeId).update({
      status: 'approved',
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /reorder/:routeId — actualiza el orden de paradas
router.patch('/reorder/:routeId', async (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order debe ser un array' });
    await db.collection(ROUTES).doc(req.params.routeId).update({
      order,
      updated_at: new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /move-shipment/:routeId — mueve un pedido a otra ruta (o a no asignados si target_route_id es null)
router.post('/move-shipment/:routeId', async (req, res) => {
  try {
    const { tracking_code, target_route_id } = req.body;
    if (!tracking_code) return res.status(400).json({ error: 'tracking_code requerido' });

    const fromRef = db.collection(ROUTES).doc(req.params.routeId);
    const fromDoc = await fromRef.get();
    if (!fromDoc.exists) return res.status(404).json({ error: 'Ruta origen no encontrada' });

    const fromData = fromDoc.data();
    const code = tracking_code.toUpperCase();

    const batch = db.batch();

    // Remove from source route
    batch.update(fromRef, {
      shipments: (fromData.shipments || []).filter(c => c !== code),
      order: (fromData.order || []).filter(c => c !== code),
      updated_at: new Date().toISOString(),
    });

    if (target_route_id) {
      const toRef = db.collection(ROUTES).doc(target_route_id);
      const toDoc = await toRef.get();
      if (!toDoc.exists) return res.status(404).json({ error: 'Ruta destino no encontrada' });
      const toData = toDoc.data();
      batch.update(toRef, {
        shipments: [...(toData.shipments || []), code],
        order: [...(toData.order || []), code],
        updated_at: new Date().toISOString(),
      });
      batch.update(db.collection(SHIPMENTS).doc(code), {
        route_id: target_route_id,
        truck_id: toData.truck_id,
        updated_at: new Date().toISOString(),
      });
    } else {
      // Move to unassigned
      batch.update(db.collection(SHIPMENTS).doc(code), {
        route_id: null,
        truck_id: null,
        updated_at: new Date().toISOString(),
      });
      const unassignedRef = db.collection(ROUTES).doc(`unassigned-${fromData.date}`);
      const unassignedDoc = await unassignedRef.get();
      const currentCodes = unassignedDoc.exists ? (unassignedDoc.data().codes || []) : [];
      if (!currentCodes.includes(code)) {
        batch.set(unassignedRef, {
          id: `unassigned-${fromData.date}`,
          date: fromData.date,
          type: 'unassigned',
          codes: [...currentCodes, code],
          updated_at: new Date().toISOString(),
        }, { merge: true });
      }
    }

    await batch.commit();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /assign-shipment — asigna un pedido no asignado a una ruta existente
router.post('/assign-shipment', async (req, res) => {
  try {
    const { date, tracking_code, route_id } = req.body;
    if (!date || !tracking_code || !route_id) {
      return res.status(400).json({ error: 'date, tracking_code y route_id son requeridos' });
    }
    const code = tracking_code.toUpperCase();

    const [routeDoc, unassignedDoc] = await Promise.all([
      db.collection(ROUTES).doc(route_id).get(),
      db.collection(ROUTES).doc(`unassigned-${date}`).get(),
    ]);

    if (!routeDoc.exists) return res.status(404).json({ error: 'Ruta no encontrada' });

    const routeData = routeDoc.data();
    const batch = db.batch();

    batch.update(routeDoc.ref, {
      shipments: [...(routeData.shipments || []), code],
      order: [...(routeData.order || []), code],
      updated_at: new Date().toISOString(),
    });

    if (unassignedDoc.exists) {
      batch.update(unassignedDoc.ref, {
        codes: (unassignedDoc.data().codes || []).filter(c => c !== code),
        updated_at: new Date().toISOString(),
      });
    }

    batch.update(db.collection(SHIPMENTS).doc(code), {
      route_id,
      truck_id: routeData.truck_id,
      status: 'assigned',
      updated_at: new Date().toISOString(),
    });

    await batch.commit();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /dispatch/:routeId — marca todos los envíos de la ruta como out_for_delivery
router.post('/dispatch/:routeId', async (req, res) => {
  try {
    const routeRef = db.collection(ROUTES).doc(req.params.routeId);
    const routeDoc = await routeRef.get();
    if (!routeDoc.exists) return res.status(404).json({ error: 'Ruta no encontrada' });

    const routeData = routeDoc.data();
    const codes = routeData.order || routeData.shipments || [];
    const now = new Date().toISOString();

    const batch = db.batch();
    for (const code of codes) {
      batch.update(db.collection(SHIPMENTS).doc(code), {
        status: 'out_for_delivery',
        updated_at: now,
      });
    }
    batch.update(routeRef, {
      status: 'in_progress',
      dispatched_at: now,
      updated_at: now,
    });
    await batch.commit();

    res.json({ ok: true, dispatched: codes.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /truck-location — el chofer actualiza su posición GPS
router.post('/truck-location', async (req, res) => {
  try {
    const { truck_id, lat, lng, date } = req.body;
    if (!truck_id || lat == null || lng == null) {
      return res.status(400).json({ error: 'truck_id, lat y lng son requeridos' });
    }
    await db.collection('altorancho_trucks').doc(truck_id).set({
      truck_id,
      last_lat: lat,
      last_lng: lng,
      last_seen: new Date().toISOString(),
      ...(date ? { date } : {}),
    }, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /driver/:date/:truckId — vista del chofer: ruta + envíos enriquecidos
router.get('/driver/:date/:truckId', async (req, res) => {
  try {
    const { date, truckId } = req.params;

    const [routeSnap, shipSnap] = await Promise.all([
      db.collection(ROUTES).where('date', '==', date).where('truck_id', '==', truckId).get(),
      db.collection(SHIPMENTS).where('scheduled_date', '==', date).where('truck_id', '==', truckId).get(),
    ]);

    if (routeSnap.empty) return res.status(404).json({ error: 'Ruta no encontrada' });

    const route = { id: routeSnap.docs[0].id, ...routeSnap.docs[0].data() };

    const shipMap = {};
    for (const doc of shipSnap.docs) shipMap[doc.id] = doc.data();

    const codes = route.order || route.shipments || [];
    const stops = codes.map((code, idx) => {
      const s = shipMap[code] || {};
      return {
        index: idx + 1,
        tracking_code: code,
        customer: s.customer || {},
        address: s.address || {},
        maps_address: buildMapsAddress(s.address),
        products: s.products || [],
        status: s.status || 'unknown',
        notes: s.notes || '',
        proof: s.proof || null,
      };
    });

    // Truck GPS position
    const truckDoc = await db.collection('altorancho_trucks').doc(truckId).get();
    const truckGps = truckDoc.exists
      ? { lat: truckDoc.data().last_lat, lng: truckDoc.data().last_lng, last_seen: truckDoc.data().last_seen }
      : null;

    res.json({ route, stops, truck_gps: truckGps });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /delivery-result — el chofer reporta entregado o fallido
router.post('/delivery-result', async (req, res) => {
  try {
    const { tracking_code, result, note, proof_photo } = req.body;
    if (!tracking_code || !result) {
      return res.status(400).json({ error: 'tracking_code y result son requeridos' });
    }
    const validResults = ['delivered', 'delivery_failed'];
    if (!validResults.includes(result)) {
      return res.status(400).json({ error: 'result debe ser delivered o delivery_failed' });
    }

    const code = tracking_code.toUpperCase();
    const ref = db.collection(SHIPMENTS).doc(code);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Envío no encontrado' });

    const now = new Date().toISOString();
    const update = {
      status: result,
      updated_at: now,
      status_history: [...(doc.data().status_history || []), {
        status: result,
        timestamp: now,
        note: note || '',
      }],
    };
    if (proof_photo) {
      update.proof = { photo: proof_photo, timestamp: now };
    }

    await ref.update(update);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
