# ADR-0001: Cache successful module paths per process

Status: Accepted

Date: 2026-09-29. Parent t_9360174c, c17 t_83018b53. Substrate Article6; engine invariant: corrected toward Node at source.

The retained Dub World host profile records0.863s inclusive resolveModule, with repeated filesystem probes. createRequire allocated a resolution cache for every module, so sibling modules repeated their common imports' searches. Node22.18.0's own loader shares successful resolutions through Module._pathCache and uses one internal stat probe: https://github.com/nodejs/node/blob/v22.18.0/lib/internal/modules/cjs/loader.js.

Share only successful ordinary filesystem resolutions between requires using the same filesystem and process module-cache identity. Keep missing names and computed host stand-ins in their existing local cache; builtins, hook interception, global stand-in paths and package imports keep their existing precedence. The positive cache retains at most8192entries and8MiB of estimated string payload, evicting oldest entries to run the ordinary resolver again. Weak identities release it with the process/filesystem. This is a loader optimization, not a cross-process or durable image identity cache.

A candidate's statSync already establishes existence and type; calling existsSync immediately before it repeats the same path traversal. Use the single stat operation with the same missing/error fallback. Package manifests, exports/imports, extension order, symlinks and module bodies keep their existing resolver.

c17 owns real-browser original-recipe observations and source delivery. c9 owns whole-load thresholds and accounting. Disproof: no reduction in module-resolution work, a miss shared across siblings, a cache shared across filesystem/process identities, a changed hook/stand-in route, or app startup/teardown failure. No automated tests or person walk are run for this card.
