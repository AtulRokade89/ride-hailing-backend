
// routes/invoices.js
const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');

const pool = global.pool;

// const roundHalfUpToInt = n => Math.floor(Number(n) + 0.5);
// const baseR  = roundHalfUpToInt(baseExact);
// const cgstR  = roundHalfUpToInt(baseR * 0.025);
// const sgstR  = roundHalfUpToInt(baseR * 0.025);
// const totalR = baseR + cgstR + sgstR;

/* ---------------- helpers ---------------- */

function roundHalfUpToInt(value) {
  const num = Number(value) || 0;
  const floor = Math.floor(num);
  return (num - floor) >= 0.5 ? floor + 1 : floor;
}

const safeParseFloat = (v) => {
  if (v === null || v === undefined) return 0;
  return typeof v === 'number' ? v : parseFloat(v) || 0;
};

// same fare rules your app uses
function computeBaseFareINR(vehicleType, distanceKm) {
  const vt = String(vehicleType || '').toUpperCase();
  const base =
    vt === 'BIKE'  ? 20 :
    vt === 'MINI'  ? 40 :
    vt === 'SEDAN' ? 70 :
    vt === 'SUV'   ? 100 : 40;

  const perKm =
    vt === 'BIKE'  ? 6  :
    vt === 'MINI'  ? 10 :
    vt === 'SEDAN' ? 15 :
    vt === 'SUV'   ? 20 : 10;

  const km = Math.max(0, Number(distanceKm) || 0);
  return Math.round((base + perKm * km) * 100) / 100; // 2 decimals INR
}

function computeSplitsR(baseR) {
  const driver = Math.round(baseR * 0.65);
  return { driver_base_rupees: driver, platform_base_rupees: baseR - driver };
}
const safeParseInt = (v) => (typeof v === 'number' ? v : (parseInt(v) || 0));

// function calculateGSTTotals(baseInr) {
// const shownFinalFare = Number(rideRow.final_fare || rideRow.estimated_fare || 0);
// const totalR = Math.round(shownFinalFare); // This must ALWAYS be the invoice/receipt total

// // Calculate base/cgst/sgst only for breakdown (reporting) purposes:
// const baseExact = Number((totalR / 1.05).toFixed(2));
// const cgstExact = Number((baseExact * 0.025).toFixed(2));
// const sgstExact = Number((baseExact * 0.025).toFixed(2));
// const baseR = Math.round(baseExact);
// const cgstR = Math.round(cgstExact);
// const sgstR = totalR - baseR - cgstR;
// }

/* -------- shared PDF generator (expects whole-rupee fields) -------- */
function generatePdfStream(inv, res) {
  const finalR = safeParseInt(inv.rounded_rupees || inv.total_paise);

  // DECIMAL values (display purpose)
  const baseR  = safeParseFloat(inv.base_amount_paise);
  const surgeR = safeParseFloat(inv.surge_amount_paise);
  const cgstR  = safeParseFloat(inv.cgst_paise);
  const sgstR  = safeParseFloat(inv.sgst_paise);

  const subtotal = baseR + surgeR + cgstR + sgstR;
  const roundingAdj = Number((finalR - subtotal).toFixed(2));

  const doc = new PDFDocument({ margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="Lets_Ride_receipt_${inv.invoice_number}.pdf"`
  );
  doc.pipe(res);

  // Header
  doc.fontSize(20).text('LetsRide Official Invoice', { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).text(`Invoice No: ${inv.invoice_number}`);
  doc.text(`Ride ID: ${inv.ride_external_id}`);
  doc.text(`Date: ${new Date(inv.ride_completed_at).toLocaleString()}`);
  doc.moveDown();

  // Ride info
  doc.fontSize(12).text('--- Ride Details ---');
  doc.text(`Passenger: ${inv.passenger_name || '-'}`);
  doc.text(`Driver: ${inv.driver_name || '-'}`);
  doc.text(`Vehicle: ${inv.vehicle_type || '-'}`);
  doc.text(`From: ${inv.pickup_address || '-'}`);
  doc.text(`To: ${inv.dropoff_address || '-'}`);
  doc.moveDown();

  // Helper
  const row = (label, value, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica')
       .text(label, 50, doc.y, { continued: true });
    doc.text(value, { align: 'right' });
  };

  // Breakdown
  row('Base Fare:', `Rs.${baseR.toFixed(2)}`);
  if (surgeR > 0) row('Surge Charge:', `Rs.${surgeR.toFixed(2)}`);
  row('CGST (2.5%):', `Rs.${cgstR.toFixed(2)}`);
  row('SGST (2.5%):', `Rs.${sgstR.toFixed(2)}`);

  // doc.moveDown(0.3);
  // row('Subtotal:', `Rs.${subtotal.toFixed(2)}`, true);

  // row(
    // 'Rounding Adjustment:',
    // `${roundingAdj >= 0 ? '+' : '-'}Rs.${Math.abs(roundingAdj).toFixed(2)}`
  // );

  doc.moveDown(0.4);
  row('FINAL AMOUNT PAYABLE:', `Rs.${finalR}`, true);

  doc.moveDown();
  doc.fontSize(10).font('Helvetica-Oblique')
     .text('Note: Final amount is rounded as per GST rules.');
	 
	 doc.moveDown(15);
  doc.fontSize(12).font('Helvetica-Oblique')
     .text('This is computer generated invoice no signature required');

  doc.end();
}


/* ---------------- HISTORY (summarised list) ---------------- */

router.get('/history', async (req, res) => {
  try {
    const passengerId = Number(req.query.passengerId);
    if (!passengerId) return res.status(400).json({ error: 'passengerId_required' });

    const q = await pool.query(
      `SELECT r.external_id,
              r.pickup_address, r.dropoff_address,
              r.requested_at, r.completed_at,
              r.vehicle_type,
              u.name AS driver_name,
              i.invoice_number,
              COALESCE(i.rounded_rupees,
                       NULLIF(i.total_paise, 0),
                       NULLIF(i.base_amount_paise + i.cgst_paise + i.sgst_paise, 0),
                       0) AS rounded_rupees
         FROM rides r
    LEFT JOIN users u ON u.id = r.driver_id
    LEFT JOIN ride_invoices i ON i.ride_external_id = r.external_id
        WHERE r.passenger_id = $1
          AND r.status = 'COMPLETED'
        ORDER BY r.completed_at DESC NULLS LAST`,
      [passengerId]
    );

    res.json({ history: q.rows });
  } catch (e) {
    console.error('history route error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

/* ---------------- GENERATE (idempotent) ---------------- */
// router.post('/generate', async (req, res) => {
  // const { rideId } = req.body || {};
  // if (!rideId) return res.status(400).json({ error: 'rideId_required' });

  // const client = await pool.connect();
  // try {
    // await client.query('BEGIN');

    // // if exists, return number
    // const ex = await client.query(
      // `SELECT invoice_number FROM ride_invoices WHERE ride_external_id = $1`,
      // [rideId]
    // );
    // if (ex.rowCount > 0) {
      // await client.query('COMMIT');
      // return res.json({ ok: true, created: false, invoice_number: ex.rows[0].invoice_number });
    // }

    // // load ride
    // const r = await client.query(
      // `SELECT external_id, passenger_id, driver_id, vehicle_type,
              // pickup_address, dropoff_address,
              // requested_at, completed_at,
              // distance_km, final_fare, estimated_fare
         // FROM rides WHERE external_id = $1`,
      // [rideId]
    // );
    // if (!r.rowCount) {
      // await client.query('ROLLBACK');
      // return res.status(404).json({ error: 'ride_not_found' });
    // }
    // const ride = r.rows[0];

// const shownFinalFare = Number(ride.final_fare ?? ride.estimated_fare ?? 0);
// const totalR = Math.round(shownFinalFare);

// // invert GST for breakdown
// const baseExact  = Number((totalR / 1.05).toFixed(2));
// const cgstExact  = Number((baseExact * 0.025).toFixed(2));
// const sgstExact  = Number((baseExact * 0.025).toFixed(2));

// // round pieces and use remainder to ensure sum == totalR
// const baseR  = Math.round(baseExact);
// const cgstR  = Math.round(cgstExact);
// const sgstR  = totalR - baseR - cgstR;

    // const ins = await client.query(
      // `INSERT INTO ride_invoices (
          // ride_external_id, invoice_number, passenger_id, driver_id,
          // vehicle_type, pickup_address, dropoff_address,
          // ride_started_at, ride_completed_at,
          // base_amount_paise, cgst_paise, sgst_paise, total_paise, rounded_rupees, created_at
        // ) VALUES (
          // $1, NULL, $2, $3,
          // $4, $5, $6,
          // $7, $8,
          // $9, $10, $11, $12, $13, NOW()
        // )
        // ON CONFLICT (ride_external_id) DO UPDATE SET
          // passenger_id = EXCLUDED.passenger_id,
          // driver_id = EXCLUDED.driver_id,
          // vehicle_type = EXCLUDED.vehicle_type,
          // pickup_address = EXCLUDED.pickup_address,
          // dropoff_address = EXCLUDED.dropoff_address,
          // ride_started_at = EXCLUDED.ride_started_at,
          // ride_completed_at = EXCLUDED.ride_completed_at,
          // base_amount_paise = EXCLUDED.base_amount_paise,
          // cgst_paise = EXCLUDED.cgst_paise,
          // sgst_paise = EXCLUDED.sgst_paise,
          // total_paise = EXCLUDED.total_paise,
          // rounded_rupees = EXCLUDED.rounded_rupees,
          // created_at = NOW()
        // RETURNING id`,
      // [
        // ride.external_id,
        // ride.passenger_id,
        // ride.driver_id,
        // ride.vehicle_type,
        // ride.pickup_address,
        // ride.dropoff_address,
        // ride.requested_at,
        // ride.completed_at,
        // baseR, cgstR, sgstR, totalR, totalR
      // ]
    // );

    // const invoiceId = ins.rows[0].id;

    // // ensure invoice_number
    // const ymd = new Date().toISOString().slice(0,10).replace(/-/g,'');
    // await client.query(
      // `UPDATE ride_invoices
          // SET invoice_number = 'LR' || $1::text || LPAD(id::text, 6, '0')
        // WHERE id = $2
          // AND (invoice_number IS NULL OR invoice_number = '')`,
      // [ymd, invoiceId]
    // );

    // await client.query('COMMIT');

    // return res.json({
      // ok: true,
      // created: true,
      // invoice_number: `LR${ymd}${String(invoiceId).padStart(6,'0')}`,
      // rupees: { base_rupees: baseR, cgst_rupees: cgstR, sgst_rupees: sgstR, total_rupees: totalR },
      // splits_rupees: computeSplitsR(baseR),
    // });
  // } catch (e) {
    // await client.query('ROLLBACK');
    // console.error('generate invoice error:', e);
    // res.status(500).json({ error: 'server_error' });
  // } finally {
    // client.release();
  // }
// });

// In your routes/invoices.js file...
// ❌ DELETE your old router.post('/generate', ...) handler.
// ✅ PASTE this new, complete version in its place.

/* ---------------- GENERATE (idempotent) ---------------- */
// In your routes/invoices.js file...
// ❌ DELETE your old router.post('/generate', ...) handler.
// ✅ PASTE this new, complete version in its place.

/* ---------------- GENERATE (idempotent) ---------------- */
router.post('/generate', async (req, res) => {
  const { rideId } = req.body || {};
  if (!rideId) return res.status(400).json({ error: 'rideId_required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check if invoice already exists
    const ex = await client.query(
      `SELECT invoice_number FROM ride_invoices WHERE ride_external_id = $1`,
      [rideId]
    );
    if (ex.rowCount > 0) {
      await client.query('COMMIT');
      return res.json({ ok: true, created: false, invoice_number: ex.rows[0].invoice_number });
    }

    // Load ride data, including the surge multiplier
    const r = await client.query(
      `SELECT external_id, passenger_id, driver_id, vehicle_type,
              pickup_address, dropoff_address,
              requested_at, completed_at,
              distance_km, final_fare, estimated_fare,
              surge_multiplier
         FROM rides WHERE external_id = $1`,
      [rideId]
    );
    if (!r.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'ride_not_found' });
    }
    const ride = r.rows[0];

    // --- ✅ START: NEW, CORRECT FINANCIAL CALCULATION TO STORE RUPEES ---

    const finalAmountRupees = Number(ride.final_fare ?? ride.estimated_fare ?? 0);
    const surgeMultiplier = Number(ride.surge_multiplier) || 1.0;
    const finalTotalR = Math.round(finalAmountRupees); // The final, rounded total is the source of truth.

    // Calculate all components in precise paise first.
    const surgedBaseExact = finalTotalR / 1.05;
    const originalBaseExact = surgeMultiplier > 1.0 ? (surgedBaseExact / surgeMultiplier) : surgedBaseExact;
    const surgeAmountExact = surgedBaseExact - originalBaseExact;
    const cgstExact = surgedBaseExact * 0.025;
    const sgstExact = surgedBaseExact * 0.025;

    // NOW, CONVERT EVERYTHING TO ROUNDED, WHOLE RUPEES for storage, as you requested.
    const baseR = Math.round(originalBaseExact);
    const surgeR = Math.round(surgeAmountExact);
    const cgstR = Math.round(cgstExact);
    // Use the remainder trick to ensure the sum equals the final total perfectly.
    const sgstR = finalTotalR - baseR - surgeR - cgstR;

    const totalR = baseR + surgeR + cgstR + sgstR; // This will equal finalTotalR.

    // --- ✅ INSERT CORRECT WHOLE RUPEE VALUES INTO "..._paise" COLUMNS ---
    const ins = await client.query(
      `INSERT INTO ride_invoices (
          ride_external_id, passenger_id, driver_id, vehicle_type, pickup_address, dropoff_address,
          ride_started_at, ride_completed_at,
          base_amount_paise, surge_amount_paise, cgst_paise, sgst_paise, total_paise, rounded_rupees, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
        ON CONFLICT (ride_external_id) DO NOTHING RETURNING id`,
      [
       ride.external_id, ride.passenger_id, ride.driver_id, ride.vehicle_type,
        ride.pickup_address, ride.dropoff_address, ride.requested_at, ride.completed_at,
        baseR, surgeR, cgstR, sgstR, totalR, finalTotalR // Use the calculated rounded values.
      ]
    );

    const invoiceId = ins.rows[0].id;

    // Update invoice number (your logic is good)
    const ymd = new Date().toISOString().slice(0,10).replace(/-/g,'');
    await client.query(
      `UPDATE ride_invoices
          SET invoice_number = 'LR' || $1::text || LPAD(id::text, 6, '0')
        WHERE id = $2 AND (invoice_number IS NULL OR invoice_number = '')`,
      [ymd, invoiceId]
    );

    await client.query('COMMIT');

    return res.json({ ok: true, created: true, invoice_number: `LR${ymd}${String(invoiceId).padStart(6,'0')}` });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('generate invoice error:', e);
    res.status(500).json({ error: 'server_error' });
  } finally {
    client.release();
  }
});




/* ---------- PDF helpers: extend timeout for PDF endpoints ---------- */
const setPdfTimeout = (req, res, next) => { res.setTimeout(30000); next(); };

/* ---------- PDF by invoice number ---------- */
router.get('/:invoiceNumber/pdf', setPdfTimeout, async (req, res) => {
  try {
    const invoiceNumber = req.params.invoiceNumber;
    if (!invoiceNumber) return res.status(400).json({ error: 'invoiceNumber_required' });

    const q = await pool.query(
      `SELECT i.*,
              p.name AS passenger_name,
              d.name AS driver_name,
              r.vehicle_type, r.pickup_address, r.dropoff_address,
              r.completed_at AS ride_completed_at
         FROM ride_invoices i
    LEFT JOIN rides r ON r.external_id = i.ride_external_id
    LEFT JOIN users p ON p.id = r.passenger_id
    LEFT JOIN users d ON d.id = r.driver_id
        WHERE i.invoice_number = $1`,
      [invoiceNumber]
    );
    if (!q.rowCount) return res.status(404).json({ error: 'invoice_not_found' });

    generatePdfStream(q.rows[0], res);
  } catch (e) {
    console.error('invoice pdf by number error:', e);
    res.status(500).json({ error: 'server_error', details: e.message });
  }
});

/* ---------- GET by rideId (JSON or PDF) ---------- */

router.get('/:rideId/pdf', setPdfTimeout, async (req, res) => {
  req.query.format = undefined;
  await handleInvoiceGet(req, res);
});

router.get('/:rideId', async (req, res) => {
  if (req.query.format !== 'json') {
    setPdfTimeout(req, res, () => handleInvoiceGet(req, res));
  } else {
    await handleInvoiceGet(req, res);
  }
});

async function handleInvoiceGet(req, res) {
  try {
    const rideId = req.params.rideId;
    if (!rideId) return res.status(400).json({ error: 'rideId_required' });

    const q = await pool.query(
      `SELECT i.id, i.ride_external_id, i.invoice_number,
              i.base_amount_paise,
              i.surge_amount_paise, -- <-- ADD THIS LINE TO THE QUERY
              i.cgst_paise, i.sgst_paise, i.total_paise, i.rounded_rupees,
              p.name AS passenger_name,
              d.name AS driver_name,
              r.vehicle_type, r.pickup_address, r.dropoff_address,
              r.completed_at AS ride_completed_at
         FROM ride_invoices i
    LEFT JOIN rides r ON r.external_id = i.ride_external_id
    LEFT JOIN users p ON p.id = r.passenger_id
    LEFT JOIN users d ON d.id = r.driver_id
        WHERE i.ride_external_id = $1`,
      [rideId]
    );
    if (!q.rowCount) return res.status(404).json({ error: 'invoice_not_found' });

    const inv = q.rows[0];

    if (!inv.invoice_number) {
      const ymd = new Date().toISOString().slice(0,10).replace(/-/g,'');
      const fix = await pool.query(
        `UPDATE ride_invoices
             SET invoice_number = 'LR' || $1::text || LPAD(id::text, 6, '0')
          WHERE id = $2
          RETURNING invoice_number`,
        [ymd, inv.id]
      );
      inv.invoice_number = fix.rows[0].invoice_number;
    }

const baseR  = safeParseFloat(inv.base_amount_paise);
const surgeR = safeParseFloat(inv.surge_amount_paise);
const cgstR  = safeParseFloat(inv.cgst_paise);
const sgstR  = safeParseFloat(inv.sgst_paise);
    const totalR = safeParseInt(inv.total_paise);
    const finalR = safeParseInt(inv.rounded_rupees || totalR);

    if (req.query.format === 'json') {
      return res.json({
        invoice: {
          invoice_number:   inv.invoice_number,
          ride_external_id: inv.ride_external_id,
          passenger_name:   inv.passenger_name,
          driver_name:      inv.driver_name,
          vehicle_type:     inv.vehicle_type,
          pickup_address:   inv.pickup_address,
          dropoff_address:  inv.dropoff_address,
          ride_completed_at: inv.ride_completed_at,

          // legacy paise ints
         base_amount_paise:  baseR,
      surge_amount_paise: surgeR, // The missing piece is now here!
      cgst_paise:         cgstR,
      sgst_paise:         sgstR,
      total_paise:        totalR,
      final_rupees:       finalR,
      rounded_rupees:     finalR,

          splits_rupees: computeSplitsR(baseR),
          download_url: `/api/invoices/${inv.invoice_number}/pdf`,
        }
      });
    }

    // PDF (by ride id)
    generatePdfStream(inv, res);
  } catch (e) {
    console.error('invoice GET error:', e);
    res.status(500).json({ error: 'server_error', details: e.message });
  }
}

module.exports = router;

