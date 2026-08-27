# Flutter App Flow

This document describes the current Flutter app lifecycle and the important production checks around it.

Source app:

```text
D:\rideapp\lib
D:\rideapp\pubspec.yaml
```

Related backend docs folder:

```text
D:\ride-hailing-project\ride-hailing-backend\docs
```

## App Startup Flow

```text
App launched
    |
    v
Firebase initialized
    |
    v
FCM background / foreground listeners registered
    |
    v
Local notification channels created
    |
    v
SplashRouter loads stored session
    |
    v
If passenger token exists -> MapScreen
    |
    v
If no valid passenger session -> LoginScreen
```

Notes:

- Passenger session is read from secure storage.
- Passenger auto-login is allowed when token, userId, and role are present.
- Driver auto-login is intentionally disabled; driver is forced to login again.
- FCM channels used by the app are `ride_requests`, `ride_updates`, and `admin_notifications`.
- Ticket notification data can set pending ticket navigation state.

## Login Flow

```text
User enters email/password
    |
    v
POST /api/auth/login
    |
    v
Read role, userId, token
    |
    +--> passenger
    |       |
    |       v
    |   Save passenger secure storage
    |       |
    |       v
    |   Save FCM token to backend
    |       |
    |       v
    |   Subscribe passenger topic
    |       |
    |       v
    |   Open MapScreen
    |
    +--> driver
            |
            v
        Save driver secure storage
            |
            v
        Save FCM token to backend
            |
            v
        Subscribe driver topic
            |
            v
        Check driver verification status
            |
            +--> active -> DriverHomeScreen
            +--> pending_verification -> show pending message
            +--> rejected -> DriverVerificationScreen
            +--> none -> DriverVerificationScreen
```

Blocked driver due flow:

```text
Login returns 403 blocked_due_to_dues
    |
    v
Show account blocked popup
    |
    v
Driver can copy UPI ID or open PayDuesScreen
```

## Registration Flow

```text
User fills registration form
    |
    v
App captures deviceId when possible
    |
    v
POST /api/auth/register
    |
    +--> passenger
    |       |
    |       v
    |   Show success message
    |       |
    |       v
    |   Return to LoginScreen
    |
    +--> driver
            |
            v
        Read token and userId
            |
            v
        Open DriverVerificationScreen
```

Passenger registration supports optional referral code.

## Passenger Normal Ride Flow

```text
Passenger opens MapScreen
    |
    v
App connects socket and joins passenger room
    |
    v
Passenger selects pickup, destination, vehicle
    |
    v
App calculates quote/fare and generates OTP
    |
    v
App emits requestRide
    |
    v
RideStatus moves to pendingRequest
    |
    v
Driver accepts ride
    |
    v
Passenger receives rideAccepted
    |
    v
RideStatus moves to driverFound
    |
    v
Passenger sees driver details, live location, OTP
    |
    v
Driver reaches pickup
    |
    v
Passenger status can move to arrived
    |
    v
Driver verifies OTP
    |
    v
Passenger receives otpVerified / otpVerifiedPassenger / rideStarted
    |
    v
RideStatus moves to inProgress
    |
    v
Driver completes ride
    |
    v
Passenger receives rideCompleted
    |
    v
Passenger rates driver
    |
    v
Ride state resets
```

Important passenger socket events:

- `requestRide` emitted when passenger requests a ride.
- `rideAccepted` received when driver accepts.
- `ride-status-update` received for driver en-route status.
- `driverLocation` received for live driver marker and ETA.
- `otpVerified`, `otpVerifiedPassenger`, or `rideStarted` received when trip starts.
- `rideCompleted` received when backend completes final fare.
- `cancelRideSearch`, `cancelRide`, and `rideCancelledByPassenger` emitted during passenger cancellation.

## Driver Online Flow

```text
Driver opens DriverHomeScreen
    |
    v
Driver turns Online ON
    |
    v
App verifies GPS/current location
    |
    v
Socket connects as driver
    |
    v
Driver joins socket with userId, role, vehicleType, latitude, longitude
    |
    v
App emits driver-check-active-ride
    |
    v
Driver location stream starts
    |
    v
Periodic driverLocationUpdate starts
    |
    v
Driver can receive ride requests
```

Offline behavior:

- Driver cannot go offline while payment is in progress.
- Driver cannot go offline during an active ride.
- On safe offline, socket disconnects, location streams stop, incoming requests clear, and ride state resets to idle.

## Driver Normal Ride Flow

```text
Driver is online
    |
    v
Driver receives newRideRequest
    |
    v
If no active ride -> show incoming ride dialog
    |
    v
Driver accepts within countdown
    |
    v
App emits driverAccept
    |
    v
RideStatus moves to pending
    |
    v
DriverAcceptedAck confirms pickup/passenger data
    |
    v
App shows route to pickup
    |
    v
Driver taps Arrived
    |
    v
App checks proximity to pickup
    |
    v
Driver enters passenger OTP
    |
    v
Backend verifies OTP
    |
    v
Driver receives otpVerified
    |
    v
App emits startRide
    |
    v
RideStatus moves to in_progress
    |
    v
Driver completes Cash or Online
    |
    v
Backend emits rideCompleted
    |
    v
Driver sees final recap and rates passenger
    |
    v
State resets or queued ride becomes active
```

Back-to-back ride behavior:

```text
newRideRequest received while driver has active ride
    |
    v
App stores one queued ride
    |
    v
Current ride completes
    |
    v
Queued ride becomes active pickup ride
```

Important driver socket events:

- `newRideRequest` received for incoming rides.
- `driverAccept` emitted when driver accepts.
- `driverAcceptedAck` received after backend confirms acceptance.
- `driverLocationUpdate` emitted during online/active state.
- `otpVerified` received after OTP verification.
- `startRide` emitted after OTP success.
- `completeRide` emitted after cash confirmation or online payment verification.
- `rideCompleted` received for final recap and cleanup.
- `rideCancelledByPassenger`, `dismissRideRequest`, and `rideAlreadyAccepted` handle cancellation/stale request cases.

## Scheduled Ride Flow

```text
Driver receives new-scheduled-ride-request
    |
    v
Driver accepts scheduled ride
    |
    v
App locks driver for upcoming scheduled ride
    |
    v
Driver starts driving to pickup
    |
    v
App emits start-driving-to-scheduled-pickup
    |
    v
Driver arrives for scheduled ride
    |
    v
App emits driver-arrived-for-scheduled-ride
    |
    v
Passenger/driver OTP flow starts
    |
    v
Driver emits verify-scheduled-otp
    |
    v
Ride continues as active ride
```

Notes:

- Scheduled ride ids are treated separately when they start with `sched_`.
- Passenger MapScreen ignores scheduled-specific rideAccepted events in normal ride handlers.
- Driver can be locked for an upcoming scheduled ride so new instant requests are paused.

## Payment Flow In App

### Online Payment

```text
Driver taps Complete Online
    |
    v
App calculates estimated fare + waiting + extra distance + approved toll
    |
    v
App shows total fare popup
    |
    v
Driver chooses Razorpay or UPI QR
    |
    +--> Razorpay
    |       |
    |       v
    |   POST /api/payment/create-order
    |       |
    |       v
    |   Open Razorpay checkout
    |       |
    |       v
    |   Payment success callback
    |       |
    |       v
    |   POST /api/payment/verify
    |       |
    |       v
    |   Emit completeRide paidByCash=false
    |
    +--> UPI QR
            |
            v
        POST /api/payment/create-upi-order
            |
            v
        Show QR
            |
            v
        Poll /api/payment/status
            |
            v
        Emit completeRide paidByCash=false
```

Online payment protections:

- Duplicate Razorpay success callbacks are guarded by `_isPaymentProcessing`.
- Stale/ghost callbacks are ignored when order id does not match the active ride order.
- Payment completion is ignored if ride is not marked as awaiting online payment.
- Driver cannot go offline while payment is in progress.

### Cash Payment

```text
Driver taps Complete Cash
    |
    v
App asks if full cash was received
    |
    +--> Yes
    |       |
    |       v
    |   Emit completeRide paidByCash=true
    |
    +--> No / Issue
            |
            v
        Driver can switch to online collection
```

## Waiting Charge Flow

```text
Driver arrives / backend starts waiting logic
    |
    v
Passenger receives waitingWarning
    |
    v
Passenger sees free waiting countdown
    |
    v
Passenger can tap OK, I'M COMING
    |
    v
App emits passengerComing
    |
    v
If free time expires, waitingStarted is received
    |
    v
waitingUpdate increases minutes and charge
    |
    v
waitingStopped resets waiting state
```

Notes:

- Passenger sees warning and charge dialogs.
- Driver also tracks waiting values, but passenger-only dialogs are hidden on driver side.
- Final fare UI includes current waiting charge.

## Toll Flow

```text
Driver taps Add toll charge
    |
    v
Driver enters amount
    |
    v
POST /api/toll/add
    |
    v
Toll state moves to PENDING
    |
    v
Passenger receives tollChargeRequest
    |
    v
Passenger approves or rejects
    |
    +--> approved
    |       |
    |       v
    |   Driver receives tollApprovedByPassenger
    |       |
    |       v
    |   Passenger receives fareUpdatedWithToll
    |       |
    |       v
    |   Toll is included in final fare display
    |
    +--> rejected
            |
            v
        Driver receives tollRejectedByPassenger
```

## Extra Distance Flow

```text
Driver moves beyond planned drop logic
    |
    v
App/backend tracks extra_distance_update
    |
    v
Driver can request extra distance approval
    |
    v
Passenger receives extra_distance_approval_request
    |
    v
Passenger approves or rejects
    |
    v
extra_distance_update updates extra charge and actual drop address
```

Final fare display can include:

- Base estimated fare.
- Waiting charge.
- Extra distance charge.
- Approved toll charge.
- Previous pending waiting/penalty amount where applicable.

## Dispute And Safety Flow

```text
Ride is in progress
    |
    v
Passenger or driver opens DisputeScreen
    |
    v
App calls dispute raise API
    |
    v
Socket event rideDisputeRaised can notify other side
    |
    v
User accepts partial fare or disagrees
    |
    v
App calls dispute respond API
    |
    v
Resolution can be AUTO_RESOLVED, WAITING_FOR_OTHER_PARTY, or PENDING_ADMIN_REVIEW
    |
    v
Ride state closes or waits for admin/review
```

Safety route-deviation behavior:

```text
Route deviation detected
    |
    v
Passenger may receive ride_safety_warning
    |
    v
Driver may receive soft_route_deviation / route_warning_final
    |
    v
Driver can send route explanation
    |
    v
Severe case can emit ride_terminated
```

Driver SOS:

```text
Driver triggers SOS during active ride
    |
    v
App emits sos_triggered
    |
    v
Support/admin side should monitor ride
```

## Ticket Support Flow

```text
User opens eligible rides
    |
    v
GET /api/tickets/eligible-rides
    |
    v
User creates ticket for ride
    |
    v
POST /api/tickets/create
    |
    v
Ticket chat screen loads details/messages
    |
    v
User sends message
    |
    v
POST /api/tickets/{ticketId}/message
    |
    v
Ticket can be closed or reopened
```

Ticket notifications:

- `TICKET_REPLY` stores pending ticket id and role.
- `TICKET_CLOSED` clears pending ticket state.

## Driver Dues And Earnings Flow

```text
Driver logs in or goes online
    |
    v
App checks upcoming/pending dues
    |
    v
If dues exist -> reminder or blocked popup
    |
    v
Driver can open PayDuesScreen / PendingDuesScreen
    |
    v
Driver can open earnings summary
```

Cash dues behavior:

- Blocked driver login can open PayDuesScreen.
- Online driver home fetches pending dues count and total.
- Cash ride completion can create platform dues depending on backend rules.
- Driver wallet/earnings screens show online/offline summary and settlements.

## Logout Flow

```text
User logs out
    |
    v
App finds passenger or driver userId from secure storage
    |
    v
POST /api/user/logout
    |
    v
Backend clears FCM token
    |
    v
Socket disconnects
    |
    v
Secure storage deleteAll
    |
    v
User returns to login flow
```

The local logout must continue even if backend logout/FCM cleanup fails.

## Production Checks

- Passenger should not send duplicate `requestRide` events from double tap.
- Passenger pending request should reset if no driver is found within timeout.
- Passenger should ignore stale ride events for a different ride id.
- Driver should not receive or accept new instant rides while locked for scheduled ride.
- Driver should not go offline during active ride or online payment verification.
- `driverAcceptedAck` should match the pending/queued ride before local state is updated.
- OTP success should move both apps to in-progress state exactly once.
- `rideCompleted` should be idempotent on driver app using last completed ride id.
- Waiting charges should reset after completion/cancellation but should remain visible until final fare is shown.
- Toll should not be double-counted; approved toll should be tracked separately in UI and final fare.
- Razorpay ghost/stale callbacks should not complete old rides.
- Cash completion should require driver confirmation before `completeRide` is emitted.
- Socket handlers should be removed or guarded on dispose to avoid duplicate event handling.
- FCM token should be saved after login and cleared on logout.

## Common Issues To Watch

- Passenger app stuck in `pendingRequest` after backend expires or cancels search.
- Driver accepts a ride, but `driverAcceptedAck` arrives after local pending ride was cleared.
- Duplicate `driverLocation` handlers causing duplicate ETA/marker updates.
- OTP verified on backend but passenger app does not receive `rideStarted` or `otpVerifiedPassenger`.
- Online payment succeeds but verification fails or stale callback is ignored.
- Driver goes offline/restarts during payment and loses active ride context.
- Waiting charge shown in UI but missing from final backend fare.
- Toll approved in app but final invoice does not include toll.
- Extra distance approved but actual drop address is not reflected in final recap.
- Scheduled ride events leaking into normal ride UI.
- Dispute opened but completion buttons remain active.
- Logout fails to clear old FCM token, causing notifications for previous user.

