# Query performance

Slow queries usually mean a missing index. Add a covering index for the hot
path, then re-check the plan with EXPLAIN before shipping.
