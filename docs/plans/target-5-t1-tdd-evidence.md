# Target 5 T1 — TDD evidence

This record preserves the public-seam RED/GREEN history for the T1 contract test. The transcript
was recovered read-only from the Pi Pocket session
`/Users/philip/.pi/agent/sessions/--Users-philip-Code-pi-pocket--/2026-10-09T16-04-14-316Z_01a12168-6d6c-7716-985e-7b7b9babddd5.jsonl`.
The implementation session's test runner was `node --test test/workflow-review.test.ts`; the shell
wrappers below captured the outcomes from that runner.

## RED

Exact command recorded in the implementation history:

```sh
node --test test/workflow-review.test.ts >/tmp/pi-pocket-review-binding-red.log 2>&1; rc=$?; echo "RED command exit=$rc"; grep -E '^(✔|✖|not ok|# tests|# pass|# fail|# cancelled|# skipped|# todo)' /tmp/pi-pocket-review-binding-red.log | tail -n 20; sed -n '/same-turn verification outcome changes/,+12p' /tmp/pi-pocket-review-binding-red.log; exit 0
```

Exact captured output:

```text
RED command exit=1
✔ review request binding has a stable collision-safe operation identity (2.001875ms)
✔ review request binding rejects verification that did not pass (0.39225ms)
✔ an approved review result is bound to its exact request (0.366042ms)
✔ review decision validation enforces the exact verdict algebra (0.358ms)
✔ same-turn input changes raise a non-retryable review conflict (0.235083ms)
✖ same-turn verification outcome changes conflict even when its request identity is reused (0.588125ms)
✔ a result from an earlier turn cannot satisfy a later review pass (0.398667ms)
✔ review bindings reject malformed or revision-mismatched verification evidence (0.21625ms)
✔ review requests reject extra fields, aliased roles, and over-bound scope (0.14825ms)
✔ operation encoding distinguishes IDs that collide under separator joining (0.1925ms)
✖ failing tests:
✖ same-turn verification outcome changes conflict even when its request identity is reused (0.588125ms)
✖ same-turn verification outcome changes conflict even when its request identity is reused (0.588125ms)
✔ a result from an earlier turn cannot satisfy a later review pass (0.398667ms)
✔ review bindings reject malformed or revision-mismatched verification evidence (0.21625ms)
✔ review requests reject extra fields, aliased roles, and over-bound scope (0.14825ms)
✔ operation encoding distinguishes IDs that collide under separator joining (0.1925ms)
ℹ tests 10
ℹ suites 0
ℹ pass 9
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 102.273416
✖ same-turn verification outcome changes conflict even when its request identity is reused (0.588125ms)
  AssertionError [ERR_ASSERTION]: Expected "actual" to be strictly unequal to:

  '01e5948544e483ee9a9c122d0f188491bf402e49944880387b64acc5da1c634b'
      at TestContext.<anonymous> (file:///Users/philip/Code/pi-pocket/test/workflow-review.test.ts:207:12)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1382:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:960:18)
      at Test.postRun (node:internal/test_runner/test:1522:19)
      at Test.run (node:internal/test_runner/test:1447:12)
      at async Test.processPendingSubtests (node:internal/test_runner/test:960:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
```

The failure was an assertion in the intended same-turn verification-outcome binding test—not a
syntax, import, or test-discovery failure. Nine other public-seam tests ran and passed.

## Intermediate GREEN attempt

An intermediate implementation attempt was still red because the exact-result binding assertion also
needed adjustment. This failed attempt is retained for transparency.

```sh
node --test test/workflow-review.test.ts >/tmp/pi-pocket-review-binding-green.log 2>&1; rc=$?; echo "GREEN command exit=$rc"; grep -E '^(✔|✖|not ok|# tests|# pass|# fail|# cancelled|# skipped|# todo)' /tmp/pi-pocket-review-binding-green.log | tail -n 20; exit "$rc"
```

```text
GREEN command exit=1
✔ review request binding has a stable collision-safe operation identity (1.656ms)
✔ review request binding rejects verification that did not pass (0.242333ms)
✖ an approved review result is bound to its exact request (0.914584ms)
✔ review decision validation enforces the exact verdict algebra (0.375166ms)
✔ same-turn input changes raise a non-retryable review conflict (0.29275ms)
✔ same-turn verification outcome changes conflict even when its request identity is reused (0.446042ms)
✔ a result from an earlier turn cannot satisfy a later review pass (0.483583ms)
✔ review bindings reject malformed or revision-mismatched verification evidence (0.262417ms)
✔ review requests reject extra fields, aliased roles, and over-bound scope (0.198ms)
✔ operation encoding distinguishes IDs that collide under separator joining (0.210458ms)
✖ failing tests:
✖ an approved review result is bound to its exact request (0.914584ms)
```

## GREEN

Exact passing command recorded later in the same implementation history:

```sh
node --test test/workflow-review.test.ts >/tmp/pi-pocket-review-binding-green-final.log 2>&1; rc=$?; echo "GREEN command exit=$rc"; grep -E '^(✔|✖|not ok|# tests|# pass|# fail|# cancelled|# skipped|# todo)' /tmp/pi-pocket-review-binding-green-final.log | tail -n 20; exit "$rc"
```

Exact captured output:

```text
GREEN command exit=0
✔ review request binding has a stable collision-safe operation identity (1.518ms)
✔ review request binding rejects verification that did not pass (0.231584ms)
✔ an approved review result is bound to its exact request (0.311833ms)
✔ review decision validation enforces the exact verdict algebra (0.335791ms)
✔ same-turn input changes raise a non-retryable review conflict (0.267709ms)
✔ same-turn verification outcome changes conflict even when its request identity is reused (0.258292ms)
✔ a result from an earlier turn cannot satisfy a later review pass (0.4055ms)
✔ review bindings reject malformed or revision-mismatched verification evidence (0.229208ms)
✔ review requests reject extra fields, aliased roles, and over-bound scope (0.151167ms)
✔ operation encoding distinguishes IDs that collide under separator joining (0.176875ms)
```

The passing run exited zero and reported all ten public-seam tests as passing.
