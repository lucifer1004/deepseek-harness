# Architecture

The service keeps orders in one store and exposes them over HTTP.

## Storage

All persistence goes through `OrderStore`. Handlers never open files or database connections directly.
