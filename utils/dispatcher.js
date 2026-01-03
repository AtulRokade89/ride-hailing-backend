// In utils/dispatcher.js

// This function contains the logic to find a driver for a specific ride.
async function findDriverForRide(ride, pool, io) {
  console.log(`[DISPATCHER] Initiating driver search for ride ${ride.external_id}`);
  
  const client = await pool.connect();
  
  try {
    // Step 1: Update the ride status to 'SEARCHING'
    await client.query(
      `UPDATE scheduled_rides SET status = 'SEARCHING' WHERE external_id = $1`,
      [ride.external_id]
    );

    // Step 2: Prepare the data to send to the driver
    const rideRequestData = {
      rideId: ride.external_id,
      pickupAddress: ride.pickup_address,
      dropoffAddress: ride.dropoff_address,
      estimatedFare: ride.estimated_fare,
      scheduledPickupTime: ride.scheduled_pickup_time,
    };

    // Step 3: Emit the socket event to available drivers
    if (io) {
      io.to('available_drivers').emit('new-scheduled-ride-request', rideRequestData);
      console.log(`[DISPATCHER] Emitted ride request ${ride.external_id} to 'available_drivers' room.`);
    } else {
      console.error('[DISPATCHER] IO object is not available. Cannot emit socket event.');
    }

  } catch (e) {
    console.error(`[DISPATCHER] Error processing ride ${ride.external_id}:`, e);
    // Revert status on failure so it can be retried
    await client.query(
        `UPDATE scheduled_rides SET status = 'SCHEDULED' WHERE external_id = $1`,
        [ride.external_id]
    );
  } finally {
    client.release();
  }
}

// Export the function so other files can use it
module.exports = { findDriverForRide };
