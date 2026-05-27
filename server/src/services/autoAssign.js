import { db } from './firebase.js';

const SHIPMENTS = 'altorancho_shipments';
const CONFIG_DOC = 'altorancho_config';
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const DEFAULT_ZONE_SCHEDULES = {
  CABA:      ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  GBA_NORTE: ['tuesday', 'thursday'],
  GBA_SUR:   ['wednesday', 'friday'],
  GBA_OESTE: ['monday', 'thursday'],
  LA_PLATA:  ['wednesday'],
  OTRO:      ['tuesday', 'thursday'],
};

const DEFAULT_DELIVERY_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

function toYMD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getDeliveryDaysForZone(zone, config) {
  const globalDays = new Set(config.delivery_days?.length ? config.delivery_days : DEFAULT_DELIVERY_DAYS);
  const zoneDays = config.zone_schedules?.[zone] ?? DEFAULT_ZONE_SCHEDULES[zone];
  if (Array.isArray(zoneDays) && zoneDays.length) {
    // Zone schedule filtered by the global master switch (delivery_days)
    return zoneDays.filter(d => globalDays.has(d));
  }
  return [...globalDays];
}

export async function autoAssignDate(trackingCode, zone) {
  try {
    const configDoc = await db.collection(CONFIG_DOC).doc('logistics_config').get();
    const config = configDoc.exists ? configDoc.data() : {};

    const deliveryDays = getDeliveryDaysForZone(zone, config);
    const activeTrucks = (config.trucks ?? []).filter(t => t.active);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 1; i <= 21; i++) {
      const candidate = new Date(today);
      candidate.setDate(today.getDate() + i);
      const dayName = DAY_NAMES[candidate.getDay()];
      if (!deliveryDays.includes(dayName)) continue;

      // Only count trucks available on this specific day
      const trucksForDay = activeTrucks.filter(t =>
        !t.available_days?.length || t.available_days.includes(dayName)
      );
      const capacityForDay = trucksForDay.reduce((s, t) => s + (Number(t.max_stops) || 25), 0);
      if (capacityForDay === 0) continue;

      const dateStr = toYMD(candidate);
      const snap = await db.collection(SHIPMENTS).where('scheduled_date', '==', dateStr).get();

      if (snap.size < capacityForDay) {
        await db.collection(SHIPMENTS).doc(trackingCode).update({
          scheduled_date: dateStr,
          updated_at: new Date().toISOString(),
        });
        console.log(`[AutoAssign] ${trackingCode} → ${dateStr} (${zone})`);
        return dateStr;
      }
    }

    console.warn(`[AutoAssign] Sin slot disponible para ${trackingCode} (${zone})`);
    return null;
  } catch (err) {
    console.error(`[AutoAssign] Error para ${trackingCode}: ${err.message}`);
    return null;
  }
}
