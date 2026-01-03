// // ride-hailing-backend/controllers/authController.js

// // 1. CommonJS Imports
// const bcrypt = require('bcryptjs');
// const jwt = require('jsonwebtoken');
// const { Pool } = require('pg');

// // 2. Initialize the database connection pool (from server.js context)
// const pool = new Pool({
    // user: process.env.DB_USER,
    // host: process.env.DB_HOST,
    // database: process.env.DB_NAME,
    // password: process.env.DB_PASSWORD,
    // port: process.env.DB_PORT,
// });

// // --- User Registration ---
// const register = async (req, res) => {
    // const { name, email, password, role, phone_number } = req.body;

    // if (!['passenger', 'driver'].includes(role)) {
        // return res.status(400).json({ error: 'Invalid role specified.' });
    // }

    // try {
        // // 1. Check if user already exists
        // const existingUser = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        // if (existingUser.rows.length > 0) {
            // return res.status(400).json({ error: 'User with this email already exists.' });
        // }

        // // 2. Hash the password
        // // Note: bcryptjs v3.0.2 requires slightly older syntax but this should work:
        // const salt = await bcrypt.genSalt(10);
        // const hashedPassword = await bcrypt.hash(password, salt);

        // // 3. Insert the new user into the database
        // const newUser = await pool.query(
            // 'INSERT INTO users (name, email, password_hash, role, phone_number) VALUES ($1, $2, $3, $4, $5) RETURNING id, role',
            // [name, email, hashedPassword, role, phone_number]
        // );

        // const userId = newUser.rows[0].id;
        // const userRole = newUser.rows[0].role;

        // // 4. Create and sign JWT Token
        // const token = jwt.sign({ id: userId, role: userRole }, process.env.JWT_SECRET, {
            // expiresIn: '7d', // Token expires in 7 days
        // });

        // // 5. Respond with the token and user details
        // res.status(201).json({ token, userId, role: userRole });

    // } catch (error) {
        // console.error('Registration error:', error);
        // res.status(500).json({ error: 'Server error during registration.' });
    // }
// };

// const login = async (req, res) => {
  // const { email, password } = req.body;

  // try {
    // // 1️⃣ Fetch user info + password + driver details
    // const userResult = await pool.query(`
      // SELECT
        // u.id,
        // u.role,
        // u.password_hash,
        // dv.status AS verification_status,
        // d.is_blocked
      // FROM users u
      // LEFT JOIN driver_verifications dv ON u.id = dv.user_id
      // LEFT JOIN drivers d ON u.id = d.user_id
      // WHERE u.email = $1
    // `, [email]);

    // // 2️⃣ Validate user
    // if (userResult.rows.length === 0) {
      // return res.status(400).json({
        // errorType: 'email',
        // error: 'Wrong username. Please enter the correct email address.',
      // });
    // }

    // const user = userResult.rows[0];

    // // 3️⃣ Validate password
    // const isMatch = await bcrypt.compare(password, user.password_hash);
    // if (!isMatch) {
      // return res.status(400).json({
        // errorType: 'password',
        // error: 'Wrong password. Please try again.',
      // });
    // }

    
	
	// // if (user.role === 'driver') {
  // // const duesQuery = `
    // // SELECT
      // // SUM(amount_paise) AS total_due,
      // // min(created_at) AS last_due_date
    // // FROM wallet_ledger
    // // WHERE driver_id = $1
      // // AND is_settled = FALSE
      // // AND type = 'CASH_RECEIVED';
  // // `;
  // // const duesResult = await pool.query(duesQuery, [user.id]);
  // // const totalDuePaise = parseInt(duesResult.rows[0].total_due || '0', 10);
  // // const lastDueDate = duesResult.rows[0].last_due_date
    // // ? new Date(duesResult.rows[0].last_due_date)
    // // : null;

  // // // 🧮 If unpaid dues exist and oldest due is more than 7 days ago → block
  // // const today = new Date();
  // // const daysDiff = lastDueDate
    // // ? Math.floor((today - lastDueDate) / (1000 * 60 * 60 * 24))
    // // : 0;

  // // if (totalDuePaise > 0 && daysDiff > 7) {
    // // console.log(
      // // `[BLOCKED] Driver ${user.id} - dues ₹${(totalDuePaise / 100).toFixed(2)}, last due ${lastDueDate.toISOString()}`
    // // );

    // // // 🔹 Optionally update DB to mark as blocked
    // // await pool.query(`UPDATE drivers SET is_blocked = TRUE WHERE user_id = $1`, [user.id]);

    // // return res.status(403).json({
      // // error: 'Account blocked due to overdue payments.',
      // // verificationStatus: 'blocked_due_to_dues',
      // // totalDuePaise: totalDuePaise,
      // // userId: user.id,
    // // });
  // // }
// // }
// // Inside the login function...

// // ✅ PASTE THIS ENTIRE BLOCK TO REPLACE YOUR CURRENT `if (user.role === 'driver')` BLOCK

// if (user.role === 'driver') {
  // // --- 1. CALCULATE BOTH DUE AMOUNTS FIRST ---

  // // --- Calculate ONLY Overdue Dues (for deciding if we should block) ---
  // const overdueQuery = await pool.query(
    // `SELECT COALESCE(SUM(amount_paise), 0) AS total_due_paise,
            // array_agg(ride_external_id) AS ride_ids
     // FROM wallet_ledger
     // WHERE driver_id = $1
       // AND type = 'CASH_RECEIVED'
       // AND is_settled = FALSE
       // AND due_date IS NOT NULL
       // AND due_date <= NOW()`,
    // [user.id]
  // );
  // const totalDuePaise = parseInt(overdueQuery.rows[0]?.total_due_paise, 10) || 0;
  // const dueRideIds = overdueQuery.rows[0]?.ride_ids || [];

  // // --- Calculate the GRAND TOTAL of All Unsettled Dues (for displaying in popups) ---
  // const allDuesQuery = await pool.query(
    // `SELECT COALESCE(SUM(amount_paise), 0) AS total_unsettled_paise,
            // MIN(due_date) AS next_due_date
     // FROM wallet_ledger
     // WHERE driver_id = $1
       // AND type = 'CASH_RECEIVED'
       // AND is_settled = FALSE`,
    // [user.id]
  // );
  // const totalUnsettledPaise = parseInt(allDuesQuery.rows[0]?.total_unsettled_paise, 10) || 0;
  // const nextDueDate = allDuesQuery.rows[0]?.next_due_date || null;


  // // --- 2. NOW, MAKE THE DECISION TO BLOCK ---
  // // This 'if' block now runs *after* all variables have been created.
  // if (totalDuePaise > 0) {
    // // If there is any overdue amount, block the account.
    // console.log(`[BLOCKED] Driver ${user.id} - Overdue: ${totalDuePaise}, Total Unsettled: ${totalUnsettledPaise}`);

    // // Set the is_blocked flag in the database
    // await pool.query(`UPDATE drivers SET is_blocked = TRUE WHERE user_id = $1`, [user.id]);

    // // Return the 403 error. Both variables now exist and can be used safely.
    // return res.status(403).json({
      // message: 'Account blocked due to unsettled cash dues.',
      // verificationStatus: 'blocked_due_to_dues',
      // totalDuePaise: totalDuePaise,          // The overdue amount (for records)
      // upcomingDuePaise: totalUnsettledPaise, // ✅ The GRAND TOTAL amount (for the popup)
      // dueRideIds: dueRideIds,
      // userId: user.id,
    // });
  // }

  // // --- 3. IF NOT BLOCKED ---
  // // Attach the grand total to the successful response for the reminder popup.
  // req.upcomingDuePaise = totalUnsettledPaise;
  // req.nextDueDate = nextDueDate;
// }


    // // 5️⃣ Generate token if passed all checks
    // const token = jwt.sign(
      // { id: user.id, role: user.role },
      // process.env.JWT_SECRET,
      // { expiresIn: '7d' }
    // );

    // // 6️⃣ Success response
// const successPayload = {
  // token,
  // userId: user.id,
  // role: user.role,
  // verificationStatus:
    // user.role === 'driver'
      // ? user.verification_status || 'pending_verification'
      // : 'n/a',
// };
// if (user.role === 'driver') {
  // // If we set these above, attach them; otherwise default to 0/null
   // successPayload.upcomingDuePaise = req.upcomingDuePaise ?? 0;
  // successPayload.nextDueDate = req.nextDueDate ?? null;
// }

// res.status(200).json(successPayload);
  // } catch (error) {
    // console.error('Login error:', error);
    // res.status(500).json({ error: 'Server error during login.' });
  // }
// };



// // 3. Final CommonJS Export
// module.exports = {
    // register,
    // login,
// };




// ride-hailing-backend/controllers/authController.js

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
//const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const twilio = require('twilio');
const pool = global.pool;

// Initialize the database connection pool
// const pool = new Pool({
    // user: process.env.DB_USER,
    // host: process.env.DB_HOST,
    // database: process.env.DB_NAME,
    // password: process.env.DB_PASSWORD,
    // port: process.env.DB_PORT,
// });

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
    const { name, email, password, role, phone_number } = req.body;

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
                INSERT INTO users (name, email, password_hash, phone_number, role)
                VALUES ($1, $2, $3, $4, 'passenger')
                ON CONFLICT (email) DO UPDATE
                SET name = $1, password_hash = $3, phone_number = $4
                RETURNING id;
            `;
            const newUser = await client.query(userQuery, [name, email, hashedPassword, phone_number]);
            const userId = newUser.rows[0].id;

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

    // --- Existing Driver Registration Logic (can be upgraded similarly later) ---
    if (role === 'driver') {
        // Your existing driver registration code can go here.
        // For now, it will proceed without email verification for drivers.
        try {
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(password, salt);
            const newUser = await pool.query(
                'INSERT INTO users (name, email, password_hash, role, phone_number) VALUES ($1, $2, $3, $4, $5) RETURNING id, role',
                [name, email, hashedPassword, role, phone_number]
            );
            const userId = newUser.rows[0].id;
            const userRole = newUser.rows[0].role;
            const token = jwt.sign({ id: userId, role: userRole }, process.env.JWT_SECRET, { expiresIn: '7d' });
            return res.status(201).json({ token, userId, role: userRole });
        } catch (error) {
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
                pv.is_verified AS passenger_is_verified,
                d.is_blocked
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
  // --- 1. CALCULATE BOTH DUE AMOUNTS FIRST ---

  // --- Calculate ONLY Overdue Dues (for deciding if we should block) ---
  const overdueQuery = await pool.query(
    `SELECT COALESCE(SUM(amount_paise), 0) AS total_due_paise,
            array_agg(ride_external_id) AS ride_ids
     FROM wallet_ledger
     WHERE driver_id = $1
       AND type = 'CASH_RECEIVED'
       AND is_settled = FALSE
       AND due_date IS NOT NULL
       AND due_date <= NOW()`,
    [user.id]
  );
  const totalDuePaise = parseInt(overdueQuery.rows[0]?.total_due_paise, 10) || 0;
  const dueRideIds = overdueQuery.rows[0]?.ride_ids || [];

  // --- Calculate the GRAND TOTAL of All Unsettled Dues (for displaying in popups) ---
  const allDuesQuery = await pool.query(
    `SELECT COALESCE(SUM(amount_paise), 0) AS total_unsettled_paise,
            MIN(due_date) AS next_due_date
     FROM wallet_ledger
     WHERE driver_id = $1
       AND type = 'CASH_RECEIVED'
       AND is_settled = FALSE`,
    [user.id]
  );
  const totalUnsettledPaise = parseInt(allDuesQuery.rows[0]?.total_unsettled_paise, 10) || 0;
  const nextDueDate = allDuesQuery.rows[0]?.next_due_date || null;


  // --- 2. NOW, MAKE THE DECISION TO BLOCK ---
  // This 'if' block now runs *after* all variables have been created.
  if (totalDuePaise > 0) {
    // If there is any overdue amount, block the account.
    console.log(`[BLOCKED] Driver ${user.id} - Overdue: ${totalDuePaise}, Total Unsettled: ${totalUnsettledPaise}`);

    // Set the is_blocked flag in the database
    await pool.query(`UPDATE drivers SET is_blocked = TRUE WHERE user_id = $1`, [user.id]);

    // Return the 403 error. Both variables now exist and can be used safely.
    return res.status(403).json({
      message: 'Account blocked due to unsettled cash dues.',
      verificationStatus: 'blocked_due_to_dues',
      totalDuePaise: totalDuePaise,          // The overdue amount (for records)
      upcomingDuePaise: totalUnsettledPaise, // ✅ The GRAND TOTAL amount (for the popup)
      dueRideIds: dueRideIds,
      userId: user.id,
    });
  }

  // --- 3. IF NOT BLOCKED ---
  // Attach the grand total to the successful response for the reminder popup.
  req.upcomingDuePaise = totalUnsettledPaise;
  req.nextDueDate = nextDueDate;
}


    // 5️⃣ Generate token if passed all checks
    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // 6️⃣ Success response
const successPayload = {
  token,
  userId: user.id,
  role: user.role,
  verificationStatus:
    user.role === 'driver'
      ? user.verification_status || 'pending_verification'
      : 'n/a',
};
if (user.role === 'driver') {
  // If we set these above, attach them; otherwise default to 0/null
   successPayload.upcomingDuePaise = req.upcomingDuePaise ?? 0;
  successPayload.nextDueDate = req.nextDueDate ?? null;
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


// Final CommonJS Export
module.exports = {
    register,
    login,
    verifyEmail, // Export the new verification handler
};

