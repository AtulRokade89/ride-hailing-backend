async function logRide(pool, data) {
  try {
    let distanceKm = data.distance_km;

    if (!distanceKm && data.rideId) {
      const { rows } = await pool.query(
        `SELECT distance_km FROM rides WHERE external_id = $1`,
        [data.rideId]
      );
      distanceKm = rows[0]?.distance_km || null;
    }

    await pool.query(
      `INSERT INTO ride_logs
       (ride_id, driver_id, passenger_id, status, payment_status, fare, distance_km, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        data.rideId,
        data.driverId,
        data.passengerId,
        data.status,
        data.paymentStatus,
        data.fare,
        distanceKm, // ✅ auto handled
        data.meta ? JSON.stringify(data.meta) : null
      ]
    );
  } catch (e) {
    console.error('❌ logRide error:', e.message);
  }
}

async function logPayment(pool, data) {
  try {
    await pool.query(
      `INSERT INTO payment_logs
       (ride_id, driver_id, passenger_id, amount, payment_mode, status, razorpay_order_id, razorpay_payment_id, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (ride_id,payment_mode) DO NOTHING`,
      [
        data.rideId,
        data.driverId,
        data.passengerId,
        data.amount,
        data.paymentMode,
        data.status,
        data.orderId,
        data.paymentId,
       data.meta ? JSON.stringify(data.meta) : null
      ]
    );
  } catch (e) {
    console.error('❌ logPayment error:', e.message);
  }
}

module.exports = { logRide, logPayment };