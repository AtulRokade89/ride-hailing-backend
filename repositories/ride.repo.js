// repositories/ride.repo.js

async function getByExternalId(pool, rideExternalId) {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM rides
    WHERE external_id = $1
    LIMIT 1
    `,
    [rideExternalId]
  );

  return rows[0] || null;
}

module.exports = {
  getByExternalId
};
