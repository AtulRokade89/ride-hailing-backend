const express = require('express');
const router = express.Router();
// NO MORE 'require' FOR THE DATABASE HERE

// This is the new endpoint to receive pings from the app
// router.post('/demand-ping', async (req, res) => {
  // const { userId, lat, lng } = req.body;

  // if (!userId || lat == null || lng == null) {
    // return res.status(400).json({ error: 'userId, lat, and lng are required.' });
  // }

  // // ✅ THE FIX: Access the database pool from the global scope, just like in settlement.js
  // const pool = global.pool;

  // try {
    // await pool.query(
      // `INSERT INTO rider_demand_pings (user_id, location)
       // VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326))`,
      // [userId, lng, lat]
    // );
    
    // res.status(200).json({ success: true, message: 'Ping recorded.' });

  // } catch (e) {
    // console.error('Error recording demand ping:', e);
    // res.status(500).json({ success: false, error: 'server_error' });
  // }
// });

// demand.js (replace the existing /demand-ping handler)
router.post('/demand-ping', async (req, res) => {
  const { userId, lat, lng, event } = req.body;

  // Accept only meaningful events (prevent login / background noise)
  // client should send event='search' or event='request' when actively searching/creating a ride
  const allowedEvents = new Set(['search', 'request', 'open_booking_screen']);
  if (!userId || lat == null || lng == null) {
    return res.status(400).json({ error: 'userId, lat, and lng are required.' });
  }
  if (!allowedEvents.has(String(event || '').toLowerCase())) {
    // ignore noisy events like 'login' -- return 200 so clients don't retry wildly
    console.log(`Ignoring demand-ping from user ${userId} with event='${event}'.`);
    return res.status(200).json({ success: true, ignored: true });
  }

  const pool = global.pool;
  try {
    // Upsert so one row per user_id persists and repeated pings do not multiply counts:
    await pool.query(
      `INSERT INTO rider_demand_pings (user_id, location, ping_time)
         VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326), NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET location = EXCLUDED.location, ping_time = NOW()`,
      [userId, lng, lat]
    );

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('Error recording demand ping:', e);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});


// router.get('/hotspots', async (req, res) => {
  // try {
    // // This query does the magic:
    // // 1. It only looks at pings from the last 15 minutes.
    // // 2. It groups pings into a grid of ~500 meters (0.005 degrees).
    // // 3. It counts the number of pings in each grid cell.
    // // 4. It only returns cells with more than 1 ping to reduce noise.
    // const { rows } = await pool.query(
      // `SELECT
         // -- Calculate the center of the grid cell for the hotspot location
         // TRUNC(ST_Y(location)::numeric, 3) + 0.0025 as lat,
         // TRUNC(ST_X(location)::numeric, 3) + 0.0025 as lng,
         // -- Count the number of pings in that cell to determine its "weight"
         // COUNT(*)::int as weight
       // FROM rider_demand_pings
       // WHERE
         // -- Only consider recent pings from the last 15 minutes
         // ping_time > NOW() - INTERVAL '15 minutes'
       // GROUP BY
         // -- Group pings into a grid (approx. 500m x 500m)
         // TRUNC(ST_Y(location)::numeric, 3),
         // TRUNC(ST_X(location)::numeric, 3)
       // HAVING
         // -- Only return hotspots with at least 2 pings to avoid noise
         // COUNT(*) > 1
       // ORDER BY
         // weight DESC;`
    // );

    // res.json(rows);

  // } catch (e) {
    // console.error('Error fetching demand hotspots:', e);
    // res.status(500).json({ error: 'server_error' });
  // }
// });

router.get('/hotspots', async (req, res) => {
  console.log('API HIT: GET /hotspots'); // Add a log to see when it's called

  // This powerful PostGIS query finds clusters and assigns a surge multiplier.
  const hotspotQuery = `
    WITH recent_pings AS (
  SELECT
    location,
    -- Use ST_X and ST_Y to extract coordinates from the 'location' geometry column
    ST_SetSRID(ST_MakePoint(ST_X(location), ST_Y(location)), 4326)::geometry AS geog
  FROM rider_demand_pings
  WHERE ping_time > NOW() - INTERVAL '15 minutes'
),
    clustered_pings AS (
      SELECT
        location,
        -- This function groups pings into clusters.
        -- eps := 500 means points within 500 meters can be part of the same cluster.
        -- minpoints := 4 means a cluster must have at least 4 pings to be considered valid.
        ST_ClusterDBSCAN(geog, eps := 500, minpoints := 4) OVER() AS cluster_id
      FROM recent_pings
    ),
    cluster_centers AS (
      SELECT
        cluster_id,
        COUNT(*) AS ping_count,
        -- Find the geometric center point of all pings in a cluster.
        ST_AsGeoJSON(ST_Centroid(ST_Collect(location)))::json AS center_point
      FROM clustered_pings
      WHERE cluster_id IS NOT NULL -- Ignore pings that aren't part of a valid cluster.
      GROUP BY cluster_id
    )
    SELECT
      center_point,
      ping_count,
      -- This is the new Surge Pricing logic!
      -- We assign a multiplier based on the number of pings in the cluster.
      CASE
        WHEN ping_count >= 20 THEN 2.0 -- 2.0x surge for 20+ pings
        WHEN ping_count >= 15 THEN 1.8 -- 1.8x surge for 15-19 pings
        WHEN ping_count >= 10 THEN 1.5 -- 1.5x surge for 10-14 pings
        WHEN ping_count >= 5  THEN 1.2 -- 1.2x surge for 5-9 pings
        ELSE 1.0
      END AS surge_multiplier
    FROM cluster_centers;
  `;

  try {
    const { rows } = await pool.query(hotspotQuery);
    console.log(`Found ${rows.length} surge hotspots.`);

    // We now format the response to include the surge multiplier.
    const hotspots = rows.map(row => ({
      location: {
        type: 'Point',
        coordinates: row.center_point.coordinates,
      },
      weight: row.ping_count,
      surge_multiplier: row.surge_multiplier, // Include the new surge field
    }));

    res.json(hotspots);

  } catch (error) {
    console.error('❌ Error fetching hotspots with surge:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;
