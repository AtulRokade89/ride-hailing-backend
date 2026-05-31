const express = require("express");
const router = express.Router();
const pool = require("../db");

//const pool = global.pool; // ✅ THIS IS THE FIX

router.get("/driver-verifications", async (req, res) => {
  try {
    const status = req.query.status || "pending_verification";

    const result = await pool.query(
      `
      SELECT
        dv.id,
        dv.user_id,
        dv.pan_number,
        dv.pan_image_url,
        dv.aadhar_number,
        dv.aadhar_image_url,
        dv.vehicle_number,
        dv.vehicle_model,
        dv.vehicle_type,
        dv.vehicle_color,
        dv.vehicle_photo_url,
        dv.rc_number,
        dv.rc_image_url,
        dv.bank_account_number,
        dv.bank_name,
        dv.ifsc_code,
        dv.passbook_image_url,
        dv.driver_photo_url,
        dv.created_at,
        u.name,
        u.phone_number
      FROM driver_verifications dv
      JOIN users u ON u.id = dv.user_id
      WHERE dv.status = $1
      ORDER BY dv.created_at ASC
      `,
      [status]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Pending verification fetch error:", err);
    res.status(500).json({ error: "Failed to fetch driver verifications" });
  }
});

router.put("/driver-verifications/reject/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;

    if (!reason || reason.trim().length < 5) {
      return res.status(400).json({
        error: "Rejection reason is required (min 5 chars)",
      });
    }

    const result = await pool.query(
      `
      UPDATE driver_verifications
      SET 
        status = 'rejected',
        rejection_reason = $1,
        rejected_at = NOW(),
        updated_at = NOW()
      WHERE user_id = $2
        AND status = 'pending_verification'
      RETURNING *
      `,
      [reason.trim(), userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "No pending verification found for this driver",
      });
    }

    res.json({
      success: true,
      message: "Driver verification rejected successfully",
    });
  } catch (err) {
    console.error("Reject error:", err);
    res.status(500).json({ error: "Failed to reject verification" });
  }
});

module.exports = router;
