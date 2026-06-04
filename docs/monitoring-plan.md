# Monitoring Plan

Need logs for:

- API errors.
- Socket errors.
- Payment failures.
- Razorpay verification failures.
- Slow database queries.
- Ride state stuck issues.
- Waiting timer start/stop issues.
- Flutter crashes.
- Admin panel errors.

Useful alerts:

- Payment success received but ride not completed.
- Ride stuck in `ARRIVED` or `IN_TRANSIT` for too long.
- Driver online but no socket heartbeat.
- High API error rate.
- Database connection failures.
- Repeated Socket.IO disconnects.

Future monitoring setup:

- Firebase Crashlytics for Flutter crashes.
- PM2 for Node.js process management.
- PM2 logs for backend runtime errors.
- PostgreSQL slow query logging.
- Cloudflare for DNS, SSL, and basic traffic protection.
- Uptime monitor for backend health endpoint.

Pre-launch checklist:

- Verify GitHub repositories are pushed.
- Keep one local backup and one cloud/external backup.
- Confirm production environment variables.
- Confirm database backup plan.
- Confirm rollback plan before deployment.

Health Endpoints

/health
/api/health