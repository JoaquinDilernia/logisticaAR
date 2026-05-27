import express from 'express';
import { db } from '../services/firebase.js';

const router = express.Router();
const SHIPMENTS = 'altorancho_shipments';

function calcEstimatedWindow(stopIndex) {
  const START_MINUTES = 9 * 60;
  const MINUTES_PER_STOP = 20;
  const mid = START_MINUTES + stopIndex * MINUTES_PER_STOP;
  const from = Math.max(START_MINUTES, mid - 45);
  const to = mid + 45;
  const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return { from: fmt(from), to: fmt(to) };
}

router.get('/:code', async (req, res) => {
  try {
    const doc = await db.collection(SHIPMENTS).doc(req.params.code.toUpperCase()).get();
    if (!doc.exists) return res.status(404).json({ error: 'Código no encontrado' });
    const data = doc.data();

    const isDone = ['delivered', 'delivery_failed'].includes(data.status);
    const isOutForDelivery = data.status === 'out_for_delivery';

    let estimated_window = null;
    let stops_before = null;
    let truck_location = null;

    // Single route lookup covers both estimated_window and stops_before
    if (data.scheduled_date && !isDone && data.route_id) {
      const routeDoc = await db.collection('altorancho_routes').doc(data.route_id).get();
      if (routeDoc.exists) {
        const order = routeDoc.data().order || routeDoc.data().shipments || [];
        const idx = order.indexOf(data.tracking_code);
        if (idx !== -1) {
          estimated_window = calcEstimatedWindow(idx);

          if (isOutForDelivery) {
            if (idx === 0) {
              stops_before = 0;
            } else {
              // Get status of all shipments for this day and count pending ones before this stop
              const daySnap = await db.collection(SHIPMENTS)
                .where('scheduled_date', '==', data.scheduled_date)
                .get();
              const statusMap = {};
              daySnap.docs.forEach(d => { statusMap[d.id] = d.data().status; });
              const prevCodes = order.slice(0, idx);
              stops_before = prevCodes.filter(
                c => !['delivered', 'delivery_failed'].includes(statusMap[c])
              ).length;
            }
          }
        }
      }
    } else if (data.scheduled_date && !isDone) {
      estimated_window = { from: '09:00', to: '18:00' };
    }

    // Live truck GPS — only expose when actively delivering
    if (isOutForDelivery && data.truck_id) {
      const truckDoc = await db.collection('altorancho_trucks').doc(data.truck_id).get();
      if (truckDoc.exists && truckDoc.data().last_lat != null) {
        truck_location = {
          lat: truckDoc.data().last_lat,
          lng: truckDoc.data().last_lng,
          last_seen: truckDoc.data().last_seen,
        };
      }
    }

    res.json({
      tracking_code: data.tracking_code,
      status: data.status,
      status_history: data.status_history,
      customer_name: data.customer?.name,
      zone: data.zone,
      shipping_option: data.shipping_option,
      scheduled_date: data.scheduled_date,
      estimated_date: data.estimated_date,
      estimated_window,
      stops_before,
      truck_location,
      address: {
        street: data.address?.street,
        floor: data.address?.floor,
        city: data.address?.city,
        province: data.address?.province,
        locality: data.address?.locality,
      },
      reschedule_requests: data.reschedule_requests || [],
      products: data.products || [],
      proof: isDone ? (data.proof || null) : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:code/reschedule', async (req, res) => {
  try {
    const { requested_date, reason } = req.body;
    if (!requested_date) return res.status(400).json({ error: 'Fecha requerida' });

    const ref = db.collection(SHIPMENTS).doc(req.params.code.toUpperCase());
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Código no encontrado' });

    const data = doc.data();

    if (data.status === 'delivered') return res.status(400).json({ error: 'El pedido ya fue entregado' });
    if (data.status === 'out_for_delivery') return res.status(400).json({ error: 'El pedido ya salió en reparto' });

    if (data.scheduled_date) {
      const deliveryDate = new Date(data.scheduled_date);
      const cutoff = new Date(deliveryDate.getTime() - 24 * 60 * 60 * 1000);
      if (new Date() > cutoff) {
        return res.status(400).json({ error: 'No se puede reprogramar con menos de 24 horas de anticipación' });
      }
    }

    const oldRouteId = data.route_id;

    await ref.update({
      status: 'rescheduled',
      scheduled_date: requested_date,
      route_id: null,
      truck_id: null,
      reschedule_requests: [...(data.reschedule_requests || []), {
        requested_date,
        reason: reason || '',
        created_at: new Date().toISOString(),
        status: 'pending',
      }],
      status_history: [...(data.status_history || []), {
        status: 'rescheduled',
        timestamp: new Date().toISOString(),
        note: `Cliente reprogramó para ${requested_date}${reason ? ': ' + reason : ''}`,
      }],
      updated_at: new Date().toISOString(),
    });

    if (oldRouteId) {
      const routeRef = db.collection('altorancho_routes').doc(oldRouteId);
      const routeDoc = await routeRef.get();
      if (routeDoc.exists) {
        const r = routeDoc.data();
        const code = req.params.code.toUpperCase();
        await routeRef.update({
          shipments: (r.shipments || []).filter(c => c !== code),
          order: (r.order || []).filter(c => c !== code),
          updated_at: new Date().toISOString(),
        });
      }
    }

    res.json({ ok: true, message: 'Reprogramación registrada' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
