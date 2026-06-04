# Ride Flow

Basic ride lifecycle:

```text
Passenger requests ride
    |
    v
Backend creates ride
    |
    v
Socket event sends ride request to drivers
    |
    v
Driver receives request
    |
    v
Driver accepts
    |
    v
Driver arrives
    |
    v
Waiting timer starts if passenger has not started ride
    |
    v
OTP verified
    |
    v
Ride starts
    |
    v
Ride completes
    |
    v
Final fare calculated
    |
    v
Payment handled
    |
    v
Wallet and invoice entries created
```



Important production checks:

- Ride should not stay stuck in 'PENDING','SEARCHING','ACCEPTED','ARRIVED','IN_TRANSIT','COMPLETED','CANCELLED'.
- Waiting timer should stop when OTP is verified or ride is cancelled.
- Driver state should reset after ride completion or cancellation.
- Passenger and driver should receive correct socket events during every state change.
