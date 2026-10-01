# Retain inherited descriptor close in the spawning loop

Status: accepted at source; coder product observation retained; independent
acceptance and original F3 causality unverified.
Card t_94bcd252, task t_8f8d833d. Substrate Articles6/9.
Complements the diagnostic contract in ADR0002.

## Observed boundary

The substrate task evidence completion-rebuilt/completion-events.json records
child fd3 close starting at1790809067949, onexit returning with zero owned
handles at1790809067952, and that fd close callback only at1790809067970.
The parent IPC EOF arrived at1790809067953 and its own close completed at
1790809067972. The other verified cold/original-World captures show the same
zero-count gap. These are real successful program traces; they establish
pending closing work absent from the caller count, not a failed F3 sequence.
The older accepted-public capture returned owner1/caller0 but lacks native
callback order, so the cause of that lost failure remains unproved.

Source explains the count: process_wrap pairs the child's wire endpoint with
no run owner. NativeStreamDriver holds close completion against that endpoint's
owner, therefore against null. Node's onexit closes the referenced Process
handle while its IPC channel may already be unreferenced. The pending remote
close then holds no spawning loop until the parent's EOF begins its own close.
Libuv keeps a loop alive through active requests and closing handles
([uv_loop_alive](https://docs.libuv.org/en/stable/loop.html#c.uv_loop_alive)).
This binding violates that contract during the observed interval.

## Decision

For each child endpoint close initiated by process_wrap, register one closing
request against the spawning Process owner before initiating close. Release
it in the actual descriptor close callback, or on synchronous close failure.
The endpoint remains an ownerless wire during the child's lifetime; this
request represents only its closing completion. Existing ownership cleanup
releases the request on explicit parent exit/abort.

Keep onexit synchronous and keep its ordering before the eventual child close
event. Do not ref the IPC channel or child for its lifetime, change unref, add
a timer/grace interval, extend World deadlines, or alter result/attachment
policy. Native owner cancellation uses the existing descriptor callback path.
The callback's finally releases its request even if diagnostic output fails.
Node library files are unchanged; this is the native process binding.

## Qualification

The explicit source/trace discrepancy owns this bounded correction. It is
not described as the cause of the original F3 failure, and success on a later
launch cannot prove that cause. No performance floor or Acceptance follows.
Build/type checking and owner-authorized product diagnosis precede the same
independent branch reviewer; no automated tests or person walks. Disproof:
closing work still counts zero before its callback, the request survives
completion/abort, Node unref lifetime changes, or child exit/close ordering
changes. The original F3 mechanism stays open until its failure path is seen.

## Coder product observation

The normal source consumer with engine02e5af8 rebuilt and served worker
38b7c51c89b2c374; the artifact SHA256 is recorded in substrate task evidence
f3-diagnostic/CLOSING-ENGINE-IDENTITY.json. closing-verified-cold retains a
zero-storage receipt before boot, successful sign-in with splash gone, the
raw console events and exact completion sequence. Child28353 starts fd3 close
at1790813941702 (caller count2); onexit returns1790813941704 (count1);
fd close callback runs1790813941711 (count2, including parent IPC close).
Caller28351 returns1790813941812 with count0 after completion. This sees
the intended closing-work handoff without changing the unreferenced channel.
World exports precede normal app stop, consumer retirement and World down;
final status has no live PIDs, and explicit-exit teardown returns count0.

This successful diagnostic does not exercise a failed World result, identify
the older F3 cause, qualify latency, or replace independent review. Trace
selection was enabled and no quiet interval granted; no automated tests.
