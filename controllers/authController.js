// ride-hailing-backend/controllers/authController.js

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const twilio = require('twilio');


// Initialize the database connection pool
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

const generateSafeCode = (name, phone, userId) => {
    // Name null na ho isliye safety check
    const safeName = name || 'USR';
    const prefix = safeName.substring(0, 3).toUpperCase().replace(/\s/g, 'X');
    const suffix = phone ? phone.substring(phone.length - 4) : '0000';
    // userId add karne se UNIQUE constraint kabhi fail nahi hoga
    return `${prefix}${suffix}${userId}`; 
};

// --- Configure Nodemailer for Sending Emails ---
// IMPORTANT: For production, use a real email service like SendGrid, Mailgun, or AWS SES.
// For testing, a Gmail account with an "App Password" is a great choice.
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'atulro@gmail.com',    // YOUR GMAIL ADDRESS
    pass: 'sfyz wynt iqjd gvai' // YOUR 16-DIGIT GMAIL APP PASSWORD
  }
});

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);



// --- User Registration (Upgraded for Verification) ---
const register = async (req, res) => {
     const { name, email, password, role, phone_number, referred_by_code, device_id } = req.body;

    if (!['passenger', 'driver'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role specified.' });
    }

    // --- Passenger Registration with Verification ---
    if (role === 'passenger') {
        const client = await pool.connect(); // Get a client from the pool for a transaction
        try {
            await client.query('BEGIN'); // Start the transaction

            // 1. Check if a VERIFIED user already exists
            const existingUserQuery = `
                SELECT u.id FROM users u
                JOIN passenger_verification pv ON u.id = pv.user_id
                WHERE u.email = $1 AND pv.is_verified = TRUE;
            `;
            const existingUser = await client.query(existingUserQuery, [email]);
            if (existingUser.rows.length > 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ message: "A verified account with this email already exists." });
            }

            // 2. Hash the password
            const hashedPassword = await bcrypt.hash(password, 10);

            // 3. Insert or Update the 'users' table (Upsert logic)
            const userQuery = `
                INSERT INTO users (name, email, password_hash, phone_number, role, device_id)
                VALUES ($1, $2, $3, $4, 'passenger', $5)
                ON CONFLICT (email) DO UPDATE
                SET name = $1, password_hash = $3, phone_number = $4
                RETURNING id;
            `;
            const newUser = await client.query(userQuery, [name, email, hashedPassword, phone_number, device_id || null]);
            const userId = newUser.rows[0].id;
        //referal logic
         const passengerRefCode = generateSafeCode(name, phone_number, userId);
            let referredByUserId = null;
            let referredByRole = 'self';

            // Ab 'referred_by_code' defined hai, toh error nahi aayega
            if (referred_by_code && referred_by_code.trim() !== '') {
                const refOwner = await client.query(
                    "SELECT user_id, user_role FROM referrals WHERE referral_code = $1 LIMIT 1",
                    [referred_by_code.trim()]
                );
                if (refOwner.rows.length > 0) {
                    referredByUserId = refOwner.rows[0].user_id;
                    referredByRole = refOwner.rows[0].user_role;
                }
            }

            const expiryDate = new Date();
            expiryDate.setDate(expiryDate.getDate() + 30);

            await client.query(
                `INSERT INTO referrals (
                    user_id, user_role, referral_code, 
                    referred_by_code, referred_by_user_id, referred_by_role,
                    first_ride_free_used, first_ride_free_expires_at
                ) VALUES ($1, 'passenger', $2, $3, $4, $5, FALSE, $6)
                ON CONFLICT (user_id) DO NOTHING`,
                [userId, passengerRefCode, referred_by_code || null, referredByUserId, referredByRole, expiryDate]
            );

            // 4. Generate token and create the verification entry
            const verificationToken = crypto.randomBytes(32).toString('hex');
            const tokenExpiry = new Date(Date.now() + 3600000); // Token is valid for 1 hour

            const verificationQuery = `
                INSERT INTO passenger_verification (user_id, is_verified, verification_token, token_expiry)
                VALUES ($1, FALSE, $2, $3)
                ON CONFLICT (user_id) DO UPDATE
                SET is_verified = FALSE, verification_token = $2, token_expiry = $3;
            `;
            await client.query(verificationQuery, [userId, verificationToken, tokenExpiry]);

            // 5. Send the glorious verification email
            const verificationLink = `${process.env.BASE_URL}/api/auth/verify/${verificationToken}`; // Use the public ngrok URL!
            await transporter.sendMail({
                from: '"LetsRide Support" <your.email@gmail.com>',
                to: email,
                subject: 'Verify Your LetsRide Account',
                html: `
                    <h1>Welcome, ${name}!</h1>
                    <p>Thank you for registering. Please click the link below to activate your account:</p>
                    <a href="${verificationLink}" style="background-color: #007bff; color: white; padding: 15px 25px; text-decoration: none; border-radius: 5px; display: inline-block;">Verify My Email</a>
                    <p>This link is only valid for 1 hour.</p>
                `
            });
			
			 if (phone_number && phone_number.length >= 10) {
                try {
                    // IMPORTANT: The phone number must be in E.164 format.
                    // We'll assume the number is from India (+91).
                    // ⭐️ CHANGE "+91" to your country's code if needed!
                    const formattedPhoneNumber = `+91${phone_number}`;

                    const message = await twilioClient.messages.create({
                        body: `Welcome to LetsRide! Your verification link is: ${verificationLink}`,
                        from: process.env.TWILIO_PHONE_NUMBER, // Your Twilio number from .env
                        to: formattedPhoneNumber                // The user's number
                    });

                    console.log(`✅ Verification SMS sent to ${formattedPhoneNumber}! SID: ${message.sid}`);

                } catch (smsError) {
                    // This is not a fatal error! The user still got the email.
                    // We log the error and continue, ensuring the app doesn't crash.
                    console.error(`❌ SMS sending to ${phone_number} failed. The user can still verify via email. Error: ${smsError.message}`);
                }
            }


            await client.query('COMMIT'); // Commit all changes!

            return res.status(201).json({ message: "Registration successful! Please check your email or sms to verify your account." });

        } catch (error) {
            await client.query('ROLLBACK'); // If any step fails, undo everything
            console.error('Passenger registration error:', error);
            return res.status(500).json({ error: "Server error during registration." });
        } finally {
            client.release(); // Return the client to the pool
        }
    }

    // --- Driver Registration with Referral Code Generation ---
    if (role === 'driver') {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // 1. Hash password
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(password, salt);

            // 2. Insert user (with device_id)
            const newUser = await client.query(
                `INSERT INTO users (name, email, password_hash, role, phone_number, device_id)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING id, role`,
                [name, email, hashedPassword, role, phone_number, device_id || null]
            );
            const userId   = newUser.rows[0].id;
            const userRole = newUser.rows[0].role;

            // 3. Generate driver referral code
            const driverReferralCode = phone_number
              ? generateReferralCode(name, phone_number)
              : null;

            // 4. Resolve referred_by_code (driver referred by another driver/passenger)
            let referredByUserId = null;
            let referredByRole   = 'self';

            if (referred_by_code && referred_by_code.trim() !== '') {
              const refRes = await client.query(
                `SELECT r.user_id, r.user_role
                 FROM referrals r
                 WHERE r.referral_code = $1
                 LIMIT 1`,
                [referred_by_code.trim()]
              );
              if (refRes.rows.length > 0) {
                referredByUserId = refRes.rows[0].user_id;
                referredByRole   = refRes.rows[0].user_role;

                // Self-referral fraud check (same device)
                const refDeviceRes = await client.query(
                  `SELECT device_id FROM users WHERE id = $1`,
                  [referredByUserId]
                );
                const refDevice = refDeviceRes.rows[0]?.device_id;
                if (refDevice && refDevice === device_id) {
                  console.warn(`🚨 Driver self-referral fraud: device ${device_id}`);
                  await client.query(
                    `UPDATE users SET is_suspicious = TRUE WHERE id = $1`,
                    [referredByUserId]
                  );
                  referredByUserId = null;
                  referredByRole   = 'self';
                }
              }
            }

            // 5. Insert referrals row for driver
            await client.query(
              `INSERT INTO referrals (
                user_id, user_role, referral_code,
                referred_by_code, referred_by_user_id, referred_by_role,
                first_ride_free_used, first_ride_free_expires_at,
                referrer_benefit_given, referrer_benefit_amount,
                device_id, ip_address
              ) VALUES ($1, 'driver', $2, $3, $4, $5, TRUE, NULL, FALSE, 50, $6, $7)
              ON CONFLICT (user_id) DO NOTHING`,
              [
                userId,
                driverReferralCode,
                referred_by_code?.trim() || null,
                referredByUserId,
                referredByRole,
                device_id || null,
                req.ip || null,
              ]
            );
            // Note: first_ride_free_used = TRUE for drivers (drivers don't get free rides)

            await client.query('COMMIT');

            const token = jwt.sign({ id: userId, role: userRole }, process.env.JWT_SECRET, { expiresIn: '7d' });
            return res.status(201).json({
              token,
              userId,
              role: userRole,
              referralCode: driverReferralCode, // ← Flutter mein dikhao
            });

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Driver registration error:', error);
            return res.status(500).json({ error: 'Server error during registration.' });
        }
    }
};

// --- User Login (Upgraded for Verification) ---
// In your NEW authController.js file
// 🎯🎯🎯 REPLACE your entire existing 'login' function with this one 🎯🎯🎯

const login = async (req, res) => {
    const { email, password } = req.body;

    try {
        // 1️⃣ Fetch user info + verification status + block status
        // This query is perfect and already fetches what we need.
        const userResult = await pool.query(`
         SELECT
    u.id,
    u.role,
    u.password_hash,
    dv.status AS driver_verification_status,
    dv.terms_accepted,
    pv.is_verified AS passenger_is_verified,
    d.is_blocked,
    d.vehicle_type
FROM users u
LEFT JOIN driver_verifications dv ON u.id = dv.user_id AND u.role = 'driver'
LEFT JOIN passenger_verification pv ON u.id = pv.user_id AND u.role = 'passenger'
LEFT JOIN drivers d ON u.id = d.user_id AND u.role = 'driver'
WHERE u.email = $1
        `, [email]);

        // 2️⃣ Validate user exists
        if (userResult.rows.length === 0) {
            return res.status(401).json({ message: 'Invalid credentials.' });
        }
        const user = userResult.rows[0];

        // 3️⃣ Validate password
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid credentials.' });
        }

        // 4️⃣ Handle different user roles
        if (user.role === 'passenger') {
            if (user.passenger_is_verified !== true) {
                return res.status(403).json({
                    errorType: 'verification',
                    message: 'Account not verified. Please check your email for the verification link.',
                });
            }
        }

        // ✅✅✅ GLORIOUS VICTORY! THE LOGIC IS RESTORED! ✅✅✅
       
if (user.role === 'driver') {
  // Your wallet_ledger amount_paise is currently being used as rupees.
  // If later you store real paise, change this to 120000.
  const CASH_DUE_BLOCK_LIMIT = 1200;

  // 1. Check dues whose due_date is already over
  const overdueQuery = await pool.query(
    `SELECT COALESCE(SUM(amount_paise), 0) AS overdue_due,
            MIN(due_date) AS first_overdue_due_date
     FROM wallet_ledger
     WHERE driver_id = $1
       AND type = 'CASH_RECEIVED'
       AND is_settled = FALSE
       AND due_date IS NOT NULL
       AND due_date <= NOW()`,
    [user.id]
  );

  // 2. Check total unsettled cash dues
  const allDuesQuery = await pool.query(
    `SELECT COALESCE(SUM(amount_paise), 0) AS total_unsettled,
            MIN(due_date) AS next_due_date,
            array_remove(array_agg(ride_external_id), NULL) AS ride_ids
     FROM wallet_ledger
     WHERE driver_id = $1
       AND type = 'CASH_RECEIVED'
       AND is_settled = FALSE`,
    [user.id]
  );

  const overdueDue =
    parseInt(overdueQuery.rows[0]?.overdue_due, 10) || 0;

  const totalUnsettled =
    parseInt(allDuesQuery.rows[0]?.total_unsettled, 10) || 0;

  const nextDueDate =
    allDuesQuery.rows[0]?.next_due_date || null;

  const firstOverdueDueDate =
    overdueQuery.rows[0]?.first_overdue_due_date || null;

  const dueRideIds =
    allDuesQuery.rows[0]?.ride_ids || [];

  const blockedByAmount = totalUnsettled > CASH_DUE_BLOCK_LIMIT;
  const blockedByDueDate = overdueDue > 0;

  // 3. Block if total dues > 1200 OR due date is over
  if (blockedByAmount || blockedByDueDate) {
    console.log(
      `[BLOCKED] Driver ${user.id} - Total: ${totalUnsettled}, Overdue: ${overdueDue}, AmountBlock: ${blockedByAmount}, DateBlock: ${blockedByDueDate}`
    );

    await pool.query(
      `UPDATE drivers SET is_blocked = TRUE WHERE user_id = $1`,
      [user.id]
    );

    return res.status(403).json({
      message: 'Account blocked due to unsettled cash dues.',
      verificationStatus: 'blocked_due_to_dues',
      userId: user.id,

      upcomingDuePaise: totalUnsettled,
      totalDuePaise: overdueDue,
      dueRideIds,

      blockedByAmount,
      blockedByDueDate,
      cashDueLimit: CASH_DUE_BLOCK_LIMIT,
      nextDueDate,
      firstOverdueDueDate,
    });
  }

  // 4. Not blocked, but send reminder amount in success response
  req.upcomingDuePaise = totalUnsettled;
  req.nextDueDate = nextDueDate;
}


    // 5️⃣ Generate token if passed all checks
    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
	
 const refRow = await pool.query(
      `SELECT referral_code FROM referrals WHERE user_id = $1 LIMIT 1`,
      [user.id]
    );
    let driverReferralCode = refRow.rows[0]?.referral_code || null;

    // Old drivers logic
    if (!driverReferralCode && user.role === 'driver') {
      const userData = await pool.query("SELECT name, phone_number FROM users WHERE id = $1", [user.id]);
      const { name, phone_number } = userData.rows[0];
      
      // Safety check for helper function
      driverReferralCode = generateSafeCode(name, phone_number, user.id);
      
      await pool.query(
        `INSERT INTO referrals (user_id, user_role, referral_code, first_ride_free_used) 
         VALUES ($1, 'driver', $2, TRUE) ON CONFLICT (user_id) DO NOTHING`,
        [user.id, driverReferralCode]
      );
    }


    // 6️⃣ Success response
const successPayload = {
  token,
  userId: user.id,
  role: user.role,
  referralCode: driverReferralCode, 
  verificationStatus:
    user.role === 'driver'
      ? user.verification_status || 'pending_verification'
      : 'n/a',
	  vehicleType: user.vehicle_type || null,
};
if (user.role === 'driver') {
  successPayload.termsAccepted = user.terms_accepted === true;
}
if (user.role === 'driver') {
  // If we set these above, attach them; otherwise default to 0/null
   successPayload.upcomingDuePaise = req.upcomingDuePaise ?? 0;
  successPayload.nextDueDate = req.nextDueDate ?? null;
}

//Passenger
// Login success payload mein — passenger ke liye add karo (line ~758 ke baad):
if (user.role === 'passenger') {
  const passRefRow = await pool.query(
    `SELECT first_ride_free_used, first_ride_free_expires_at, referred_by_user_id
     FROM referrals WHERE user_id = $1 LIMIT 1`,
    [user.id]
  );
  const passRef = passRefRow.rows[0];
  if (passRef && !passRef.first_ride_free_used && passRef.referred_by_user_id) {
    const expired = passRef.first_ride_free_expires_at 
      ? new Date() > new Date(passRef.first_ride_free_expires_at) 
      : false;
    successPayload.firstRideFree = !expired;
    successPayload.firstRideFreeExpiresAt = passRef.first_ride_free_expires_at;
  } else {
    successPayload.firstRideFree = false;
  }
}

res.status(200).json(successPayload);
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error during login.' });
  }
};


// --- NEW Verification Endpoint ---
const verifyEmail = async (req, res) => {
    try {
        const { token } = req.params;
        const updateQuery = `
            UPDATE passenger_verification
            SET is_verified = TRUE, verification_token = NULL, token_expiry = NULL
            WHERE verification_token = $1 AND token_expiry > NOW()
            RETURNING user_id;
        `;
        const result = await pool.query(updateQuery, [token]);

        if (result.rows.length === 0) {
            return res.status(400).send('<h1>Verification Failed</h1><p>This link is invalid or has expired.</p>');
        }
        res.send('<h1>Email Verified!</h1><p>Your account is now active. You can log in to the LetsRide app.</p>');
    } catch (error) {
        console.error('Email verification error:', error);
        res.status(500).send('<h1>Server Error</h1><p>An error occurred. Please try again later.</p>');
    }
};


// ── Lock free ride on request send (called from ride request API) ────────────
const lockFirstRideFree = async (req, res) => {
  const { passengerId, rideId } = req.body;
  if (!passengerId || !rideId) return res.status(400).json({ error: 'Missing fields' });

  try {
    // Already used?
    const check = await pool.query(
      `SELECT first_ride_free_used, first_ride_free_expires_at
       FROM referrals WHERE user_id = $1`,
      [passengerId]
    );
    const row = check.rows[0];
    if (!row) return res.json({ eligible: false, reason: 'no_referral' });
    if (row.first_ride_free_used) return res.json({ eligible: false, reason: 'already_used' });
    if (row.first_ride_free_expires_at && new Date() > new Date(row.first_ride_free_expires_at)) {
      return res.json({ eligible: false, reason: 'expired' });
    }

    // Lock it — set ride_id and locked_at
    await pool.query(
      `UPDATE referrals
       SET first_ride_free_locked_at = NOW(),
           first_ride_free_ride_id   = $1
       WHERE user_id = $2
         AND first_ride_free_used = FALSE`,
      [rideId, passengerId]
    );

    return res.json({ eligible: true });
  } catch (e) {
    console.error('lockFirstRideFree error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Called when passenger cancels — expire free ride offer ───────────────────
const cancelAbuseFreeRide = async (req, res) => {
  const { passengerId } = req.body;
  if (!passengerId) return res.status(400).json({ error: 'Missing passengerId' });

  try {
    const result = await pool.query(
      `UPDATE referrals
       SET first_ride_free_used = TRUE,
           first_ride_free_ride_id = COALESCE(first_ride_free_ride_id, 'cancelled')
       WHERE user_id = $1
         AND first_ride_free_used = FALSE
         AND first_ride_free_locked_at IS NOT NULL
       RETURNING id`,
      [passengerId]
    );

    if (result.rows.length > 0) {
      console.warn(`⚠️ Free ride offer expired for passenger ${passengerId} due to cancel after lock`);
      return res.json({ terminated: true, message: 'Free ride offer expired due to cancellation.' });
    }
    return res.json({ terminated: false });
  } catch (e) {
    console.error('cancelAbuseFreeRide error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Give referrer bonus after first ride completes ───────────────────────────
const giveReferrerBonus = async (pool, passengerId, rideId) => {
  try {
    // Get referral row
    const refRes = await pool.query(
      `SELECT referred_by_user_id, referred_by_role,
              referrer_benefit_given, referrer_benefit_amount
       FROM referrals
       WHERE user_id = $1 AND first_ride_free_ride_id = $2`,
      [passengerId, rideId]
    );
    const ref = refRes.rows[0];
    if (!ref || ref.referrer_benefit_given || !ref.referred_by_user_id) return;

    // Credit ₹50 to referrer's wallet
    await pool.query(
      `INSERT INTO wallet_ledger (
         driver_id, ride_external_id, type, direction, amount_paise, note
       ) VALUES ($1, $2, 'REFERRAL_BONUS', 'CR', $3, 'Referral bonus — new passenger joined')
       ON CONFLICT DO NOTHING`,
      [ref.referred_by_user_id, rideId, ref.referrer_benefit_amount]
    );

    // Mark bonus as given
    await pool.query(
      `UPDATE referrals SET referrer_benefit_given = TRUE WHERE user_id = $1`,
      [passengerId]
    );

    console.log(`✅ Referral bonus ₹${ref.referrer_benefit_amount} credited to user ${ref.referred_by_user_id}`);
  } catch (e) {
    console.error('giveReferrerBonus error:', e.message);
  }
};

// Final CommonJS Export
module.exports = {
    register,
    login,
    verifyEmail,
    lockFirstRideFree,
    cancelAbuseFreeRide,
    giveReferrerBonus,  // used in socket.js completeRide
};

