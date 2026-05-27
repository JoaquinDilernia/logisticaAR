import express from 'express';
import { db } from '../services/firebase.js';
import { authMiddleware } from '../middleware/auth.js';
import { syncOrders, syncAllOrders } from '../services/orderSync.js';
import { updateOrderTracking, sendOrderNotification } from '../services/tiendaNube.js';
import { buildTrackingUrl, generateTrackingCode } from '../services/tracking.js';
import { autoAssignDate } from '../services/autoAssign.js';

const DRY_RUN = process.env.DRY_RUN === 'true';

const router = express.Router();
const SHIPMENTS = 'altorancho_shipments';

router.use(authMiddleware);

router.get('/shipments', async (req, res) => {
  try {
    const { zone, status, limit = 100 } = req.query;
    let query = db.collection(SHIPMENTS).orderBy('created_at', 'desc');
    if (zone) query = query.where('zone', '==', zone);
    if (status) query = query.where('status', '==', status);
    const snap = await query.limit(Number(limit)).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/shipments/:code/status', async (req, res) => {
  try {
    const { status, note } = req.body;
    const validStatuses = ['pending', 'packaged', 'assigned', 'in_route', 'out_for_delivery', 'delivered', 'rescheduled'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Estado inválido' });

    const ref = db.collection(SHIPMENTS).doc(req.params.code.toUpperCase());
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'No encontrado' });

    await ref.update({
      status,
      status_history: [...(doc.data().status_history || []), {
        status, timestamp: new Date().toISOString(), note: note || ''
      }],
      updated_at: new Date().toISOString(),
    });

    // When marked as packaged: attach tracking to TN and notify customer
    if (status === 'packaged') {
      const data = doc.data();
      const trackingCode = data.tracking_code;
      const trackingUrl = buildTrackingUrl(trackingCode);

      if (DRY_RUN) {
        console.log(`[Admin] [DRY_RUN] Se omitiría updateOrderTracking para orden ${data.order_id} (${trackingCode})`);
        console.log(`[Admin] [DRY_RUN] Se omitiría sendOrderNotification para orden ${data.order_id}`);
      } else {
        if (data.fulfillment_id) {
          await updateOrderTracking(data.order_id, data.fulfillment_id, trackingCode, trackingUrl).catch(e =>
            console.warn(`[Admin] No se pudo actualizar tracking en TN para orden ${data.order_id}:`, e.message)
          );
        }
        await sendOrderNotification(data.order_id,
          `¡Hola ${data.customer?.name || ''}! Tu pedido ya está empaquetado y listo para salir. Seguí el estado de tu envío en tiempo real: ${trackingUrl} — Código de seguimiento: ${trackingCode}`
        ).catch(e => console.warn(`[Admin] No se pudo enviar notificación TN para orden ${data.order_id}:`, e.message));
      }
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/config', async (req, res) => {
  try {
    const doc = await db.collection('altorancho_config').doc('logistics_config').get();
    if (!doc.exists) return res.json(defaultConfig());
    res.json(doc.data());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/config', async (req, res) => {
  try {
    await db.collection('altorancho_config').doc('logistics_config').set(req.body, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sync incremental (solo pedidos nuevos desde último sync)
router.post('/sync', async (req, res) => {
  try {
    const count = await syncOrders();
    res.json({ ok: true, nuevos: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Asignar fecha a todos los envíos sin scheduled_date
// Con reset:true, limpia rutas draft/planned, resetea todos los envíos activos y reasigna desde cero
router.post('/autoassign', async (req, res) => {
  try {
    const { reset = false } = req.body || {};
    const assignableStatuses = ['pending', 'packaged', 'rescheduled'];

    if (reset) {
      const [shipmentsSnap, routesSnap] = await Promise.all([
        db.collection(SHIPMENTS).get(),
        db.collection('altorancho_routes').get(),
      ]);

      // Split into chunks of 400 to stay under Firestore batch limit of 500
      const ops = [];

      for (const doc of shipmentsSnap.docs) {
        const { status } = doc.data();
        if ([...assignableStatuses, 'assigned'].includes(status)) {
          ops.push({ ref: doc.ref, data: {
            scheduled_date: null,
            route_id: null,
            truck_id: null,
            status: status === 'assigned' ? 'packaged' : status,
            updated_at: new Date().toISOString(),
          }});
        }
      }

      for (const doc of routesSnap.docs) {
        const { status } = doc.data();
        // Only delete routes that haven't started yet
        if (!status || ['planned', 'draft', 'approved'].includes(status)) {
          ops.push({ ref: doc.ref, delete: true });
        }
      }

      // Commit in batches of 400
      for (let i = 0; i < ops.length; i += 400) {
        const chunk = ops.slice(i, i + 400);
        const batch = db.batch();
        for (const op of chunk) {
          op.delete ? batch.delete(op.ref) : batch.update(op.ref, op.data);
        }
        await batch.commit();
      }

      console.log(`[AutoAssign] Reset: ${ops.length} operaciones ejecutadas`);
    }

    // Fetch fresh state after reset
    const freshSnap = reset
      ? await db.collection(SHIPMENTS).get()
      : await db.collection(SHIPMENTS).where('scheduled_date', '==', null).get();

    const toAssign = freshSnap.docs.filter(d => assignableStatuses.includes(d.data().status));

    let assigned = 0;
    for (const doc of toAssign) {
      const { tracking_code, zone } = doc.data();
      const date = await autoAssignDate(tracking_code, zone);
      if (date) assigned++;
    }

    res.json({ ok: true, revisados: toAssign.length, asignados: assigned });
  } catch (err) {
    console.error('[AutoAssign] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Sync completo histórico (todos los pedidos de TN, omite ya importados)
router.post('/sync/full', async (req, res) => {
  try {
    const result = await syncAllOrders();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Crear envío manual (ventas en negro, canjes, locales, etc.)
router.post('/shipments', async (req, res) => {
  try {
    const { customer, address, zone, products = [], tipo = 'manual', initial_status = 'pending', notes = '' } = req.body;

    if (!customer?.name) return res.status(400).json({ error: 'El nombre del cliente es requerido' });
    if (!address?.street) return res.status(400).json({ error: 'La dirección es requerida' });
    if (!zone) return res.status(400).json({ error: 'La zona es requerida' });

    const trackingCode = generateTrackingCode();
    const trackingUrl = buildTrackingUrl(trackingCode);
    const now = new Date().toISOString();

    const shipment = {
      tracking_code: trackingCode,
      order_id: null,
      tn_order_number: null,
      source: 'manual',
      tipo,
      notes,
      customer: {
        name: customer.name || '',
        email: customer.email || '',
        phone: customer.phone || '',
      },
      address: {
        street: address.street || '',
        floor: address.floor || '',
        city: address.city || '',
        province: address.province || '',
        zipcode: address.zipcode || '',
        locality: address.locality || '',
        zone,
      },
      zone,
      shipping_option: null,
      status: initial_status,
      status_history: [{ status: initial_status, timestamp: now, note: `Carga manual — ${tipo}${notes ? ': ' + notes : ''}` }],
      route_id: null,
      truck_id: null,
      scheduled_date: null,
      estimated_date: null,
      reschedule_requests: [],
      fulfillment_id: null,
      products: products.map(p => ({ name: p.name || '', quantity: Number(p.qty) || 1, variant: '' })),
      created_at: now,
      updated_at: now,
    };

    await db.collection(SHIPMENTS).doc(trackingCode).set(shipment);
    console.log(`[Admin] Envío manual creado: ${trackingCode} | ${customer.name} | Zona: ${zone} | Tipo: ${tipo}`);

    // Auto-assign to best delivery date based on zone schedule
    autoAssignDate(trackingCode, zone).catch(e => console.warn(`[Admin] autoAssign error: ${e.message}`));

    res.json({ ok: true, tracking_code: trackingCode, tracking_url: trackingUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const snap = await db.collection(SHIPMENTS).get();
    const by_status = {};
    const by_zone = {};
    for (const doc of snap.docs) {
      const { status, zone } = doc.data();
      by_status[status] = (by_status[status] || 0) + 1;
      if (zone) by_zone[zone] = (by_zone[zone] || 0) + 1;
    }
    res.json({ by_status, by_zone, total: snap.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function defaultConfig() {
  return {
    depot: {
      name: 'Altorancho',
      address: '',
      locality: 'Buenos Aires',
      province: 'Buenos Aires',
    },
    trucks: [
      { id: 'camion-01', name: 'Camión 1', capacity_m3: 20, max_stops: 25, active: true, zones_preference: [], available_days: [] },
      { id: 'camion-02', name: 'Camión 2', capacity_m3: 15, max_stops: 20, active: true, zones_preference: [], available_days: [] },
    ],
    zones: [
      { id: 'CABA', name: 'CABA', keywords: ['capital federal', 'caba'] },
      { id: 'GBA_NORTE', name: 'GBA Norte', keywords: ['vicente lopez', 'san isidro', 'tigre', 'pilar', 'palermo'] },
      { id: 'GBA_SUR', name: 'GBA Sur', keywords: ['lomas de zamora', 'lanus', 'avellaneda', 'quilmes'] },
      { id: 'GBA_OESTE', name: 'GBA Oeste', keywords: ['moron', 'merlo', 'moreno', 'hurlingham'] },
      { id: 'LA_PLATA', name: 'La Plata', keywords: ['la plata'] },
    ],
    zone_schedules: {
      CABA:      ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      GBA_NORTE: ['tuesday', 'thursday'],
      GBA_SUR:   ['wednesday', 'friday'],
      GBA_OESTE: ['monday', 'thursday'],
      LA_PLATA:  ['wednesday'],
      OTRO:      ['tuesday', 'thursday'],
    },
    delivery_days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    sla_max_days: 4,
    reschedule_cutoff_hours: 24,
  };
}

export default router;
