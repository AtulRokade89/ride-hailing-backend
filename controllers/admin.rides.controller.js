// controllers/admin.rides.controller.js

exports.getAdminRides = async (req, res) => {
  try {
    const { status, vehicle, search } = req.query;

    let conditions = [];
    let values = [];
    let i = 1;

    // 🔍 STATUS FILTER
    if (status && status !== 'ALL') {
      conditions.push(`r.status = $${i++}`);
      values.push(status.toUpperCase());
    }

    // 🚗 VEHICLE FILTER
    if (vehicle && vehicle !== 'ALL') {
      conditions.push(`r.vehicle_type = $${i++}`);
      values.push(vehicle);
    }

    // 🔎 SEARCH (ride id / driver / passenger)
    if (search) {
      conditions.push(`
        (
          r.external_id ILIKE $${i}
          OR d.name ILIKE $${i}
          OR CAST(r.passenger_id AS TEXT) ILIKE $${i}
        )
      `);
      values.push(`%${search}%`);
      i++;
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT
        r.external_id        AS id,
        r.passenger_id       AS "passengerId",
        d.name               AS driver,
        r.pickup_address     AS pickup,
        r.dropoff_address       AS drop,
        r.vehicle_type       AS vehicle,
        r.final_fare         AS fare,
        r.status             AS status,
        r.payment_mode       AS payment,
        r.completed_at       AS time
      FROM rides r
      LEFT JOIN users d ON d.id = r.driver_id
      ${whereClause}
      ORDER BY r.requested_at DESC
      LIMIT 500
    `;

    const { rows } = await global.pool.query(sql, values);

    // 🎯 MAP STATUS FOR UI (optional but clean)
    const mappedRows = rows.map((r) => ({
      ...r,
      status:
        r.status === 'COMPLETED'
          ? 'Completed'
          : r.status === 'CANCELLED'
          ? 'Cancelled'
          : 'Ongoing',
    }));

    res.json(mappedRows);
  } catch (err) {
    console.error('Admin rides error:', err);
    res.status(500).json({ message: 'Failed to load rides' });
  }
};