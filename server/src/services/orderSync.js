import cron from 'node-cron';
import { db } from './firebase.js';
import { getOrders, isEnvioPropio, extractZone, extractZoneFromAddress, updateOrderTracking, sendOrderNotification } from './tiendaNube.js';
import { generateTrackingCode, buildTrackingUrl } from './tracking.js';
import { autoAssignDate } from './autoAssign.js';

const SHIPMENTS = 'altorancho_shipments';
const SYNC_STATE = 'altorancho_config';
const DRY_RUN = process.env.DRY_RUN === 'true';

async function getLastSyncTime() {
  const doc = await db.collection(SYNC_STATE).doc('sync_state').get();
  return doc.exists ? doc.data().last_order_sync : null;
}

async function setLastSyncTime(ts) {
  await db.collection(SYNC_STATE).doc('sync_state').set({ last_order_sync: ts }, { merge: true });
}

// Paginate through all TN orders for a given since filter (null = all historical)
async function fetchAllPages(since, status) {
  let page = 1;
  const all = [];
  while (true) {
    const batch = await getOrders({ page, perPage: 50, since, status });
    if (!batch.length) break;
    all.push(...batch);
    if (batch.length < 50) break;
    page++;
  }
  return all;
}

async function processOrder(order) {
  // Skip cancelled orders
  if (order.status === 'cancelled') return null;

  // Skip orders not yet paid or fully refunded
  const skipPayment = ['pending', 'abandoned', 'voided', 'refunded'];
  if (skipPayment.includes(order.payment_status)) return null;

  if (!isEnvioPropio(order)) return null;

  // Map TN shipping_status → our status
  // TN values: 'unpacked' (por empaquetar), 'unfulfilled' (empaquetado), 'fulfilled' (enviado)
  const tnShipping = order.shipping_status;
  const initialStatus = tnShipping === 'unfulfilled' ? 'packaged' : 'pending';

  const existing = await db.collection(SHIPMENTS).where('order_id', '==', String(order.id)).limit(1).get();

  if (!existing.empty) {
    // Correct orders that were wrongly imported as 'packaged' but TN says they're still unpacked
    const doc = existing.docs[0];
    if (doc.data().status === 'packaged' && initialStatus === 'pending') {
      await doc.ref.update({ status: 'pending', updated_at: new Date().toISOString() });
      console.log(`[OrderSync] Corregido: ${doc.data().tracking_code} packaged → pending (TN dice: ${tnShipping})`);
    }
    return null;
  }

  const trackingCode = generateTrackingCode();
  const trackingUrl = buildTrackingUrl(trackingCode);
  const zoneFromOption = extractZone(order.shipping_option);
  const zone = zoneFromOption !== 'OTRO'
    ? zoneFromOption
    : extractZoneFromAddress({
        zipcode: order.shipping_address?.zipcode,
        locality: order.shipping_address?.locality,
        city: order.shipping_address?.city,
      });
  const fulfillment = order.fulfillments?.[0];

  const shipment = {
    tracking_code: trackingCode,
    order_id: String(order.id),
    tn_order_number: String(order.number || order.id),
    customer: {
      name: order.shipping_address?.name || '',
      email: order.contact_email || '',
      phone: order.shipping_address?.phone || '',
    },
    address: {
      street: `${order.shipping_address?.address || ''} ${order.shipping_address?.number || ''}`.trim(),
      floor: order.shipping_address?.floor || '',
      city: order.shipping_address?.city || '',
      province: order.shipping_address?.province || '',
      zipcode: order.shipping_address?.zipcode || '',
      locality: order.shipping_address?.locality || '',
      zone,
    },
    zone,
    shipping_option: order.shipping_option,
    status: initialStatus,
    status_history: [{ status: initialStatus, timestamp: new Date().toISOString(), note: 'Detectado desde Tienda Nube' }],
    route_id: null,
    truck_id: null,
    scheduled_date: null,
    estimated_date: null,
    reschedule_requests: [],
    fulfillment_id: fulfillment?.id || null,
    products: (order.products || []).map(p => ({
      id: p.product_id,
      name: p.name,
      quantity: p.quantity,
      variant: p.variant?.name || '',
      weight_kg: Number(p.weight) || 0,
      width_cm: Number(p.width) || 0,
      height_cm: Number(p.height) || 0,
      depth_cm: Number(p.depth) || 0,
      volume_cm3: (Number(p.width) || 0) * (Number(p.height) || 0) * (Number(p.depth) || 0),
    })),
    total_volume_cm3: (order.products || []).reduce((sum, p) => {
      return sum + (Number(p.width) || 0) * (Number(p.height) || 0) * (Number(p.depth) || 0) * (Number(p.quantity) || 1);
    }, 0),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await db.collection(SHIPMENTS).doc(trackingCode).set(shipment);

  autoAssignDate(trackingCode, zone).catch(e =>
    console.warn(`[OrderSync] autoAssign error para ${trackingCode}: ${e.message}`)
  );

  if (DRY_RUN) {
    console.log(`[OrderSync] [DRY_RUN] Se omitiría updateOrderTracking para orden ${order.id} (code: ${trackingCode}, url: ${trackingUrl})`);
    console.log(`[OrderSync] [DRY_RUN] Se omitiría sendOrderNotification para orden ${order.id}`);
  } else {
    if (fulfillment?.id) {
      await updateOrderTracking(order.id, fulfillment.id, trackingCode, trackingUrl).catch(e =>
        console.warn(`No se pudo actualizar tracking en TN para orden ${order.id}:`, e.message)
      );
    }
    await sendOrderNotification(order.id,
      `¡Hola ${shipment.customer.name}! Tu pedido ya está empaquetado y listo para salir. Seguí el estado de tu envío en tiempo real: ${trackingUrl} — Código de seguimiento: ${trackingCode}`
    ).catch(e => console.warn(`No se pudo enviar notificación TN para orden ${order.id}:`, e.message));
  }

  console.log(`[OrderSync] Nuevo envío propio: ${trackingCode} | Orden #${order.number || order.id} | Zona: ${zone}${DRY_RUN ? ' [DRY_RUN]' : ''}`);
  return trackingCode;
}

// Incremental sync — only orders since last sync
async function syncOrders() {
  console.log('[OrderSync] Iniciando sincronización incremental...');
  try {
    const lastSync = await getLastSyncTime();
    const orders = await fetchAllPages(lastSync);

    let newCount = 0;
    for (const order of orders) {
      const result = await processOrder(order);
      if (result) newCount++;
    }

    await setLastSyncTime(new Date().toISOString());
    console.log(`[OrderSync] Sync incremental finalizado. Pedidos revisados: ${orders.length}. Nuevos envíos propios: ${newCount}.`);
    return newCount;
  } catch (err) {
    console.error('[OrderSync] Error:', err.message);
    throw err;
  }
}

// Full historical sync — only OPEN orders, paginated, skips already-imported
// Correct any shipments stored as 'packaged' that TN says are still unpacked
async function correctPackagedStatuses() {
  const snap = await db.collection(SHIPMENTS).where('status', '==', 'packaged').get();
  if (snap.empty) return;
  console.log(`[OrderSync] Verificando ${snap.docs.length} envíos marcados como empaquetados...`);
  let corrected = 0;
  for (const doc of snap.docs) {
    const { order_id, tracking_code } = doc.data();
    try {
      const tnOrder = await getOrder(order_id);
      if (!tnOrder) continue;
      const isActuallyPacked = tnOrder.shipping_status === 'unfulfilled';
      if (!isActuallyPacked) {
        await doc.ref.update({ status: 'pending', updated_at: new Date().toISOString() });
        console.log(`[OrderSync] Corregido: ${tracking_code} packaged → pending (TN: ${tnOrder.shipping_status})`);
        corrected++;
      }
    } catch {
      // ignore per-order errors, continue with others
    }
  }
  if (corrected > 0) console.log(`[OrderSync] ${corrected} estados corregidos.`);
}

export async function syncAllOrders() {
  console.log('[OrderSync] Iniciando sync completo (solo pedidos abiertos)...');
  try {
    const orders = await fetchAllPages(null, 'open');
    console.log(`[OrderSync] TN devolvió ${orders.length} pedidos abiertos.`);

    let newCount = 0;
    let envioCount = 0;
    for (const order of orders) {
      if (isEnvioPropio(order)) envioCount++;
      const result = await processOrder(order);
      if (result) newCount++;
    }

    await setLastSyncTime(new Date().toISOString());
    console.log(`[OrderSync] Sync completo finalizado. Total: ${orders.length} pedidos | Envíos propios detectados: ${envioCount} | Nuevos importados: ${newCount}.`);
    return { total: orders.length, envios_propios: envioCount, nuevos: newCount };
  } catch (err) {
    console.error('[OrderSync] Error en sync completo:', err.message);
    throw err;
  }
}

export function startOrderSync() {
  // On startup: full sync of open orders + correct any wrong statuses
  syncAllOrders().then(() => correctPackagedStatuses());
  cron.schedule('*/15 * * * *', syncOrders);
  console.log(`[OrderSync] Scheduler iniciado — cada 15 minutos${DRY_RUN ? ' [DRY_RUN activo — no se escribirá en TN]' : ''}`);
}

export { syncOrders, processOrder };
