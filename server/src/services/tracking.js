import { customAlphabet } from 'nanoid';

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const nanoid = customAlphabet(alphabet, 6);

export function generateTrackingCode() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `ALT-${date}-${nanoid()}`;
}

export function buildTrackingUrl(trackingCode) {
  const base = process.env.CLIENT_URL || 'http://localhost:5173';
  return `${base}/#/seguimiento/${trackingCode}`;
}
