[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / FetchActivity

# Interface: FetchActivity

## Methods

### hold()

> **hold**(): () => `void`

One pending transport operation; the returned release is idempotent.

#### Returns

() => `void`

***

### release()

> **release**(): `void`

EOF/error/cancellation ends ownership, without cancelling completed I/O.

#### Returns

`void`
