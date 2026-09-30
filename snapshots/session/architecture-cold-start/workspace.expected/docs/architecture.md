# Architecture

A small order service.

## Storage

All persistence goes through `OrderStore` in src/store.ts. Handlers never hold orders themselves.
