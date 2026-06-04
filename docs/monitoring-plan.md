# Monitoring Plan

This document lists the logs, alerts, and checks needed for production operations.

## Logs Needed

- API errors.
- Socket.IO connection and event errors.
- Payment failures.
- Razorpay signature verification failures.
- Slow database queries.
- Ride state changes.
- Waiting timer start/stop events.
- Wallet ledger creation failures.
- Invoice creation failures.
- Flutter app crashes.
- Admin panel errors.

## Alerts Needed

- Backend API is down.
- Database connection fails.
- Payment success received but ride is not completed.
- Ride stuck in `ARRIVED` for too long.
- Ride stuck in `IN_TRANSIT` for too long.
- Driver remains online without socket heartbeat.
- High API error rate.
- Repeated Socket.IO disconnects.
- Wallet ledger insert/update failure.
- Invoice insert/update failure.

## Manual Checks During Launch

- Create a test ride in production with a real driver/passenger test account.
- Verify driver receives ride request.
- Verify passenger receives driver arrival and OTP flow.
- Verify waiting charge updates after the free period.
- Verify OTP starts the ride and stops waiting timer.
- Complete ride and verify final fare.
- Verify invoice amount matches final fare.
- Verify wallet ledger entry is created.
- Verify payment log is created.
- Verify admin panel can see the ride/payment details.

## Future Monitoring Setup

- Firebase Crashlytics for Flutter crashes.
- PM2 for Node.js process management.
- PM2 logs for backend runtime errors.
- PostgreSQL slow query logging.
- Cloudflare for DNS, SSL, and basic traffic protection.
- Uptime monitor for backend health endpoint.
- Daily database backup verification.
- Basic dashboard for rides, payments, failures, and stuck states.
-Stuck rides by status
-Duplicate ride assignments
-FCM notification failures
-Cron job failures

## Pre-Launch Checklist

- GitHub repositories are pushed.
- Local code backup exists.
- Cloud/external backup exists.
- Production environment variables are confirmed.
- Production database backup plan is confirmed.
- Razorpay production keys are confirmed.
- Google Maps production key is confirmed.
- Firebase production config is confirmed.
- Rollback plan is written before deployment.

## Launch Rule

Do not make major production decisions while tired. If a deployment step feels unclear, pause and verify before continuing.
