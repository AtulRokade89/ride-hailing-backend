# Ride Flow

This document describes the normal ride lifecycle and the important production checks around it.

## Normal Ride Lifecycle

Passenger requests ride
    |
    v
Driver accepts ride
    |
    v
Ride moves to ACCEPTED
    |
    v
OTP verification completed
    |
    v
Ride moves to IN_TRANSIT
    |
    v
Ride completed
    |
    v
Ride moves to COMPLETED

Alternative outcomes:

ACCEPTED
    |
    +--> CANCELLED

ACCEPTED
    |
    +--> EXPIRED
	
## Scheduled Ride Lifecycle

SCHEDULED
    |
    v
ACCEPTED
    |
    v
EN_ROUTE_TO_PICKUP
    |
    v
ARRIVED
    |
    v
IN_TRANSIT
    |
    v
COMPLETED

Alternative outcomes:

SCHEDULED
    |
    +--> CANCELLED

ACCEPTED
    |
    +--> CANCELLED_BY_DRIVER

COMPLETED
    |
    +--> DISPUTED
	
	##Exceptional Safety Flow
ACCEPTED
↓
IN_TRANSIT
↓
Route Deviation Reported
↓
Safety Team / Safety Logic Action
↓
PARTIAL_COMPLETE

## Waiting Charge Behavior

- Free waiting period applies after driver arrival.
- After the free period, waiting amount increases at the configured production rate.
- Waiting amount is stored separately from the base fare.
- On ride completion, final fare includes waiting amount.

Expected example:

```text
Base fare:       200
Waiting amount: 10
Final fare:      210

Base fare:       200
Waiting amount: 20
Final fare:      220
```

## Cancellation Behavior

- If passenger cancels after waiting charges are applied, pending payment may be created.
- Timer must be stopped on cancellation.
- Driver and passenger should receive cancellation socket events.
- Driver active ride state should be reset where applicable.
- Ride status should move to `CANCELLED` when passenger or driver cancels.
- Driver search should stop immediately after cancellation.

## Production Checks

- A ride should not remain stuck in `PENDING`, `ACCEPTED`, `ARRIVED`, or `IN_TRANSIT`.
- Waiting timer must start only after driver arrival.
- Waiting timer must stop when OTP is verified, ride is cancelled, or ride status changes.
- Driver should not receive duplicate ride requests for the same ride.
- Driver state should reset after completion or cancellation.
- Passenger and driver should receive correct socket events for each state change.
- A ride should not remain stuck in `SEARCHING`, `PENDING`, `ACCEPTED`, `ARRIVED`, or `IN_TRANSIT`

## Common Issues To Watch

- Socket disconnect before ride status update.
- Driver app not receiving arrival/OTP events.
- Passenger app not showing updated waiting charge.
- Ride completed but wallet/invoice not created.
- Ride cancelled but timer continues running.

## Safety Intervention Flow

In rare cases, a ride may be forcefully ended due to a safety-related event.

Example:

- Route deviation reported by passenger
- Emergency intervention
- Safety team action

Flow:

IN_TRANSIT
    |
    v
Safety event triggered
    |
    v
Ride moves to PARTIAL_COMPLETE

Notes:

- PARTIAL_COMPLETE is not part of the normal ride lifecycle.
- It represents a ride that was terminated before normal completion.
- Additional investigation, settlement, or support actions may follow.