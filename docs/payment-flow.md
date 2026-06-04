# Payment Flow

Online payment flow:

```text
Create Razorpay Order
    |
    v
Passenger completes payment
    |
    v
Payment success received
    |
    v
Verify payment signature
    |
    v
Update ride payment status
    |
    v
Complete ride
    |
    v
Calculate final fare
    |
    v
Create invoice
    |
    v
Create wallet ledger entry
    |
    v
Create payment log
```

Final fare inputs:

- Base ride fare.
- Waiting charge.
- Extra distance charge.
- Toll charge.
- Pending penalty or collected amount, where applicable.

Cash payment flow:

```text
Driver marks cash collected
    |
    v
Backend completes ride
    |
    v
Final fare saved
    |
    v
Driver wallet/platform dues updated
    |
    v
Invoice and payment log created
```


Failure Scenarios

Razorpay Success
↓
Verification Failed

Duplicate Callback

Payment Success
But Ride Not Completed

Important production checks:

- Razorpay signature must be verified before marking online payment successful.
- `final_fare` should include waiting, extra distance, and toll charges.
- Wallet ledger should have correct driver credit or platform due.
- Duplicate payment callbacks should not create duplicate wallet entries.
