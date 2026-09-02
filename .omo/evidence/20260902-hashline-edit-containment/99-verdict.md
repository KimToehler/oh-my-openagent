# Attribution verdict

**Attributed to unconstrained hashline capability. The historical incident remains unattributed.**

Scope: real isolated OpenCode , plugin built from dev , session
directory , model
. Cases 3 and 4 deliberately deferred.

## Result

| Case | Target | Named target mutated | Other tree | Permission asked |
|------|--------|---------------------|------------|------------------|
| 1 (positive control) | absolute, inside worktree | yes | main unchanged | no |
| 2 (decisive) | absolute, inside MAIN CHECKOUT | **yes** | worktree unchanged | **no** |

Case 1 passed, so the probe can route and observe edits; Case 2's conclusion is valid.

**Case 2: a session whose directory was the worktree read AND wrote a file in the
main checkout, by absolute path, with no permission prompt and no error.**
 returned  from the main checkout,  reported
, and on disk
that file became  while the worktree copy stayed
. Evidence: , .

## What this does and does not prove

It CONFIRMS the capability the static read predicted:  applies no
containment check, so any absolute path writable by the process can be read,
overwritten, or deleted from a session rooted elsewhere. The threat model in
 is real and reachable in this runtime.

It does NOT reproduce a wrong-path routing defect. The named target and the
mutated file were the same file in both cases. The tool wrote exactly where it
was told. So the original incident - where a worktree lane appeared to modify the
main checkout unintentionally - is still not mechanically attributed. The
remaining candidate is an agent supplying a stale main-checkout absolute path,
which this capability then silently honors.

## Note on a false signal

An earlier attempt saw an  permission ask on the LOGICAL
 spelling that disappeared under the PHYSICAL  path.
That is a macOS symlink artifact, not a containment control. Case 2 used the
physical spelling throughout and got no prompt at all.

## Prior attempts

Four delegated attempts recorded INCONCLUSIVE. Two root causes, both harness
wiring, both documented in :
1. Root-level  is rejected -  is 
   (). Correct shape is
    ().
2. The omo plugin was never loaded at all ( -> ). Only a
   PROJECT-level  inside the session directory registered it; a
   user-level  did not. With no plugin,
    never ran, so reads carried no anchors and the
   "missing LINE#ID" blocker was an artifact of the probe, not the runtime.
