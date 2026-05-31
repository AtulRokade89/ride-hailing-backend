const pool = require('../db');
const { Parser } = require('json2csv');

/**
 * 🔹 BASE WHERE (shared by list + count + export)
 * NOTE:
 *  - Explicit ::date / ::text casting (fixes $3 datatype error)
 *  - NULL-safe filters
 */
const BASE_WHERE = `
  FROM rides a
  JOIN users u ON a.passenger_id = u.id
  WHERE 1=1
    AND ($1::date IS NULL OR a.completed_at >= $1::date)
    AND ($2::date IS NULL OR a.completed_at <= $2::date)
    AND ($3::text IS NULL OR a.status = $3::text)
    AND ($4::text IS NULL OR a.payment_status = $4::text)
`;

/**
 * 🔹 DATA QUERY (paginated)
 */
const LIST_QUERY = `
  SELECT
    a.external_id AS ride_id,
    u.name AS passenger_name,
    CASE
      WHEN a.payment_status = 'PAID_ONLINE' THEN 'Online'
      ELSE 'Cash'
    END AS mode,
    a.status,
    a.final_fare AS amount,
   COALESCE(a.completed_at, a.requested_at) AS date
  ${BASE_WHERE}
  ORDER BY
  CASE
    WHEN a.completed_at IS NOT NULL THEN a.completed_at
    ELSE a.requested_at
  END DESC
  LIMIT $5 OFFSET $6
`;

/**
 * 🔹 COUNT QUERY (for pagination)
 */
const COUNT_QUERY = `
  SELECT COUNT(*)::int AS total
  ${BASE_WHERE}
`;

/**
 * ✅ GET /api/admin/payments
 * Query params:
 *  - page (default 1)
 *  - fromDate (YYYY-MM-DD)
 *  - toDate (YYYY-MM-DD)
 *  - status
 *  - mode (Online | Cash)
 */
exports.getPayments = async (req, res) => {
  try {
    const {
      fromDate,
      toDate,
      status,
      mode,
      page = 1,
    } = req.query;

    const PAGE_SIZE = 10;
    const OFFSET = (Number(page) - 1) * PAGE_SIZE;

    // 🔁 Map UI mode → DB value
    let paymentStatus = null;
    if (mode === 'Online') paymentStatus = 'PAID_ONLINE';
    if (mode === 'Cash') paymentStatus = 'PAID_CASH';

    const baseParams = [
      fromDate || null,
      toDate || null,
      status || null,
      paymentStatus || null,
    ];

    // 1️⃣ Total count
    const countResult = await pool.query(COUNT_QUERY, baseParams);
    const total = countResult.rows[0].total;

    // 2️⃣ Paginated data
    const dataResult = await pool.query(
      LIST_QUERY,
      [...baseParams, PAGE_SIZE, OFFSET]
    );

    res.json({
      page: Number(page),
      pageSize: PAGE_SIZE,
      total,
      totalPages: Math.ceil(total / PAGE_SIZE),
      data: dataResult.rows,
    });
  } catch (err) {
    console.error('❌ getPayments error:', err);
    res.status(500).json({ message: 'Failed to fetch payments' });
  }
};

/**
 * ✅ GET /api/admin/payments/export
 * Same filters, but exports ALL matching rows
 */
exports.exportPaymentsCSV = async (req, res) => {
  try {
    const { fromDate, toDate, status, mode } = req.query;

    let paymentStatus = null;
    if (mode === 'Online') paymentStatus = 'PAID_ONLINE';
    if (mode === 'Cash') paymentStatus = 'PAID_CASH';

    const params = [
      fromDate || null,
      toDate || null,
      status || null,
      paymentStatus || null,
    ];

const exportQuery = `
  SELECT
    a.external_id AS ride_id,
    u.name AS passenger_name,
    CASE
      WHEN a.payment_status = 'PAID_ONLINE' THEN 'Online'
      ELSE 'Cash'
    END AS mode,
    a.status,
    a.final_fare AS amount,
    TO_CHAR(
      COALESCE(a.completed_at, a.requested_at),
      'DD/MM/YYYY HH24:MI:SS'
    ) AS date
  ${BASE_WHERE}
  ORDER BY COALESCE(a.completed_at, a.requested_at) DESC
`;

    const { rows } = await pool.query(exportQuery, params);

    const parser = new Parser({
      fields: [
        'ride_id',
        'passenger_name',
        'mode',
        'status',
        'amount',
        'date',
      ],
    });

    const csv = parser.parse(rows);

    res.header('Content-Type', 'text/csv');
    res.header(
      'Content-Disposition',
      'attachment; filename="payments.csv"'
    );
    res.send(csv);
  } catch (err) {
    console.error('❌ exportPaymentsCSV error:', err);
    res.status(500).json({ message: 'Failed to export CSV' });
  }
};