# Review

Independent review of the artifacts against the code, by an agent of another model family than the author, read-only, one round. Verdict of the round: not ready, seven blocking findings. All are applied; by the owner's instruction there is no second round, and the verdict line is the author's check of each fix.

1. The job condition made the manual-run scenario unreachable. Fix: the job runs for a tag and for a manual run, only the publish step is gated; the event name is a plan input (D1, D2, tasks 1.1 and 3.2).
2. The release workflow has no registry client pin, and the client bundled with Node is too old for trusted publishing. Fix: the job installs the client at the version `ci.yml` pins and requires Node 22.14.0 or later (D2, task 3.2).
3. The version comparison ran after packing, against the spec. Fix: the plan has two stages and the first runs before any pack step (D2, tasks 1.1 and 3.2).
4. The smoke environment was under-specified and would have installed into the real profile on Windows. Fix: it reuses the environment construction of the tarball acceptance (D3, task 4.1).
5. A new registry binding expires without a successful publish within two days. Fix: the binding is created immediately before the first release that publishes from CI (D4).
6. The real tarball was not size-checked. Fix: the tarball command form checks sizes too (D2, task 2.1).
7. A step output cannot gate another job. Fix: job outputs and the smoke job's condition are stated (D2, D3, task 3.2).

Ready for implementation: yes
