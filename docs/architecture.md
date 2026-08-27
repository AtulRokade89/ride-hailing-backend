# Architecture

This document gives a high-level view of the production system. It is meant for developers, operators, and support/admin users who need to understand how the moving parts connect.

## System Overview

```text
Flutter App
    |
    | HTTPS APIs + Socket.IO events
    v
Node.js Backend
    |
    | SQL queries
    v
PostgreSQL
```

External services:

- Firebase Cloud Messaging: push notifications for passenger and driver updates.
- Google Maps: location, route, distance, pickup, and dropoff workflows.
- Razorpay: online payment order creation and payment confirmation.
- Socket.IO: live ride matching, ride status updates, driver/passenger events, waiting charge updates, and safety events.
- Admin Panel: operational checks, support workflows, ride/payment review, and monitoring.

## Backend Responsibilities

- Create and manage ride requests.
- Match passengers with nearby eligible drivers.
- Maintain live driver/passenger socket state.
- Handle driver acceptance, arrival, OTP verification, ride start, and ride completion.
- Track waiting charges after the free waiting period.
- Calculate final fare using base fare, waiting amount, extra distance, tolls, and penalties where applicable.
- Create payment, invoice, wallet ledger, and log entries.
- Handle safety flows such as SOS and route deviation.
- Clean up driver state, ride state, timers, and socket state after completion/cancellation.

## Main Data Stores

- `rides`: normal ride lifecycle, fare, status, driver/passenger IDs, and final fare.
- `scheduled_rides`: scheduled ride lifecycle and scheduled ride status.
- `ride_invoices`: final invoice breakdown.
- `wallet_ledger`: driver/platform wallet credits and debits.
- `driver_wallets`: calculated wallet balance.
- `pending_payments`: pending penalties or waiting-related amounts that need collection.
- Safety tables: SOS, route deviation, and safety state tracking.

## Production Assumptions

- Backend environment variables are configured before deployment.
- PostgreSQL migrations/schema changes are already applied.
- Razorpay keys are production keys in production environment.
- Firebase configuration is production-ready.
- Google Maps key has the required APIs enabled.
- Socket.IO is reachable by Flutter clients from the production domain/API host.

## Important Checks Before Launch

- Confirm API health endpoint works.
- Confirm socket connection works for both passenger and driver apps.
- Confirm production database backup plan exists.
- Confirm logs are visible for API, socket, payment, and database errors.
- Confirm rollback plan exists before deploying new backend changes.
