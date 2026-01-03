// controllers/driverVerificationController.js
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
require('dotenv').config(); 

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
});

// ===== Multer setup for image uploads =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../uploads/driver_docs'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});

const upload = multer({ storage });

// ===== Controller: submit driver verification =====
const submitVerification = async (req, res) => {
  try {
	      console.log('FILES RECEIVED:', Object.keys(req.files || {}));
    const {
      user_id,
      pan_number,
      aadhar_number,
      vehicle_number,
      vehicle_type,
	  vehicle_model,
	  vehicle_color,
      rc_number,
      bank_account_number,
      bank_name,
      ifsc_code,
    } = req.body;
	
	
	  const normalizedData = {
    userId: user_id,
    panNumber: pan_number?.trim().toUpperCase(),
    aadharNumber: aadhar_number?.trim(), // Numeric, no case change
    vehicleNumber: vehicle_number?.trim().toUpperCase().replace(/\s/g, ''), // Uppercase & remove spaces
	vehicleModel: vehicle_model?.trim(),
    vehicleType: vehicle_type,
	vehicleColor: vehicle_color?.trim(),
    rcNumber: rc_number?.trim(),
    bankAccountNumber: bank_account_number?.trim(),
    bankName: bank_name?.trim(),
    ifscCode: ifsc_code?.trim().toUpperCase(),
  };

    // Simple validation
    if (!user_id || !pan_number || !aadhar_number || !vehicle_number || !vehicle_color) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Uploaded file URLs
  normalizedData.panImageUrl = req.files?.pan_image?.[0]?.path || null;
  normalizedData.aadharImageUrl = req.files?.aadhar_image?.[0]?.path || null;
  normalizedData.rcImageUrl = req.files?.rc_image?.[0]?.path || null;
  normalizedData.passbookImageUrl = req.files?.passbook_image?.[0]?.path || null;
  normalizedData.driverPhotoUrl = req.files?.driver_photo?.[0]?.path || null;
  normalizedData.vehiclePhotoUrl = req.files?.vehicle_photo?.[0]?.path || null;
  
  // Basic validation on normalized data
  if (!normalizedData.userId || !normalizedData.panNumber || !normalizedData.aadharNumber || !normalizedData.vehicleNumber) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // --- 2. 3RD PARTY API VERIFICATION (Placeholder) ---
  // When you get your Surepass API key, you will add the logic here.
  // Example:
  // const panResult = await verifyWithSurepass(normalizedData.panNumber);
  // if (!panResult.isValid) {
  //   return res.status(400).json({ error: 'PAN verification failed: ' + panResult.message });
  // }
  //
  // const bankResult = await verifyBankWithSurepass(normalizedData.bankAccountNumber, normalizedData.ifscCode);
  // if (!bankResult.isValid) {
  //   return res.status(400).json({ error: 'Bank verification failed: ' + bankResult.message });
  // }
  // If all checks pass, you continue to the database insertion.
  

    const query = `
      INSERT INTO driver_verifications (
  user_id,
  pan_number,
  pan_image_url,
  aadhar_number,
  aadhar_image_url,
  vehicle_number,
  vehicle_model,
  vehicle_type,
  vehicle_color,
  driver_photo_url,
  vehicle_photo_url,
  rc_number,
  rc_image_url,
  bank_account_number,
  bank_name,
  ifsc_code,
  passbook_image_url,
  status
)
VALUES (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'pending_verification'
)
ON CONFLICT (user_id)
DO UPDATE SET
  pan_number = EXCLUDED.pan_number,
  pan_image_url = EXCLUDED.pan_image_url,
  aadhar_number = EXCLUDED.aadhar_number,
  aadhar_image_url = EXCLUDED.aadhar_image_url,
  vehicle_number = EXCLUDED.vehicle_number,
  vehicle_model = EXCLUDED.vehicle_model,
  vehicle_type = EXCLUDED.vehicle_type,
  vehicle_color = EXCLUDED.vehicle_color,
  driver_photo_url = EXCLUDED.driver_photo_url,
  vehicle_photo_url = EXCLUDED.vehicle_photo_url,
  rc_number = EXCLUDED.rc_number,
  rc_image_url = EXCLUDED.rc_image_url,
  bank_account_number = EXCLUDED.bank_account_number,
  bank_name = EXCLUDED.bank_name,
  ifsc_code = EXCLUDED.ifsc_code,
  passbook_image_url = EXCLUDED.passbook_image_url,
  status = 'pending_verification',
  updated_at = NOW();
    `;

    const values = [
  normalizedData.userId,
  normalizedData.panNumber,
  normalizedData.panImageUrl,
  normalizedData.aadharNumber,
  normalizedData.aadharImageUrl,
  normalizedData.vehicleNumber,
  normalizedData.vehicleModel,
  normalizedData.vehicleType,
  normalizedData.vehicleColor,
  normalizedData.driverPhotoUrl,
  normalizedData.vehiclePhotoUrl,
  normalizedData.rcNumber,
  normalizedData.rcImageUrl,
  normalizedData.bankAccountNumber,
  normalizedData.bankName,
  normalizedData.ifscCode,
  normalizedData.passbookImageUrl,
];
	const result = await pool.query(query, values);

    return res.status(200).json({
      success: true,
      message: 'Verification submitted successfully',
      data: result.rows[0],
    });
  } catch (err) {
    console.error('Verification Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ===== Controller: check status =====
const getStatus = async (req, res) => {
  try {
    const { userId } = req.params;
    const query = `SELECT status FROM driver_verifications WHERE user_id = $1`;
    const result = await pool.query(query, [userId]);

    if (result.rowCount === 0) {
      // ✅ THE FIX: Always return 200 OK. 
      // The 'status' field tells the app what state the user is in.
      return res.status(200).json({ status: 'none' }); 
    }

    res.json({ status: result.rows[0].status });
  } catch (err) {
    console.error('Status Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

const activateDriver = async (req, res) => {
  const { userId } = req.params; // Get the user_id from the URL (e.g., /api/driver/activate/123)
  const client = await pool.connect(); // Use a transaction to ensure both updates succeed or fail together

  try {
    await client.query('BEGIN');

    // --- Step 1: Fetch the verified data from the driver_verifications table ---
	//instead pan card number adding rc_number
    const verificationQuery = `
      SELECT rc_number, vehicle_number,vehicle_model, vehicle_type 
      FROM driver_verifications 
      WHERE user_id = $1 AND status = 'pending_verification'
    `;
    const verificationResult = await client.query(verificationQuery, [userId]);

    if (verificationResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No driver found with pending verification for this ID.' });
    }

    const verifiedData = verificationResult.rows[0];
    
    // You can use PAN as license number, or add a separate license field later
	// instead pancard number adding rc_number
    const licenseNumber = verifiedData.rc_number; 
    const vehicleModel = verifiedData.vehicle_model;// You can add this field to your form later
    const vehicleNumber = verifiedData.vehicle_number;
    const vehicleType = verifiedData.vehicle_type;


    // --- Step 2: Insert or Update the main 'drivers' table ---
    // This query tries to insert. If a driver with that user_id already exists,
    // it updates their details instead. This is robust.
    const driverTableQuery = `
      INSERT INTO drivers (user_id, license_number, vehicle_model, vehicle_type, vehicle_number, is_online)
      VALUES ($1, $2, $3, $4, $5, FALSE)
      ON CONFLICT (user_id) 
      DO UPDATE SET 
        license_number = EXCLUDED.license_number,
        vehicle_model = EXCLUDED.vehicle_model,
        vehicle_type = EXCLUDED.vehicle_type,
        vehicle_number = EXCLUDED.vehicle_number;
    `;
    await client.query(driverTableQuery, [userId, licenseNumber, vehicleModel, vehicleType, vehicleNumber]);


    // --- Step 3: Update the status in the 'driver_verifications' table ---
    const updateStatusQuery = `
      UPDATE driver_verifications SET status = 'active' WHERE user_id = $1
    `;
    await client.query(updateStatusQuery, [userId]);


    // --- Step 4: Commit the transaction ---
    await client.query('COMMIT');
    res.status(200).json({ success: true, message: `Driver ${userId} has been activated successfully.` });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Activation Error:', err);
    res.status(500).json({ error: 'Internal server error during activation.' });
  } finally {
    client.release();
  }
};



module.exports = {
  upload,
  submitVerification,
  getStatus,
  activateDriver,
};

