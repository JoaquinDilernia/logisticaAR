import express from 'express';
import { db } from '../services/firebase.js';
import { syncOrders } from '../services/orderSync.js';

const router = express.Router();
const SHIPMENTS = 'altorancho_shipments';

router.get('/', async (req, res) => {
  try {
    const { zone, status, page = 1, limit = 20 } = req.query;
    let query = db.collection(SHIPMENTS).orderBy('created_at', 'desc');
    if (zone) query = query.where('zone', '==', zone);
    if (status) query = query.where('status', '==', status);
    const snap = await query.limit(Number(limit)).get();
    const shipments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ shipments, total: shipments.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sync', async (req, res) => {
  try {
    await syncOrders();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
