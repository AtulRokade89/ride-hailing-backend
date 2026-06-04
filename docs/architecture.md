# Architecture

High-level production architecture:

```text
Flutter App
    |
    v
Node.js Backend
    |
    v
PostgreSQL
```

Repositories

ride-hailing-backend
rideapp
ride-admin-web


Production Components

Domain
Cloudflare
VPS
PostgreSQL
PM2
Firebase
Razorpay

Supporting services:

- Socket.IO for live ride status, driver matching, waiting charges, and ride updates.
- Firebase Cloud Messaging for push notifications.
- Google Maps for location, routes, distance, and address workflows.
- Razorpay for online payments.
- Admin Panel for operations, monitoring, support, and manual checks.

Core backend responsibilities:

- Ride creation and matching.
- Driver/passenger socket lifecycle.
- OTP verification and ride state changes.
- Waiting, extra distance, toll, and final fare calculation.
- Payment, invoice, wallet ledger, and logs.
- Safety events such as SOS and route deviation.
