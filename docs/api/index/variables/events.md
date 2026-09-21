[**@volter/tabnode**](../../README.md)

***

[@volter/tabnode](../../README.md) / [index](../README.md) / events

# Variable: events

> `const` **events**: `EventsModule`

The module, which in Node IS the class: `events.js` ends with
`module.exports = EventEmitter` and hangs `once`, `on`, `getEventListeners`
and the rest off it, so `require("events") === require("events")
.EventEmitter` and `new (require("events"))()` is an emitter. One object
here too, for the same reason -- a guest that constructs the module got
"not a constructor" when this was a separate object standing beside it.
