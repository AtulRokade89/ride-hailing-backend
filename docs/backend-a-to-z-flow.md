# Backend A-to-Z Flow

This document describes the full backend flow for the ride-hailing system, from server startup to ride matching, payments, invoices, wallets, support, safety, admin, and background jobs.

Source backend:

```text
D:\ride-hailing-project\ride-hailing-backend
```

Related docs:

```text
D:\ride-hailing-project\ride-hailing-backend\docs\architecture.md
D:\ride-hailing-project\ride-hailing-backend\docs\ride-flow.md
D:\ride-hailing-project\ride-hailing-backend\docs\payment-flow.md
D:\ride-hailing-project\ride-hailing-backend\docs\flutter-app-flow.md
```

## System Startup

```text
node server.js
    |
    v
Load environment variables
    |
    v
Create Express app and HTTP server
    |
    v
Initialize Firebase Admin SDK
    |
    v
Create PostgreSQL pool
    |
    v
Register static uploads folder
    |
    v
Register CORS and JSON middleware
    |
    v
Mount API routes under /api
    |
    v
Initialize Socket.IO server
    |
    v
Expose global io/pool/active socket state
    |
    v
Initialize cron jobs
    |
    v
Listen on configured PORT
```

Core runtime:

- Node.js >= 18.
- Express 5.
- PostgreSQL via `pg`.
- Socket.IO for realtime passenger/driver/admin events.
- Firebase Admin for FCM push notifications.
- Razorpay for online payment orders and verification.
- node-cron for scheduled jobs.
- PDFKit for invoice PDF generation.
- multer for uploaded ad and driver document files.

## Main Backend Modules

```text
server.js
    |
    +--> routes/*              HTTP API surface
    +--> socket.js             live ride lifecycle and realtime events
    +--> controllers/*         admin/auth/driver/tickets/ads logic
    +--> services/*            notifications, logs, safety, settlements
    +--> repositories/*        safety and ride DB helpers
    +--> utils/*               dispatching, tax, money, rating, FCM topics
    +--> cron_jobs.js          recurring production jobs
    +--> db.js                 PostgreSQL pool helper
```

## Route Mount Map

```text
/api/auth                    -> routes/auth.js
/api/driver                  -> routes/driverVerification.js
/api/driver                  -> routes/driver.js
/api/ride                    -> routes/ride.js
/api/payment                 -> routes/payment.js
/api/wallet                  -> routes/wallet.js
/api/invoices                -> routes/invoices.js
/api/settlement              -> routes/settlement.js
/api/dues                    -> routes/dues.js
/api/demand                  -> routes/demand.js
/api/schedule                -> routes/schedule.js
/api/user                    -> routes/user.js
/api/ads                     -> routes/ads.routes.js
/api/tickets                 -> routes/tickets.routes.js
/api/dispute                 -> routes/dispute.js
/api/toll                    -> routes/toll.js
/api/quote                   -> routes/quote.js
/api/admin                   -> admin dashboard, drivers, wallet, rides, payments, notifications
/api/admin/support           -> admin support tickets
/api/admin/driver-settlements -> driver settlement admin routes
/uploads                     -> static uploaded files
```

Note:

- In `server.js`, the driver settlement mount references `./Routes/driverSettlement.routes` while the folder listing shows `routes/driverSettlement.routes.js`. On case-sensitive deployments this path must be checked.

## Auth Flow

```text
POST /api/auth/register
    |
    v
Validate input
    |
    v
Hash password
    |
    v
Create user with role passenger/driver
    |
    +--> passenger
    |       |
    |       v
    |   Optional referral code / device id logic
    |       |
    |       v
    |   Return registration success
    |
    +--> driver
            |
            v
        Return token/userId for verification upload flow
```

```text
POST /api/auth/login
    |
    v
Find user by email
    |
    v
Verify password
    |
    v
If passenger -> return token, userId, role, first ride state
    |
    v
If driver -> check verification, dues/block status, vehicle info, referral code
    |
    v
If driver blocked by dues -> return 403 with due details
    |
    v
Otherwise return token and role-specific data
```

Auth endpoints:

```text
POST /api/auth/register
POST /api/auth/login
GET  /api/auth/verify/:token
POST /api/auth/referral/lock-free-ride
POST /api/auth/referral/cancel-abuse
```

## User And FCM Token Flow

```text
App login succeeds
    |
    v
App gets Firebase token
    |
    v
POST /api/user/update-fcm-token
    |
    v
Backend stores token in fcm_tokens
```

```text
User logout
    |
    v
POST /api/user/logout
    |
    v
Backend clears/deletes FCM token for user
    |
    v
App clears local storage and disconnects socket
```

User endpoints:

```text
POST /api/user/update-fcm-token
POST /api/user/logout
POST /api/user/test-notification
```

## Driver Verification Flow

```text
Driver registers or logs in with verification required
    |
    v
POST /api/driver/verify with document uploads
    |
    v
Backend saves files in uploads/driver_docs
    |
    v
Backend creates/updates driver_verifications
    |
    v
Admin reviews verification
    |
    +--> activate
    |       |
    |       v
    |   PUT /api/driver/activate/:userId
    |       |
    |       v
    |   Driver becomes active
    |
    +--> reject
            |
            v
        PUT /api/admin/driver-verifications/reject/:userId
```

Driver verification endpoints:

```text
POST /api/driver/verify
GET  /api/driver/status/:userId
PUT  /api/driver/activate/:userId
GET  /api/admin/driver-verifications
PUT  /api/admin/driver-verifications/reject/:userId
POST /api/driver/accept-terms
PUT  /api/driver/unblock-after-payment
```

## Quote And Demand Flow

```text
Passenger searches/selects pickup and drop
    |
    v
GET /api/quote
    |
    v
Backend calculates vehicle fare using distance, vehicle type, GST/EV rules, surge/demand if applicable
    |
    v
App displays fare quote
```

```text
Passenger app sends demand ping
    |
    v
POST /api/demand/demand-ping
    |
    v
Backend stores recent location in rider_demand_pings
    |
    v
GET /api/demand/hotspots can cluster recent demand
```

Quote/demand endpoints:

```text
GET  /api/quote
POST /api/demand/demand-ping
GET  /api/demand/hotspots
```

## Socket Connection Flow

```text
Client connects to Socket.IO
    |
    v
Client emits join
    |
    +--> passenger
    |       |
    |       v
    |   Join passengers and passenger:{userId} rooms
    |       |
    |       v
    |   Store activePassengers[userId]
    |
    +--> driver
            |
            v
        Join driver:{userId}, available_drivers, and drivers:{vehicleType}
            |
            v
        Store activeDrivers[userId]
            |
            v
        Update/track current driver location and online state
```

Important socket rooms/state:

```text
passenger:{userId}
driver:{userId}
drivers:{vehicleType}
available_drivers
admin_room
global.activePassengers
global.activeDrivers
```

Important connection events:

```text
join
register
join_admin
appVisibility
driverOnlineToggle
driver-go-online
driver-go-offline
driverLocationUpdate
disconnect
```

## Normal Ride Request And Matching Flow

```text
Passenger emits requestRide
    |
    v
Backend validates pickup, destination, passenger, vehicle, fare, OTP
    |
    v
Create rides row with SEARCHING/PENDING state
    |
    v
Find eligible active drivers by vehicle type and location
    |
    v
Send newRideRequest to candidate drivers
    |
    v
Passenger receives searchStarted / rideCreated
    |
    v
Drivers see request modal
```

Driver accept flow:

```text
Driver emits driverAccept
    |
    v
Backend checks ride still available and driver eligible
    |
    v
Update ride driver_id and status ACCEPTED
    |
    v
Dismiss request from other drivers
    |
    v
Passenger receives rideAccepted and ride-status-update
    |
    v
Driver receives driverAcceptedAck
    |
    v
Driver starts route to pickup
```

Driver reject / rematch flow:

```text
Driver emits driverReject or driverCancel before start
    |
    v
Backend updates/reopens ride search where applicable
    |
    v
Passenger receives rematchInitiated/rematchRound/rematchSucceeded/rematchFailed
    |
    v
Other eligible drivers can receive newRideRequest
```

Passenger cancellation flow:

```text
Passenger emits cancelRide or cancelRideSearch
    |
    v
Backend stops search or cancels accepted ride
    |
    v
If waiting amount exists, pending payment may be created
    |
    v
Driver receives rideCancelledByPassenger / dismissRideRequest
    |
    v
Passenger/driver waiting timers stop
```

Important ride socket events:

```text
requestRide
rideCreateError
searchStarted
rideCreated
noDriversNearby
newRideRequest
requestRideResend
driverAccept
driverAcceptedAck
rideAlreadyAccepted
dismissRideRequest
rideAccepted
ride-status-update
driverReject
driverCancel
driverCancelAck
cancelRide
cancelRideSearch
rideCancelledByPassenger
rematchInitiated
rematchRound
rematchSucceeded
rematchFailed
```

## Arrival, Waiting, OTP, And Ride Start Flow

```text
Driver location updates continue after accept
    |
    v
Backend detects driver near pickup
    |
    v
Passenger/driver receive waitingWarning
    |
    v
Free waiting countdown starts
    |
    v
If passenger taps coming -> passengerComing stops timer
    |
    v
If free period expires -> waitingStarted and waitingUpdate events emit charge
```

```text
Driver enters passenger OTP
    |
    v
Driver emits verifyOtp
    |
    v
Backend validates ride assignment and OTP
    |
    v
Update rides status to IN_TRANSIT
    |
    v
Driver receives otpVerified with destination data
    |
    v
Passenger receives rideStarted and ride-status-update
```

Waiting/OTP events:

```text
waitingWarning
waitingTick
waitingStarted
waitingUpdate
waitingStopped
passengerComing
verifyOtp
otpVerified
otpFailed
rideStarted
```

## Ride Completion Flow

```text
Driver chooses cash or online completion
    |
    v
App emits completeRide after cash confirmation or payment verification
    |
    v
Backend loads ride, pending payments, waiting, toll, extra distance, fare components
    |
    v
Calculate final fare
    |
    v
Update ride status COMPLETED and final_fare
    |
    v
Create/update GST ledger where applicable
    |
    v
Create wallet ledger entries
    |
    v
Update driver_wallets balance
    |
    v
Create/update ride_invoices with fare breakdown
    |
    v
Mark collected pending payments where applicable
    |
    v
Handle first ride/referral company-pay logic where applicable
    |
    v
Emit rideCompleted to passenger and driver
    |
    v
Unlock scheduled ride lock if required
```

Final fare can include:

- Base fare.
- Waiting charge.
- Extra distance charge.
- Toll charge.
- Pending payment/penalty collection.
- GST where applicable.
- First ride free/referral subsidy logic where applicable.

## Payment Flow

Razorpay order flow:

```text
POST /api/payment/create-order
    |
    v
Backend creates Razorpay order
    |
    v
App opens Razorpay checkout
    |
    v
POST /api/payment/verify
    |
    v
Backend verifies Razorpay signature
    |
    v
Payment log/ride payment state updated
    |
    v
App emits completeRide paidByCash=false
```

UPI QR flow:

```text
POST /api/payment/create-upi-order
    |
    v
Backend creates UPI order/reference
    |
    v
App displays QR and polls status
    |
    v
When paid, app emits completeRide paidByCash=false
```

Payment endpoints:

```text
GET  /api/payment/ping
POST /api/payment/create-order
POST /api/payment/verify
POST /api/payment/create-upi-order
```

Production payment checks:

- Verify Razorpay signature before completing online rides.
- Ignore duplicate/stale payment callbacks.
- Avoid duplicate wallet entries with conflict keys.
- Ensure final_fare, invoice total, payment logs, and wallet ledger agree.

## Cash, Wallet, Dues, And Settlement Flow

Cash ride completion:

```text
Driver confirms cash received
    |
    v
Backend completes ride as paidByCash=true
    |
    v
Driver keeps cash in hand
    |
    v
Platform commission/GST due is recorded in wallet_ledger as debit where applicable
    |
    v
Driver dues reminders/block logic use unsettled wallet rows
```

Online ride completion:

```text
Online payment verified
    |
    v
Backend credits driver earning in wallet_ledger
    |
    v
driver_wallets balance recalculates from ledger
```

Dues payment flow:

```text
Driver has pending dues
    |
    v
POST /api/dues/create-order
    |
    v
Driver pays with Razorpay
    |
    v
POST /api/dues/verify-payment
    |
    v
Backend verifies signature/order notes
    |
    v
wallet_ledger due rows marked settled
    |
    v
Driver unblocked if needed
    |
    v
platform_ledger records settlement
```

Settlement endpoints:

```text
GET  /api/wallet/me
POST /api/wallet/cash-report
PATCH /api/wallet/cash-match
GET  /api/settlement/pending/:driverId
POST /api/settlement/create-order
POST /api/settlement/verify-payment
POST /api/dues/create-order
POST /api/dues/verify-payment
GET  /api/admin/driver-settlements/pending
POST /api/admin/driver-settlements/pay
GET  /api/admin/driver-settlements/history
GET  /api/admin/driver-settlements/weekly-summary
GET  /api/admin/driver-settlements/export
```

## Invoice Flow

```text
Ride completed
    |
    v
Backend inserts/updates ride_invoices
    |
    v
Invoice number generated with LR + date + padded id
    |
    v
Passenger/driver/admin can fetch invoice details or PDF
```

Invoice endpoints:

```text
GET  /api/invoices/history
POST /api/invoices/generate
GET  /api/invoices/:invoiceNumber/pdf
GET  /api/invoices/:rideId/pdf
GET  /api/invoices/:rideId
```

Invoice data should include:

- Ride external id.
- Passenger and driver data.
- Base fare.
- Waiting amount.
- Extra distance amount.
- Toll amount.
- Pending/penalty amount.
- GST breakdown where applicable.
- Final total.

## Scheduled Ride Flow

```text
Passenger creates scheduled ride
    |
    v
POST /api/schedule/create
    |
    v
scheduled_rides row created with SCHEDULED status
    |
    v
Cron checks rides near pickup window
    |
    v
utils/dispatcher finds nearby eligible driver
    |
    v
Driver receives new-scheduled-ride-request
    |
    v
Driver emits accept-scheduled-ride
    |
    v
Backend locks scheduled ride to driver
    |
    v
Driver emits start-driving-to-scheduled-pickup
    |
    v
Backend updates EN_ROUTE_TO_PICKUP and notifies passenger
    |
    v
Driver emits driver-arrived-for-scheduled-ride
    |
    v
Backend updates ARRIVED, emits OTP/waiting warning
    |
    v
Driver emits verify-scheduled-otp
    |
    v
Backend creates/updates linked rides row and starts IN_TRANSIT
    |
    v
completeRide completes ride and unlocks driver
```

Scheduled endpoints/events:

```text
GET  /api/schedule/quote
POST /api/schedule/create
GET  /api/schedule/upcoming
GET  /api/schedule/passenger/:passengerId
POST /api/schedule/cancel

new-scheduled-ride-request
accept-scheduled-ride
driver-locked
driver-unlocked
start-driving-to-scheduled-pickup
driver-arrived-for-scheduled-ride
scheduledRideArrivedAck
verify-scheduled-otp
```

## Toll Flow

```text
Driver adds toll amount
    |
    v
POST /api/toll/add
    |
    v
Backend inserts toll_charges row with pending status
    |
    v
Passenger receives tollChargeRequest
    |
    v
Passenger responds
    |
    v
POST /api/toll/respond
    |
    +--> approved
    |       |
    |       v
    |   Backend marks approved and updates fare/toll state
    |       |
    |       v
    |   Driver receives tollApprovedByPassenger
    |       |
    |       v
    |   Passenger receives fareUpdatedWithToll
    |
    +--> rejected
            |
            v
        Driver receives tollRejectedByPassenger
```

Toll endpoints:

```text
POST /api/toll/add
POST /api/toll/respond
GET  /api/toll/:rideId
```

## Extra Distance Flow

```text
Driver is in progress near/or beyond original drop
    |
    v
Driver emits driver_extra_distance_request
    |
    v
Backend checks distance/proximity rules
    |
    v
Passenger receives extra_distance_approval_request
    |
    v
Passenger emits passenger_extra_distance_response
    |
    +--> approved
    |       |
    |       v
    |   Backend marks extra distance approved
    |       |
    |       v
    |   driverLocationUpdate loop tracks distance and charge
    |       |
    |       v
    |   Both apps receive extra_distance_update
    |
    +--> rejected
            |
            v
        Driver receives extra_distance_rejected
```

Extra distance events:

```text
driver_extra_distance_request
extra_distance_request_sent
extra_distance_too_early
extra_distance_approval_request
passenger_extra_distance_response
extra_distance_approved
extra_distance_rejected
extra_distance_update
```

## Dispute Flow

```text
Passenger or driver raises dispute
    |
    v
POST /api/dispute/raise
    |
    v
Backend finds ride in rides or scheduled_rides
    |
    v
Create ride_disputes row with partial fare and deadlines
    |
    v
Update ride status DISPUTED where applicable
    |
    v
Notify other party via socket/FCM
```

```text
User responds to dispute
    |
    v
POST /api/dispute/respond
    |
    v
Backend records driver/passenger acceptance
    |
    +--> both accept
    |       |
    |       v
    |   Dispute AUTO_RESOLVED
    |       |
    |       v
    |   Ride moves PARTIAL_COMPLETE
    |
    +--> waiting for other party
    |       |
    |       v
    |   Status WAITING_FOR_OTHER_PARTY
    |
    +--> timeout or rejection
            |
            v
        Status PENDING_ADMIN_REVIEW
```

Admin dispute resolution:

```text
Admin resolves dispute
    |
    v
POST /api/admin/dispute/resolve
    |
    v
Backend credits driver share
    |
    v
Creates platform ledger and pending payment where applicable
    |
    v
Marks ride PARTIAL_COMPLETE
    |
    v
Notifies passenger and driver
```

Dispute endpoints:

```text
POST /api/dispute/raise
POST /api/dispute/respond
GET  /api/dispute/status/:rideExternalId
GET  /api/dispute/admin/pending
POST /api/admin/dispute/resolve
```

## Safety, SOS, And Route Deviation Flow

Route deviation:

```text
Driver/app emits route_deviation_soft or backend detects route issue
    |
    v
safety.service records ride_safety_events
    |
    v
ride_safety_state is created/updated
    |
    v
Passenger can receive ride_safety_warning
    |
    v
Driver can explain route
    |
    v
Passenger receives route_change_confirmation
    |
    v
Passenger emits route_change_decision
    |
    v
Driver receives route_change_decision_result
```

Hard safety termination:

```text
Safety/admin emits terminate_ride
    |
    v
Backend marks ride cancelled/terminated by safety
    |
    v
Passenger and driver receive ride_terminated
```

SOS:

```text
Driver/passenger emits sos_triggered
    |
    v
Backend inserts ride_safety_events and upserts ride_sos_state
    |
    v
Backend marks rides.is_sos_active = true
    |
    v
Admin room receives sos_alert
    |
    v
Driver/passenger receive sos_ack
    |
    v
If no response before timer -> admin room receives sos_escalated
    |
    v
Admin emits sos_resolved
    |
    v
Backend marks SOS resolved and clears active state
```

Safety events:

```text
route_deviation_soft
driver_route_explanation
route_change_confirmation
route_change_decision
route_change_decision_result
terminate_ride
ride_terminated
sos_triggered
sos_alert
sos_ack
sos_escalated
sos_resolved
sos_resolved_ack
```

## Ticket Support Flow

```text
User selects eligible ride
    |
    v
GET /api/tickets/eligible-rides
    |
    v
POST /api/tickets/create
    |
    v
Backend creates tickets row and first ticket_messages row
    |
    v
User/admin can fetch ticket thread
    |
    v
POST /api/tickets/:ticketId/message or admin reply
    |
    v
Backend inserts message and updates status
    |
    v
FCM notification goes to other party
    |
    v
Ticket can be completed, reopened, or closed
```

Ticket endpoints:

```text
GET  /api/tickets/eligible-rides
GET  /api/tickets/by-ride
POST /api/tickets/create
GET  /api/tickets/:ticketId
POST /api/tickets/:ticketId/message
POST /api/tickets/:ticketId/reopen
POST /api/tickets/:ticketId/close

GET  /api/admin/support/support-tickets
GET  /api/admin/support/support-tickets/export
GET  /api/admin/support/support-tickets/:ticketId
POST /api/admin/support/support-tickets/:ticketId/message
POST /api/admin/support/support-tickets/:ticketId/passenger-reply
POST /api/admin/support/support-tickets/:ticketId/close
```

## Ads And Notifications Flow

Ads:

```text
Admin creates ad
    |
    v
POST /api/ads with optional image upload
    |
    v
Image saved in uploads/ads
    |
    v
App fetches active ads with GET /api/ads
```

Ads endpoints:

```text
GET    /api/ads
POST   /api/ads
GET    /api/ads/admin/list
PATCH  /api/ads/:id/status
PUT    /api/ads/:id
DELETE /api/ads/:id
```

Admin notification:

```text
Admin creates notification
    |
    v
POST /api/admin/notifications
    |
    +--> immediate
    |       |
    |       v
    |   Send topic notification now
    |
    +--> scheduled
            |
            v
        Store PENDING row
            |
            v
        scheduledNotification.job sends when scheduled_at <= NOW()
```

Notification endpoints:

```text
POST /api/admin/notifications
GET  /api/admin/notifications
```

## Admin Operations Flow

Admin dashboard endpoints provide:

```text
GET /api/admin/dashboard/rides-summary
GET /api/admin/dashboard/deviations
GET /api/admin/dashboard/live-map
GET /api/admin/dashboard/stats
GET /api/admin/dashboard/alerts
GET /api/admin/top-drivers-today
GET /api/admin/best-day
GET /api/admin/star-driver
```

Admin ride/payment endpoints:

```text
GET /api/admin/rides
GET /api/admin/payments
GET /api/admin/payments/export
GET /api/admin/drivers
GET /api/admin/drivers/:driverId/wallet
POST /api/admin/wallet/adjust
PUT /api/admin/referral-subsidy/:rideId/mark-paid
```

Admin responsibilities:

- Monitor ride status and stuck rides.
- Review payments and export CSVs.
- Adjust wallet balances when needed.
- Review driver verification.
- Review support tickets.
- Resolve disputes.
- Monitor safety/SOS/deviation events.
- Mark referral subsidy/company-pay items as paid.

## Background Jobs

Cron jobs initialized from `cron_jobs.js`:

```text
Every 5 minutes
    |
    v
Find scheduled rides 60-70 minutes away
    |
    v
Send heads-up notification to selected driver
    |
    v
Mark scheduled ride is_pre_notified
```

```text
Every 1 minute
    |
    v
Find scheduled rides in dispatch window
    |
    v
Call utils/dispatcher.findDriverForRide
    |
    v
Emit new-scheduled-ride-request to nearby driver
```

```text
Every 3 hours
    |
    v
Find unsettled wallet_ledger dues
    |
    v
Send settlementReminder to online drivers
```

```text
Daily midnight
    |
    v
Find overdue unsettled wallet_ledger rows
    |
    v
Block overdue drivers
```

```text
Every minute
    |
    v
Find ride_disputes whose 15-minute window expired
    |
    +--> both accepted -> AUTO_RESOLVED and PARTIAL_COMPLETE
    +--> not both accepted -> PENDING_ADMIN_REVIEW
```

```text
Every hour
    |
    v
Find disputes pending admin review beyond 48 hours
    |
    v
Auto-resolve timeout
    |
    v
Credit driver partial fare, create platform ledger, create pending payment
    |
    v
Mark ride PARTIAL_COMPLETE and notify both parties
```

Scheduled notification job:

```text
Every minute
    |
    v
Find admin_notifications with send_type=SCHEDULED and status=PENDING
    |
    v
Send topic notification
    |
    v
Mark SENT or FAILED
```

## Main Data Stores

Core user/driver:

```text
users
drivers
driver_verifications
fcm_tokens
referrals
```

Ride lifecycle:

```text
rides
scheduled_rides
ride_logs
payment_logs
ride_invoices
passenger_ratings
ride_rating_tags
```

Money and settlement:

```text
wallet_ledger
driver_wallets
platform_ledger
gst_ledger
pending_payments
```

Support/admin/content:

```text
tickets
ticket_messages
admin_notifications
ads
```

Safety:

```text
ride_safety_events
ride_safety_state
ride_sos_state
ride_route_snapshots
```

Dynamic pricing/location:

```text
rider_demand_pings
toll_charges
```

## Key Status Values

Normal ride statuses seen in code/docs:

```text
SEARCHING
PENDING
ACCEPTED
ARRIVED
IN_TRANSIT
COMPLETED
CANCELLED
EXPIRED
DISPUTED
PARTIAL_COMPLETE
```

Scheduled ride statuses seen in code/docs:

```text
SCHEDULED
ACCEPTED
EN_ROUTE_TO_PICKUP
ARRIVED
IN_TRANSIT
COMPLETED
CANCELLED
CANCELLED_BY_DRIVER
DISPUTED
PARTIAL_COMPLETE
```

Dispute statuses:

```text
OPEN
WAITING_FOR_OTHER_PARTY
AUTO_RESOLVED
PENDING_ADMIN_REVIEW
ADMIN_RESOLVED
TIMEOUT_RESOLVED
```

Toll statuses:

```text
PENDING
APPROVED
REJECTED
```

Ticket statuses seen in flow:

```text
SUBMITTED
COMPLETED
RE_OPENED
CLOSED
```

## End-To-End Normal Ride Summary

```text
Passenger login
    |
    v
Passenger joins socket
    |
    v
Passenger gets quote and emits requestRide
    |
    v
Backend creates ride and dispatches to drivers
    |
    v
Driver joins socket and receives newRideRequest
    |
    v
Driver accepts
    |
    v
Backend updates ride ACCEPTED and notifies passenger
    |
    v
Driver moves to pickup and sends location
    |
    v
Waiting warning/timer may run
    |
    v
Driver verifies OTP
    |
    v
Backend updates ride IN_TRANSIT
    |
    v
Driver completes with cash or verified online payment
    |
    v
Backend computes final fare
    |
    v
Backend writes invoice, wallet, GST, payment logs
    |
    v
Backend emits rideCompleted
    |
    v
Passenger/driver rating flow
    |
    v
Cleanup timers, active ride state, driver lock, pending payments
```

## Production Checks

- Server should initialize Firebase, PostgreSQL pool, HTTP routes, Socket.IO, and cron jobs exactly once.
- `.env` must provide production DB, Razorpay, Firebase, Google Maps, and app host values.
- Socket join must correctly place passenger and driver in role-specific rooms.
- Driver vehicle type must be normalized before joining `drivers:{vehicleType}`.
- Ride request should not create duplicate active rides for the same passenger.
- Driver accept must be atomic so two drivers cannot claim the same ride.
- Stale ride events must be ignored by ride id.
- Rematch must stop once a ride is accepted, cancelled, or completed.
- Waiting timer must stop on OTP verification, cancellation, completion, or passengerComing.
- OTP verification must only work for the assigned driver and active ride.
- Completion must be idempotent and should not duplicate wallet/invoice/payment rows.
- Online payment must verify Razorpay signature before backend treats it as paid.
- Cash rides must create correct platform due/commission ledger rows.
- Final fare must match invoice total and app recap.
- Toll and extra distance must not be double-counted.
- Driver wallet balance must match sum of wallet_ledger rows.
- Dues payment must settle the exact due ride rows from Razorpay order notes.
- Driver blocked/unblocked state must match overdue/unsettled dues.
- Scheduled ride dispatch should not repeatedly spam drivers after lock/accept.
- Dispute cron jobs must not double-credit partial fares.
- SOS timers must clear after completion, termination, or resolution.
- FCM invalid tokens should be removed from fcm_tokens.
- Admin exports should respect filters and not leak unrelated records.

## Common Issues To Watch

- Case-sensitive deployment failure from route path casing.
- Duplicate socket listeners after reconnect causing duplicate ride events.
- Driver shown online in memory but DB says offline after disconnect.
- Passenger stuck in SEARCHING/PENDING if cancel/rematch fails.
- Driver accept ack missing base ride data on app side.
- OTP success updates driver but passenger misses rideStarted.
- Waiting charge continues after ride starts or cancels.
- Payment verified but completeRide not emitted by app.
- completeRide emitted twice and wallet ledger duplicates.
- Invoice generated before all fare components are finalized.
- Toll approved but not included in final fare/invoice.
- Extra distance address/charge missing from rideCompleted payload.
- Cash dues settled in Razorpay but driver remains blocked.
- Scheduled ride stays locked after cancellation/completion.
- Dispute status changes but ride status remains IN_TRANSIT.
- SOS active flag remains true after ride completion.
- Old FCM token sends ride/ticket notification to previous logged-in user.

