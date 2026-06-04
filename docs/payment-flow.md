# Payment Flow

This document explains how payment and final fare should work in production.

## Online Payment Flow

```text
Create Razorpay order
    |
    v
Passenger completes payment
    |
    v
Backend receives payment details
    |
    v
Verify Razorpay signature
    |
    v
Update ride/payment status
    |
    v
Complete ride
    |
    v
Calculate final fare
    |
    v
Create or update invoice
    |
    v
Create wallet ledger entry
    |
    v
Create payment log
```

## Cash Payment Flow

```text
Driver marks cash collected
    |
    v
Backend completes ride
    |
    v
Calculate final fare
    |
    v
Save final fare
    |
    v
Create invoice
    |
    v
Create wallet/platform due entry
    |
    v
Create payment log
```

## Final Fare Formula

Final fare should include:

- Base ride fare.
- Waiting charge.
- Extra distance charge.
- Toll charge.
- Pending penalty or collected amount, where applicable.

Expected example:

```text
Base fare:        200
Waiting charge:   20
Extra charge:      0
Toll charge:       0
Final fare:      220
```

## Wallet Behavior

- Online ride: driver wallet should receive the driver earning credit.
- Cash ride: platform due/commission entry should be created where applicable.
- Waiting, toll, and extra charges should be included in the correct driver/platform calculation.
- Duplicate callbacks should not create duplicate wallet credits.

## Production Checks

- Razorpay signature must be verified before marking online payment successful.
- `final_fare` must match invoice total.
- Invoice should include waiting, extra distance, and toll values separately.
- Wallet ledger should match final fare and payment mode rules.
- Payment logs should be written after successful completion.
- Failed payment should not complete the ride as paid.

## Common Issues To Watch

- Payment success in Razorpay but backend did not update ride.
- Duplicate payment callback creates duplicate wallet entries.
- Cash ride completed but driver/platform dues are missing.
- Final fare shown in app does not match invoice.
- Waiting amount exists in DB but is not included in final fare.
