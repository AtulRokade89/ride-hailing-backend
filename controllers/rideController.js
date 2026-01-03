// controllers/rideController.js
const { v4: uuidv4 } = require('uuid');
const { getIo, getActiveDrivers } = require('../socket'); // socket.js exports
// NOTE: getIo() will throw if socket server not initialized; we handle that.

// Default search radius for nearby drivers (in km)
const SEARCH_RADIUS_KM = 5;

function _deg2rad(deg) {
  return deg * (Math.PI / 180);
}

function _haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius km
  const dLat = _deg2rad(lat2 - lat1);
  const dLon = _deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(_deg2rad(lat1)) * Math.cos(_deg2rad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * HTTP endpoint: passenger requests a ride
 * Body expected:
 * {
 * passengerId: <int|string>,
 * pickup: { latitude: number, longitude: number },
 * destination: { latitude: number, longitude: number },
 * vehicleType: "BIKE" | "SUV" | ...,
 * estimatedFare: number,
 * distanceKm: number
 * }
 */
exports.requestRide = async (req, res) => {
  try {
    const {
      passengerId,
      pickup,
      destination,
      vehicleType: rawVehicleType, // Capture raw type
      estimatedFare,
      distanceKm,
      requestTime,
    } = req.body;

    // CRITICAL FIX: Standardize vehicleType to uppercase to match driver rooms
    const vehicleType = rawVehicleType ? rawVehicleType.toString().toUpperCase() : null;
    
    // --- DIAGNOSTIC LOG ADDED ---
    console.log(`[Ride Request] Received rawType: ${rawVehicleType} | Standardized Type: ${vehicleType}`);
    // ----------------------------
    
    // Check for essential data
    if (!passengerId || !pickup || !destination || !vehicleType) {
      return res.status(400).json({ success: false, message: 'Missing required fields (passengerId, pickup, destination, or vehicleType)' });
    }

    const rideId = uuidv4();
    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    // Prepare the outgoing ride request object
    const outgoing = {
      rideId,
      passengerId: passengerId.toString(),
      pickupLocation: pickup,
      destinationLocation: destination,
      vehicleType,
      estimatedFare,
      distanceKm,
      requestTime,
      otp,
    };

    let notified = 0;
    
    // Attempt to notify nearby drivers
    try {
      const io = getIo(); // Throws if not initialized
      const activeDrivers = getActiveDrivers();

      const pLat = pickup.latitude;
      const pLon = pickup.longitude;
      const radiusKm = SEARCH_RADIUS_KM;

      const candidates = [];

      for (const [driverId, info] of Object.entries(activeDrivers)) {
        // 1. Check if driver's vehicle type matches the request type
        // 2. Check if driver has reported location (lat/lon are not null)
        if (info.vehicleType === vehicleType && info.latitude !== null && info.longitude !== null) {
          const dLat = info.latitude;
          const dLon = info.longitude;
          const dist = _haversineDistanceKm(pLat, pLon, dLat, dLon);

          // 3. Check if driver is within the radius
          if (dist <= radiusKm) {
            candidates.push({ driverId, socketId: info.socketId, dist });
          }
        }
      }

      console.log(`[RideRequest] Found ${candidates.length} candidate drivers for ${vehicleType} within ${radiusKm}km.`);
      
      if (candidates.length === 0) {
        // fallback: if no driver found within radius, emit to the entire vehicle room (drivers:SUV)
        if (vehicleType) {
          io.to(`drivers:${vehicleType}`).emit('newRideRequest', outgoing);
          notified = -1; // unknown number (room broadcast)
          console.log(`[RideRequest] Falling back: Broadcasting to room drivers:${vehicleType}`);
        } else {
          // This should rarely happen now that we check for vehicleType above
          io.emit('newRideRequest', outgoing);
          notified = -1;
          console.log(`[RideRequest] Falling back: Broadcasting to all connected sockets`);
        }
      } else {
        // sort by distance and notify each candidate individually
        candidates.sort((a, b) => a.dist - b.dist);
        for (const c of candidates) {
          io.to(c.socketId).emit('newRideRequest', outgoing);
          notified++;
          console.log(`[RideRequest] Notified driver ${c.driverId} (dist: ${c.dist.toFixed(2)}km)`);
        }
      }
    } catch (socketErr) {
      // Socket might not be initialized — fallback to returning success but no notifications
      console.warn('Socket not ready or getIo() failed, skipping push notifications:', socketErr && socketErr.message ? socketErr.message : socketErr);
    }

    // Return acknowledgement to HTTP client
    return res.status(200).json({
      success: true,
      message: 'Ride request received and processed',
      data: { rideId, notified },
      outgoing,
    });
  } catch (err) {
    console.error('requestRide error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
