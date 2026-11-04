const trackingStore = new Map();

export async function recordTracking(order, fulfiller, tracking) {
  trackingStore.set(order.id, { ...tracking, fulfiller, at: new Date().toISOString() });
  console.log('Tracking recorded for', order.id, tracking);
  return trackingStore.get(order.id);
}

export function getTracking(orderId) {
  return trackingStore.get(orderId);
}
